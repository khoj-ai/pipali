import type { ServerWebSocket } from 'bun';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { User } from '../db/schema';
import { getDefaultUser, maxIterations as defaultMaxIterations } from '../utils';
import { atifConversationService } from '../processor/conversation/atif/atif.service';
import { PlatformBillingError } from '../http/billing-errors';
import { runResearchWithConversation, ResearchPausedError } from '../processor/research-runner';
import { buildSystemPrompt } from '../processor/director';
import { loadUserContext } from '../user-context';
import { type ConfirmationContext } from '../processor/confirmation';
import { setSessionActive, setSessionInactive, updateSessionReasoning } from '../sessions';
import type { ClientMessage, QueuedMessage, StopReason } from './ws/message-types';
import { MessageCommandHandler, StopCommandHandler, ForkCommandHandler, ConfirmationResponseHandler } from './ws/commands';
import { createRunningState, getActiveRun, type Session } from './ws/session-state';
import { createConfirmationCallback, rejectAllConfirmations } from './ws/confirmation-manager';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'ws' });

export type WebSocketData = {};

type ConnectionSessions = Map<string, Session>;
type ConnectionContext = {
    sessions: ConnectionSessions;
    executors: Map<string, Promise<void>>;
    userCache?: typeof User.$inferSelect | null;
};

const activeConnections = new WeakMap<ServerWebSocket<WebSocketData>, ConnectionContext>();

function getConnectionContext(ws: ServerWebSocket<WebSocketData>): ConnectionContext {
    const existing = activeConnections.get(ws);
    if (existing) return existing;
    const ctx: ConnectionContext = { sessions: new Map(), executors: new Map() };
    activeConnections.set(ws, ctx);
    return ctx;
}

function send(ws: ServerWebSocket<WebSocketData>, conversationId: string, message: Record<string, unknown>): void {
    ws.send(JSON.stringify({ ...message, conversationId }));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function ensureUniqueRunId(
    session: Session,
    suggestedRunId: string
): { runId: string; suggestedRunId?: string } {
    const runIdInUse = new Set<string>();
    if (session.runState.status === 'running') {
        runIdInUse.add(session.runState.runId);
        for (const qm of session.runState.queuedMessages) runIdInUse.add(qm.runId);
    }
    if (session.runState.status === 'stopped') {
        runIdInUse.add(session.runState.runId);
        for (const qm of session.runState.queuedMessages) runIdInUse.add(qm.runId);
    }

    if (!runIdInUse.has(suggestedRunId)) {
        return { runId: suggestedRunId };
    }

    const regenerated = crypto.randomUUID();
    return { runId: regenerated, suggestedRunId };
}

async function ensureSystemPromptPersisted(conversationId: string): Promise<string | undefined> {
    const conversation = await atifConversationService.getConversation(conversationId);
    const hasSystem = !!conversation?.trajectory.steps.some(s => s.source === 'system');
    if (hasSystem) return undefined;

    const userContext = await loadUserContext();
    const now = new Date();
    const systemPrompt = await buildSystemPrompt({
        currentDate: now.toLocaleDateString('en-CA'),
        dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
        location: userContext.location,
        username: userContext.name,
        personality: userContext.instructions,
        now,
    });

    await atifConversationService.addStep(conversationId, 'system', systemPrompt);
    return systemPrompt;
}

async function persistUserMessage(
    ws: ServerWebSocket<WebSocketData>,
    conversationId: string,
    runId: string,
    clientMessageId: string,
    message: string
): Promise<void> {
    const userStep = await atifConversationService.addStep(conversationId, 'user', message);
    send(ws, conversationId, {
        type: 'user_step_saved',
        runId,
        clientMessageId,
        stepId: userStep.step_id,
    });
}

function startQueuedRun(session: Session, queued: QueuedMessage[]): Session {
    const [next, ...rest] = queued;
    if (!next) return session;

    const nextRunState = createRunningState(next.runId, next.clientMessageId);
    nextRunState.queuedMessages = rest;
    if (rest.length > 0) {
        nextRunState.stopMode = 'soft';
        nextRunState.stopReason = 'soft_interrupt';
    }

    return {
        ...session,
        userMessage: next.message,
        runState: nextRunState,
    };
}

async function runConversationExecutor(
    ws: ServerWebSocket<WebSocketData>,
    conversationId: string,
    sessions: ConnectionSessions
): Promise<void> {
    while (true) {
        const session = sessions.get(conversationId);
        const activeRun = session ? getActiveRun(session) : null;
        if (!session || !activeRun) {
            return;
        }

        const suggestedRunId = activeRun.runId;
        const { runId: runIdAuthoritative, suggestedRunId: suggestedRunIdOverride } =
            ensureUniqueRunId(session, suggestedRunId);

        if (runIdAuthoritative !== activeRun.runId) {
            activeRun.runId = runIdAuthoritative;
        }

        send(ws, conversationId, {
            type: 'run_started',
            runId: runIdAuthoritative,
            clientMessageId: activeRun.clientMessageId,
            ...(suggestedRunIdOverride ? { suggestedRunId: suggestedRunIdOverride } : {}),
        });

        setSessionActive(conversationId);

        let systemPromptOverride: string | undefined;
        try {
            systemPromptOverride = await ensureSystemPromptPersisted(conversationId);
        } catch (error) {
            log.error({ err: error, conversationId }, 'Failed to persist system prompt');
        }

        const messageToPersist = session.userMessage;
        if (isNonEmptyString(messageToPersist)) {
            await persistUserMessage(ws, conversationId, runIdAuthoritative, activeRun.clientMessageId, messageToPersist);
            sessions.set(conversationId, { ...session, userMessage: undefined });
        }

        const confirmationContext: ConfirmationContext = {
            requestConfirmation: createConfirmationCallback(ws, conversationId, activeRun),
            preferences: session.confirmationPreferences,
        };

        let preemptedToQueuedRun = false;
        let shouldStartNextFromQueueAfterComplete = false;
        let queuedAfterComplete: QueuedMessage[] = [];

        try {
            const runner = runResearchWithConversation({
                conversationId,
                user: session.user,
                maxIterations: defaultMaxIterations,
                abortSignal: activeRun.abortController.signal,
                confirmationContext,
                systemPrompt: systemPromptOverride,
            });

            let iteratorResult = await runner.next();
            while (!iteratorResult.done) {
                const iteration = iteratorResult.value;

                if (iteration.isToolCallStart) {
                    send(ws, conversationId, {
                        type: 'step_start',
                        runId: runIdAuthoritative,
                        data: {
                            thought: iteration.thought,
                            message: iteration.message,
                            toolCalls: iteration.toolCalls,
                        },
                    });

                    const reasoning = iteration.message || iteration.thought;
                    if (reasoning) updateSessionReasoning(conversationId, reasoning);

                    iteratorResult = await runner.next();
                    continue;
                }

                if (iteration.toolCalls.length > 0) {
                    send(ws, conversationId, {
                        type: 'step_end',
                        runId: runIdAuthoritative,
                        data: {
                            thought: iteration.thought,
                            message: iteration.message,
                            toolCalls: iteration.toolCalls,
                            toolResults: iteration.toolResults ?? [],
                            stepId: iteration.stepId,
                            metrics: iteration.metrics,
                        },
                    });
                }

                const latest = sessions.get(conversationId);
                if (latest?.runState.status === 'running' && latest.runState.runId === runIdAuthoritative) {
                    if (latest.runState.stopMode === 'soft' && latest.runState.queuedMessages.length > 0) {
                        send(ws, conversationId, {
                            type: 'run_stopped',
                            runId: runIdAuthoritative,
                            reason: 'soft_interrupt',
                        });

                        const nextSession = startQueuedRun(latest, latest.runState.queuedMessages);
                        sessions.set(conversationId, nextSession);
                        await runner.return(undefined as any);
                        preemptedToQueuedRun = true;
                        break;
                    }
                }

                iteratorResult = await runner.next();
            }

            if (preemptedToQueuedRun) {
                continue;
            }

            if (!iteratorResult.done) {
                continue;
            }

            const result = iteratorResult.value;
            if (result) {
                send(ws, conversationId, {
                    type: 'run_complete',
                    runId: runIdAuthoritative,
                    data: {
                        response: result.response,
                        stepId: result.stepId,
                    },
                });
            }

            const latest = sessions.get(conversationId);
            if (latest?.runState.status === 'running' && latest.runState.runId === runIdAuthoritative) {
                queuedAfterComplete = latest.runState.queuedMessages;
                shouldStartNextFromQueueAfterComplete = latest.runState.stopMode === 'soft' && queuedAfterComplete.length > 0;
            }

            setSessionInactive(conversationId);

            if (shouldStartNextFromQueueAfterComplete) {
                const nextSession = startQueuedRun(latest!, queuedAfterComplete);
                sessions.set(conversationId, nextSession);
                continue;
            }

            sessions.delete(conversationId);
            return;
        } catch (error) {
            const latest = sessions.get(conversationId);
            const currentRunState = latest?.runState.status === 'running' ? latest.runState : null;

            if (error instanceof PlatformBillingError) {
                send(ws, conversationId, {
                    type: 'billing_error',
                    runId: runIdAuthoritative,
                    error: error.details,
                });
                sessions.delete(conversationId);
                setSessionInactive(conversationId);
                return;
            }

            if (error instanceof ResearchPausedError) {
                const reason: StopReason = currentRunState?.stopMode === 'hard'
                    ? (currentRunState.stopReason ?? 'user_stop')
                    : 'disconnect';

                send(ws, conversationId, {
                    type: 'run_stopped',
                    runId: runIdAuthoritative,
                    reason,
                });

                const shouldAutoStart = reason === 'soft_interrupt' && currentRunState && currentRunState.queuedMessages.length > 0;

                setSessionInactive(conversationId);

                if (shouldAutoStart) {
                    const nextSession = startQueuedRun(latest!, currentRunState!.queuedMessages);
                    sessions.set(conversationId, nextSession);
                    continue;
                }

                sessions.delete(conversationId);
                return;
            }

            log.error({ err: error, conversationId }, 'Run error');
            send(ws, conversationId, {
                type: 'run_stopped',
                runId: runIdAuthoritative,
                reason: 'error',
                error: error instanceof Error ? error.message : String(error),
            });

            setSessionInactive(conversationId);
            sessions.delete(conversationId);
            return;
        }
    }
}

async function handleClientMessage(
    ws: ServerWebSocket<WebSocketData>,
    rawMessage: string,
    sessions: ConnectionSessions,
    getUser: () => Promise<typeof User.$inferSelect | null>,
    executors: Map<string, Promise<void>>
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
        getSessions: () => sessions,
        getUser,
        send: (msg: Record<string, unknown>, conversationId: string) => send(ws, conversationId, msg),
        sendError: (error: string, conversationId?: string) => {
            // No out-of-band error messages in the run-based protocol.
            log.warn({ error, conversationId }, 'Command error');
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
        default:
            return;
    }

    const conversationId =
        message.type === 'message'
            ? (message.conversationId ??
                Array.from(sessions.entries()).find(
                    ([_, s]) => s.runState.status === 'running' && s.runState.clientMessageId === message.clientMessageId
                )?.[0])
            : Array.from(sessions.entries()).find(
                ([_, s]) => s.runState.status === 'running' && s.runState.clientMessageId === message.clientMessageId
            )?.[0];

    if (!conversationId) return;

    const session = sessions.get(conversationId);
    if (!session) return;

    if (executors.has(conversationId)) return;

    const executor = runConversationExecutor(ws, conversationId, sessions)
        .finally(() => {
            executors.delete(conversationId);
        });
    executors.set(conversationId, executor);
}

export const websocketHandler = {
    async message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
        if (typeof message !== 'string') return;

        const ctx = getConnectionContext(ws);
        const sessions = ctx.sessions;
        const executors = ctx.executors;

        const getUser = async () => {
            if (ctx.userCache !== undefined) return ctx.userCache;
            const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
            ctx.userCache = user ?? null;
            return ctx.userCache;
        };

        await handleClientMessage(ws, message, sessions, getUser, executors);
    },

    open(ws: ServerWebSocket<WebSocketData>) {
        log.info('Client connected');
        // Reset mock state for test isolation (no-op in production)
        globalThis.__pipaliMockReset?.();
        getConnectionContext(ws);
    },

    close(ws: ServerWebSocket<WebSocketData>) {
        log.info('Client disconnected');
        const ctx = activeConnections.get(ws);
        if (!ctx) return;
        const sessions = ctx.sessions;

        for (const [conversationId, session] of sessions) {
            const activeRun = getActiveRun(session);
            if (activeRun) {
                activeRun.abortController.abort();
                rejectAllConfirmations(activeRun, 'Client disconnected');
            }
            setSessionInactive(conversationId);
        }

        activeConnections.delete(ws);
    },
};
