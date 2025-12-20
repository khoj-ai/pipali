import type { ServerWebSocket } from "bun";
import { research, ResearchPausedError } from "../processor/director";
import { db, getDefaultChatModel } from "../db";
import { Conversation, User } from "../db/schema";
import { eq } from "drizzle-orm";
import { getDefaultUser, maxIterations } from "../utils";
import { atifConversationService } from "../processor/conversation/atif/atif.service";
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

export type WebSocketData = {
    conversationId?: string;
};

// Session state for tracking active research per conversation
type ResearchSession = {
    isPaused: boolean;
    abortController: AbortController;
    conversationId: string;
    user: typeof User.$inferSelect;
    // Confirmation support
    confirmationPreferences: ConfirmationPreferences;
    pendingConfirmation?: {
        requestId: string;
        resolve: (response: ConfirmationResponse) => void;
        reject: (error: Error) => void;
    };
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
            // Store the pending confirmation
            session.pendingConfirmation = {
                requestId: request.requestId,
                resolve,
                reject,
            };

            // Send confirmation request to client with conversationId
            console.log(`[WS] 🔐 Requesting confirmation: ${request.title} (conv: ${session.conversationId})`);
            sendToClient(ws, {
                type: 'confirmation_request',
                data: request,
            }, session.conversationId);

            // Note: The response will be handled in the message handler
            // which will call session.pendingConfirmation.resolve()
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
    const { user, conversationId } = session;

    // Mark session as active in shared store
    setSessionActive(conversationId);

    // Signal that research is starting/resuming
    sendToClient(ws, { type: 'research' }, conversationId);

    // Get conversation and its current history from DB
    const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
    const conversation = results[0];

    if (!conversation) {
        sendToClient(ws, { type: 'error', error: 'Conversation not found' }, conversationId);
        setSessionInactive(conversationId);
        return;
    }

    // Find the last user message to use as the query
    const trajectory = conversation.trajectory;
    const lastUserMessage = [...trajectory.steps].reverse().find(m => m.source === 'user' && typeof m.message === 'string');
    if (!lastUserMessage || typeof lastUserMessage.message !== 'string') {
        sendToClient(ws, { type: 'error', error: 'No user message found' }, conversationId);
        setSessionInactive(conversationId);
        return;
    }
    const userQuery = lastUserMessage.message;

    // Chat history is everything except the last user message (which becomes the query)
    console.log(`[WS] 🔬 Starting research (conv: ${conversationId})...`);
    console.log(`[WS] Query: "${userQuery.slice(0, 100)}${userQuery.length > 100 ? '...' : ''}"`);
    console.log(`[WS] History messages: ${trajectory.steps.length}`);

    let finalResponse = '';
    let finalThought: string | undefined;
    let iterationCount = 0;

    // Create confirmation context for this research session
    const confirmationContext = createConfirmationContext(ws, session);

    try {
        for await (const iteration of research({
            chatHistory: trajectory,
            maxIterations: maxIterations,
            currentDate: new Date().toISOString().split('T')[0],
            dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
            user: user,
            abortSignal: session.abortController.signal,
            confirmationContext: confirmationContext,
        })) {
            iterationCount++;

            // Update shared store with latest reasoning
            if (iteration.thought) {
                updateSessionReasoning(conversationId, iteration.thought);
            }

            // Log tool calls
            for (const tc of iteration.toolCalls) {
                console.log(`[WS] 🔧 Tool: ${tc.function_name}`, tc.arguments ? JSON.stringify(tc.arguments).slice(0, 100) : '');
            }
            if (iteration.toolCalls.length > 1) {
                console.log(`[WS] ⚡ Executing ${iteration.toolCalls.length} tools in parallel`);
            }
            if (iteration.warning) {
                console.warn(`[WS] ⚠️ Warning: ${iteration.warning}`);
            }

            // Handle tool call start (before execution) - send immediately to show current step
            if (iteration.isToolCallStart) {
                sendToClient(ws, {
                    type: 'tool_call_start',
                    data: {
                        thought: iteration.thought,
                        message: iteration.message,
                        toolCalls: iteration.toolCalls,
                    }
                }, conversationId);
                continue;
            }

            // Check for text tool (final response)
            const textTool = iteration.toolCalls.find(tc => tc.function_name === 'text');
            if (textTool) {
                finalResponse = textTool.arguments.response || '';
                // Capture the thought to save with the final response
                finalThought = iteration.thought;
                // If there's a thought/reasoning with the final response, send it as an iteration
                // so it appears in the train of thought before the final message
                if (iteration.thought || iteration.message) {
                    sendToClient(ws, {
                        type: 'iteration',
                        data: {
                            thought: iteration.thought,
                            message: iteration.message,
                            toolCalls: [],
                            toolResults: [],
                        }
                    }, conversationId);
                }
                // Don't add the text tool as a step, we'll add it as the final response
            } else if (iteration.toolCalls.length > 0 && iteration.toolResults) {
                await atifConversationService.addStep(
                    conversation.id,
                    'agent',
                    iteration.message ?? '',
                    undefined,
                    iteration.toolCalls,
                    { results: iteration.toolResults },
                    iteration.thought,
                );

                // Send iteration update to client with results
                sendToClient(ws, { type: 'iteration', data: iteration }, conversationId);
            } else {
                console.warn(`[WS] ⚠️ No tool calls or results in iteration`);
            }
        }
    } catch (error) {
        if (error instanceof ResearchPausedError) {
            // State is already saved to DB via addStep calls
            console.log(`[WS] ⏸️ Research paused (conv: ${conversationId})`);
            setSessionPaused(conversationId);
            return;
        }
        console.error(`[WS] ❌ Research error:`, error);
        sendToClient(ws, { type: 'error', error: error instanceof Error ? error.message : String(error) }, conversationId);

        // Clean up session
        const sessions = getConnectionSessions(ws);
        sessions.delete(conversationId);
        setSessionInactive(conversationId);
        return;
    }

    // If no final response was generated, create one
    if (!finalResponse) {
        finalResponse = 'Failed to generate response.';
    }

    // Add final response as the last agent step (with reasoning if present)
    await atifConversationService.addStep(
        conversation.id,
        'agent',
        finalResponse,
        undefined,
        undefined,
        undefined,
        finalThought
    );

    console.log(`[WS] ✅ Research complete (conv: ${conversationId})`);
    console.log(`[WS] Iterations: ${iterationCount}`);
    console.log(`[WS] Response length: ${finalResponse.length} chars`);
    console.log(`${'='.repeat(60)}\n`);

    sendToClient(ws, {
        type: 'complete',
        data: {
            response: finalResponse,
            conversationId: conversation?.id
        }
    }, conversationId);

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
                console.log(`[WS] ⏸️ Pausing research (conv: ${data.conversationId})`);
                session.isPaused = true;
                session.abortController.abort();
                sendToClient(ws, { type: 'pause' }, data.conversationId);
                setSessionPaused(data.conversationId);
            }
            return;
        }

        // Handle resume command
        if (data.type === 'resume') {
            const session = sessions.get(data.conversationId);
            if (session && session.isPaused) {
                console.log(`[WS] ▶️ Resuming research${data.message ? ' with new message' : ''} (conv: ${data.conversationId})`);

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
            if (session?.pendingConfirmation) {
                const { requestId, resolve } = session.pendingConfirmation;
                const response = data.data;

                if (response.requestId === requestId) {
                    console.log(`[WS] 🔐 Confirmation response received: ${response.selectedOptionId} (conv: ${data.conversationId})`);
                    session.pendingConfirmation = undefined;
                    resolve(response);
                } else {
                    console.warn(`[WS] ⚠️ Confirmation response requestId mismatch: expected ${requestId}, got ${response.requestId}`);
                }
            } else {
                console.warn(`[WS] ⚠️ Received confirmation response but no pending confirmation (conv: ${data.conversationId})`);
            }
            return;
        }

        // Handle new message
        const { message: userQuery, conversationId } = data as { type: 'message'; message: string; conversationId?: string };
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[WS] 💬 New message received`);
        console.log(`[WS] Query: "${userQuery.slice(0, 100)}${userQuery.length > 100 ? '...' : ''}"`);
        console.log(`[WS] Conversation: ${conversationId || 'new'}`);

        // Check if there's already an active session for this conversation
        if (conversationId && sessions.has(conversationId)) {
            console.warn(`[WS] ⚠️ Already processing conversation: ${conversationId}`);
            sendToClient(ws, {
                type: 'error',
                error: 'A task is already running for this conversation. Please wait or pause it first.'
            }, conversationId);
            return;
        }

        // Get the user
        const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
        if (!user) {
            console.error(`[WS] ❌ User not found: ${getDefaultUser().email}`);
            ws.send(JSON.stringify({ type: 'error', error: 'User not found' }));
            return;
        }
        console.log(`[WS] User: ${user.email} (id: ${user.id})`);

        // Get the user's selected model
        const chatModelWithApi = await getDefaultChatModel(user);
        if (chatModelWithApi) {
            console.log(`[WS] 🤖 Model: ${chatModelWithApi.chatModel.name} (${chatModelWithApi.chatModel.modelType})`);
            console.log(`[WS] Provider: ${chatModelWithApi.aiModelApi?.name || 'Unknown'}`);
        } else {
            console.warn(`[WS] ⚠️ No chat model configured`);
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
                'panini-agent',
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

        // Add user message to conversation immediately
        await atifConversationService.addStep(
            conversation.id,
            'user',
            userQuery
        );

        // Create session for this research
        const session: ResearchSession = {
            isPaused: false,
            abortController: new AbortController(),
            conversationId: conversation.id,
            user,
            confirmationPreferences: createEmptyPreferences(),
        };
        sessions.set(conversation.id, session);

        // Run research (don't await - allow other messages to be processed)
        runResearch(ws, session).catch(error => {
            console.error(`[WS] ❌ Unhandled research error:`, error);
            sessions.delete(conversation.id);
            setSessionInactive(conversation.id);
        });
    },
    open(_ws: ServerWebSocket<WebSocketData>) {
        console.log("[WS] 🔌 Client connected");
    },
    close(ws: ServerWebSocket<WebSocketData>) {
        console.log("[WS] 🔌 Client disconnected");
        // Clean up all sessions on disconnect
        const sessions = activeConnections.get(ws);
        if (sessions) {
            for (const [conversationId, session] of sessions) {
                console.log(`[WS] 🧹 Cleaning up session for conversation: ${conversationId}`);
                session.abortController.abort();
                setSessionInactive(conversationId);
            }
            activeConnections.delete(ws);
        }
    }
};
