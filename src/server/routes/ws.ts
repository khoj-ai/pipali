import type { Server, ServerWebSocket } from 'bun';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { User } from '../db/schema';
import { getDefaultUser } from '../utils';
import { getOrCreateBus, getBus } from '../events/conversation-event-bus';
import { executeRun } from '../events/run-executor';
import type { ClientMessage } from './ws/message-types';
import {
    MessageCommandHandler,
    StopCommandHandler,
    ForkCommandHandler,
    ConfirmationResponseHandler,
    ObserveCommandHandler,
} from './ws/commands';
import type { Session } from './ws/session-state';
import { isAllowedRequestOrigin } from './origin-guard';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'ws' });

export type WebSocketData = {};

type ConnectionContext = {
    /** Legacy sessions map — used by message/fork commands during transition */
    sessions: Map<string, Session>;
    executors: Map<string, Promise<void>>;
    /**
     * Subscriptions for this WS connection.
     * Allow multiple subscriptions so the client can track background tasks
     * (home page + sidebar) while viewing another conversation.
     */
    subscriptions: Map<string, () => void>;
    userCache?: typeof User.$inferSelect | null;
};

const activeConnections = new WeakMap<ServerWebSocket<WebSocketData>, ConnectionContext>();

function getConnectionContext(ws: ServerWebSocket<WebSocketData>): ConnectionContext {
    const existing = activeConnections.get(ws);
    if (existing) return existing;
    const ctx: ConnectionContext = {
        sessions: new Map(),
        executors: new Map(),
        subscriptions: new Map(),
    };
    activeConnections.set(ws, ctx);
    return ctx;
}

function send(ws: ServerWebSocket<WebSocketData>, conversationId: string, message: Record<string, unknown>): void {
    ws.send(JSON.stringify({ ...message, conversationId }));
}

async function handleClientMessage(
    ws: ServerWebSocket<WebSocketData>,
    rawMessage: string,
    connCtx: ConnectionContext,
    getUser: () => Promise<typeof User.$inferSelect | null>,
): Promise<void> {
    let message: ClientMessage;
    try {
        message = JSON.parse(rawMessage);
    } catch {
        log.warn('Invalid JSON from client');
        return;
    }

    const ctx = {
        ws,
        getSessions: () => connCtx.sessions,
        getUser,
        send: (msg: Record<string, unknown>, conversationId: string) => send(ws, conversationId, msg),
        sendError: (error: string, conversationId?: string) => {
            log.warn({ error, conversationId }, 'Command error');
        },
        addSubscription: (conversationId: string, unsubscribe: () => void) => {
            // Clean up any existing subscription for this conversation
            connCtx.subscriptions.get(conversationId)?.();
            connCtx.subscriptions.set(conversationId, unsubscribe);
        },
    };

    switch (message.type) {
        case 'message':
            await MessageCommandHandler.execute(ctx, message);
            break;
        case 'stop':
            await StopCommandHandler.execute(ctx, message);
            return;
        case 'fork':
            await ForkCommandHandler.execute(ctx, message);
            break;
        case 'confirmation_response':
            await ConfirmationResponseHandler.execute(ctx, message);
            return;
        case 'observe':
            await ObserveCommandHandler.execute(ctx, message);
            return;
        default:
            return;
    }

    // For message commands that were handled as soft-interrupts on the bus
    // (no session created), ensure this WS is subscribed to the bus
    if (message.type === 'message' && message.conversationId) {
        const bus = getBus(message.conversationId);
        if (bus?.activeRun && !connCtx.subscriptions.has(message.conversationId)) {
            const cid = message.conversationId;
            const unsubscribe = bus.subscribe(event => {
                send(ws, cid, event as unknown as Record<string, unknown>);
            });
            connCtx.subscriptions.set(cid, unsubscribe);
        }
    }

    // After message/fork commands, check if we need to start an executor
    const conversationId =
        message.type === 'message'
            ? (message.conversationId ??
                Array.from(connCtx.sessions.entries()).find(
                    ([_, s]) => s.runState.status === 'running' && s.runState.clientMessageId === message.clientMessageId
                )?.[0])
            : Array.from(connCtx.sessions.entries()).find(
                ([_, s]) => s.runState.status === 'running' && s.runState.clientMessageId === message.clientMessageId
            )?.[0];

    if (!conversationId) return;

    const session = connCtx.sessions.get(conversationId);
    if (!session) return;

    // Don't start a new executor if one is already running for this conversation
    if (connCtx.executors.has(conversationId)) return;

    // Get or create bus and subscribe this WS
    const bus = getOrCreateBus(conversationId);
    bus.user = session.user;
    bus.confirmationPreferences = session.confirmationPreferences;
    bus.chatModelId = session.chatModelId;

    // Subscribe this WS to the bus (if not already)
    if (!connCtx.subscriptions.has(conversationId)) {
        const unsubscribe = bus.subscribe(event => {
            send(ws, conversationId, event as unknown as Record<string, unknown>);
        });
        connCtx.subscriptions.set(conversationId, unsubscribe);
    }

    // Fire-and-forget the run executor
    const runState = session.runState;
    if (runState.status !== 'running') return;

    const executor = executeRun({
        bus,
        conversationId,
        user: session.user,
        userMessage: session.userMessage,
        runId: runState.runId,
        clientMessageId: runState.clientMessageId,
        confirmationPreferences: session.confirmationPreferences,
        chatModelId: session.chatModelId,
    }).finally(() => {
        connCtx.executors.delete(conversationId);
        connCtx.sessions.delete(conversationId);
    });

    connCtx.executors.set(conversationId, executor);
}

/**
 * Admit a /ws/chat handshake, or refuse it.
 *
 * This channel drives the agent as the local user, and CORS does not apply to WebSocket upgrades,
 * so a page the user merely visits could otherwise open one and issue commands. Returns a response
 * to send when the handshake is refused, or undefined once the socket has been taken over.
 */
export function handleChatUpgrade(req: Request, server: Server<WebSocketData>): Response | undefined {
    if (!isAllowedRequestOrigin(req)) {
        log.warn(`Rejected WebSocket upgrade from origin ${req.headers.get('Origin')}`);
        return new Response('Forbidden origin', { status: 403 });
    }
    if (server.upgrade(req, { data: {} })) return undefined;
    return new Response('WebSocket upgrade failed', { status: 400 });
}

export const websocketHandler = {
    async message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
        if (typeof message !== 'string') return;

        const connCtx = getConnectionContext(ws);

        const getUser = async () => {
            if (connCtx.userCache !== undefined) return connCtx.userCache;
            const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
            connCtx.userCache = user ?? null;
            return connCtx.userCache;
        };

        await handleClientMessage(ws, message, connCtx, getUser);
    },

    open(ws: ServerWebSocket<WebSocketData>) {
        log.info('Client connected');
        ws.subscribe('runs');
        getConnectionContext(ws);
    },

    close(ws: ServerWebSocket<WebSocketData>) {
        log.info('Client disconnected');
        const ctx = activeConnections.get(ws);
        if (!ctx) return;

        // Unsubscribe from all buses — runs do NOT abort
        for (const [, unsubscribe] of ctx.subscriptions) {
            unsubscribe();
        }

        activeConnections.delete(ws);
    },
};
