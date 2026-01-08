import type { ServerWebSocket } from "bun";
import { db, getDefaultChatModel } from "../db";
import { Conversation, User } from "../db/schema";
import { eq } from "drizzle-orm";
import { getDefaultUser } from "../utils";
import { atifConversationService } from "../processor/conversation/atif/atif.service";
import {
    runResearchWithConversation,
    ResearchPausedError,
} from "../processor/research-runner";
import {
    type ConfirmationRequest,
    type ConfirmationResponse,
    type ConfirmationPreferences,
    type ConfirmationContext,
    type ConfirmationCallback,
    createEmptyPreferences,
} from "../processor/confirmation";
import {
    setSessionActive,
    updateSessionReasoning,
    setSessionPaused,
    setSessionInactive,
} from "../sessions";
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'ws' });

export type WebSocketData = {
    conversationId?: string;
};

// Pending confirmation with resolve/reject handlers
type PendingConfirmation = {
    requestId: string;
    resolve: (response: ConfirmationResponse) => void;
    reject: (error: Error) => void;
};

// Session state for tracking active research per conversation
type ResearchSession = {
    isPaused: boolean;
    abortController: AbortController;
    conversationId: string;
    user: typeof User.$inferSelect;
    // User message for initial research
    userMessage?: string;
    // Confirmation support
    confirmationPreferences: ConfirmationPreferences;
    // Map of pending confirmations keyed by requestId (supports parallel tool calls)
    pendingConfirmations: Map<string, PendingConfirmation>;
};

// Map WebSocket connections to their active research sessions (multiple per connection)
type ConnectionSessions = Map<string, ResearchSession>; // Map<conversationId, ResearchSession>
const activeConnections = new WeakMap<ServerWebSocket<WebSocketData>, ConnectionSessions>();

// Message types from client - now with conversationId for routing
type ClientMessage =
    | { type: 'message'; message: string; conversationId?: string }
    | { type: 'pause'; conversationId: string }
    | { type: 'resume'; message?: string; conversationId: string }
    | { type: 'confirmation_response'; data: ConfirmationResponse; conversationId: string };

/**
 * Helper to send a message to the client with conversationId for routing
 */
function sendToClient(
    ws: ServerWebSocket<WebSocketData>,
    message: Record<string, unknown>,
    conversationId: string
): void {
    ws.send(JSON.stringify({ ...message, conversationId }));
}

/**
 * Get or create the sessions map for a WebSocket connection
 */
function getConnectionSessions(ws: ServerWebSocket<WebSocketData>): ConnectionSessions {
    let sessions = activeConnections.get(ws);
    if (!sessions) {
        sessions = new Map();
        activeConnections.set(ws, sessions);
    }
    return sessions;
}

/**
 * Create a confirmation callback for a WebSocket session.
 * This sends confirmation requests to the client and waits for responses.
 */
function createConfirmationCallback(
    ws: ServerWebSocket<WebSocketData>,
    session: ResearchSession
): ConfirmationCallback {
    return async (request: ConfirmationRequest): Promise<ConfirmationResponse> => {
        return new Promise((resolve, reject) => {
            // Store the pending confirmation in the map (supports parallel tool calls)
            session.pendingConfirmations.set(request.requestId, {
                requestId: request.requestId,
                resolve,
                reject,
            });

            // Send confirmation request to client with conversationId
            log.info(`🔐 Requesting confirmation: ${request.title} (conv: ${session.conversationId}, pending: ${session.pendingConfirmations.size})`);
            sendToClient(ws, {
                type: 'confirmation_request',
                data: request,
            }, session.conversationId);

            // Note: The response will be handled in the message handler
            // which will call the appropriate pending confirmation's resolve()
        });
    };
}

/**
 * Create a confirmation context for the research session
 */
function createConfirmationContext(
    ws: ServerWebSocket<WebSocketData>,
    session: ResearchSession
): ConfirmationContext {
    return {
        requestConfirmation: createConfirmationCallback(ws, session),
        preferences: session.confirmationPreferences,
    };
}

/**
 * Run the research loop for a conversation.
 * On resume, history is reloaded from DB which includes all previous tool calls/results.
 */
async function runResearch(
    ws: ServerWebSocket<WebSocketData>,
    session: ResearchSession
): Promise<void> {
    const { user, conversationId, userMessage } = session;

    // Mark session as active in shared store
    setSessionActive(conversationId);

    // Signal that research is starting/resuming
    sendToClient(ws, { type: 'research' }, conversationId);

    log.info(`🔬 Starting research (conv: ${conversationId})...`);

    // Create confirmation context for this research session
    const confirmationContext = createConfirmationContext(ws, session);

    try {
        // Use the shared research runner with streaming callbacks
        const runner = runResearchWithConversation({
            conversationId,
            user,
            userMessage,
            abortSignal: session.abortController.signal,
            confirmationContext,
            onToolCallStart: (iteration) => {
                // Send tool call start to client before execution
                sendToClient(ws, {
                    type: 'tool_call_start',
                    data: {
                        thought: iteration.thought,
                        message: iteration.message,
                        toolCalls: iteration.toolCalls,
                    }
                }, conversationId);
            },
            onIteration: (iteration) => {
                // Send iteration update to client with results
                sendToClient(ws, { type: 'iteration', data: iteration }, conversationId);
            },
            onReasoning: (thought) => {
                // Update shared store with latest reasoning
                updateSessionReasoning(conversationId, thought);
            },
        });

        // Consume all iterations (callbacks handle the streaming)
        // Use manual iteration to properly capture the return value
        let iteratorResult = await runner.next();
        while (!iteratorResult.done) {
            const iteration = iteratorResult.value;
            // Log tool calls
            for (const tc of iteration.toolCalls) {
                log.info({ tool: tc.function_name, args: tc.arguments ? JSON.stringify(tc.arguments).slice(0, 100) : '' }, 'Tool call');
            }
            if (iteration.toolCalls.length > 1) {
                log.info(`⚡ Executing ${iteration.toolCalls.length} tools in parallel`);
            }
            if (iteration.warning) {
                log.warn(`⚠️ Warning: ${iteration.warning}`);
            }
            iteratorResult = await runner.next();
        }

        // When done, the value is the final result
        const result = iteratorResult.value;

        log.info(`✅ Research complete (conv: ${conversationId})`);
        log.info(`Iterations: ${result.iterationCount}`);
        log.info(`Response length: ${result.response.length} chars`);
        log.info(`${'='.repeat(60)}\n`);

        sendToClient(ws, {
            type: 'complete',
            data: {
                response: result.response,
                conversationId
            }
        }, conversationId);

    } catch (error) {
        if (error instanceof ResearchPausedError) {
            // State is already saved to DB via addStep calls
            log.info(`⏸️ Research paused (conv: ${conversationId})`);
            setSessionPaused(conversationId);
            return;
        }
        log.error({ err: error }, 'Research error');
        sendToClient(ws, { type: 'error', error: error instanceof Error ? error.message : String(error) }, conversationId);

        // Clean up session
        const sessions = getConnectionSessions(ws);
        sessions.delete(conversationId);
        setSessionInactive(conversationId);
        return;
    }

    // Clean up session
    const sessions = getConnectionSessions(ws);
    sessions.delete(conversationId);
    setSessionInactive(conversationId);
}

export const websocketHandler = {
    async message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
        if (typeof message !== "string") return;

        let data: ClientMessage;
        try {
            const parsed = JSON.parse(message);
            // Handle legacy format (just message + conversationId)
            if (parsed.message !== undefined && parsed.type === undefined) {
                data = { type: 'message', message: parsed.message, conversationId: parsed.conversationId };
            } else {
                data = parsed;
            }
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
            return;
        }

        const sessions = getConnectionSessions(ws);

        // Handle pause command
        if (data.type === 'pause') {
            const session = sessions.get(data.conversationId);
            if (session && !session.isPaused) {
                log.info(`⏸️ Pausing research (conv: ${data.conversationId})`);
                session.isPaused = true;
                session.abortController.abort();
                // Reject all pending confirmations so the research loop can exit cleanly
                for (const [requestId, pending] of session.pendingConfirmations) {
                    pending.reject(new Error('Research paused'));
                }
                session.pendingConfirmations.clear();
                sendToClient(ws, { type: 'pause' }, data.conversationId);
                setSessionPaused(data.conversationId);
            }
            return;
        }

        // Handle resume command
        if (data.type === 'resume') {
            const session = sessions.get(data.conversationId);
            if (session && session.isPaused) {
                log.info(`▶️ Resuming research${data.message ? ' with new message' : ''} (conv: ${data.conversationId})`);

                // If user provided a message, add it to the conversation
                if (data.message) {
                    await atifConversationService.addStep(session.conversationId, 'user', data.message);
                }

                session.isPaused = false;
                // Create new abort controller for resumed session
                session.abortController = new AbortController();

                // Run research - it will reload history from DB
                await runResearch(ws, session);
            }
            return;
        }

        // Handle confirmation response
        if (data.type === 'confirmation_response') {
            const session = sessions.get(data.conversationId);
            const response = data.data;
            const pending = session?.pendingConfirmations.get(response.requestId);

            if (pending) {
                log.info(`🔐 Confirmation response received: ${response.selectedOptionId} (conv: ${data.conversationId}, remaining: ${session!.pendingConfirmations.size - 1})`);
                session!.pendingConfirmations.delete(response.requestId);
                pending.resolve(response);
            } else {
                log.warn(`⚠️ Received confirmation response for unknown requestId: ${response.requestId} (conv: ${data.conversationId})`);
            }
            return;
        }

        // Handle new message
        const { message: userQuery, conversationId } = data as { type: 'message'; message: string; conversationId?: string };
        log.info(`\n${'='.repeat(60)}`);
        log.info(`💬 New message received`);
        log.info(`Query: "${userQuery.slice(0, 100)}${userQuery.length > 100 ? '...' : ''}"`);
        log.info(`Conversation: ${conversationId || 'new'}`);

        // Check if there's already an active session for this conversation
        if (conversationId && sessions.has(conversationId)) {
            log.warn(`⚠️ Already processing conversation: ${conversationId}`);
            sendToClient(ws, {
                type: 'error',
                error: 'A task is already running for this conversation. Please wait or pause it first.'
            }, conversationId);
            return;
        }

        // Get the user
        const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
        if (!user) {
            log.error(`❌ User not found: ${getDefaultUser().email}`);
            ws.send(JSON.stringify({ type: 'error', error: 'User not found' }));
            return;
        }
        log.info(`User: ${user.email} (id: ${user.id})`);

        // Get the user's selected model
        const chatModelWithApi = await getDefaultChatModel(user);
        if (chatModelWithApi) {
            log.info(`🤖 Model: ${chatModelWithApi.chatModel.name} (${chatModelWithApi.chatModel.modelType})`);
            log.info(`Provider: ${chatModelWithApi.aiModelApi?.name || 'Unknown'}`);
        } else {
            log.warn(`⚠️ No chat model configured`);
        }

        // Get or create conversation BEFORE starting research
        let conversation;
        if (conversationId) {
            const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
            conversation = results[0];
        } else {
            // Create new conversation at the start
            const modelName = chatModelWithApi?.chatModel.name || 'unknown';
            conversation = await atifConversationService.createConversation(
                user,
                'pipali-agent',
                '1.0.0',
                modelName
            );
        }

        // Ensure conversation was created
        if (!conversation) {
            ws.send(JSON.stringify({ type: 'error', error: 'Failed to create or find conversation' }));
            return;
        }

        // Send conversationId to client immediately (so client tracks it even if paused before completion)
        if (!conversationId) {
            sendToClient(ws, { type: 'conversation_created' }, conversation.id);
        }

        // Create session for this research
        const session: ResearchSession = {
            isPaused: false,
            abortController: new AbortController(),
            conversationId: conversation.id,
            user,
            userMessage: userQuery,
            confirmationPreferences: createEmptyPreferences(),
            pendingConfirmations: new Map(),
        };
        sessions.set(conversation.id, session);

        // Run research (don't await - allow other messages to be processed)
        runResearch(ws, session).catch(error => {
            log.error({ err: error }, 'Unhandled research error');
            sessions.delete(conversation.id);
            setSessionInactive(conversation.id);
        });
    },
    open(_ws: ServerWebSocket<WebSocketData>) {
        log.info("🔌 Client connected");
        // Reset mock state for test isolation (no-op in production)
        globalThis.__pipaliMockReset?.();
    },
    close(ws: ServerWebSocket<WebSocketData>) {
        log.info("🔌 Client disconnected");
        // Clean up all sessions on disconnect
        const sessions = activeConnections.get(ws);
        if (sessions) {
            for (const [conversationId, session] of sessions) {
                log.info(`🧹 Cleaning up session for conversation: ${conversationId}`);
                session.abortController.abort();
                setSessionInactive(conversationId);
            }
            activeConnections.delete(ws);
        }
    }
};
