/**
 * Run Executor
 *
 * Transport-agnostic run execution. Publishes events to a ConversationEventBus.
 * Extracted from ws.ts to decouple runs from WebSocket connections.
 */

import type { User } from '../db/schema';
import type { ConfirmationPreferences, ConfirmationContext } from '../processor/confirmation';
import type { QueuedMessage, StopReason } from '../routes/ws/message-types';
import { type ConversationEventBus, type RunHandle, createRunHandle } from './conversation-event-bus';
import { runResearchWithConversation, ResearchPausedError } from '../processor/research-runner';
import { PlatformBillingError } from '../http/billing-errors';
import { PlatformAuthError } from '../http/platform-fetch';
import { atifConversationService, type ConversationRole } from '../processor/conversation/atif/atif.service';
import { buildSystemPrompt } from '../processor/director';
import { loadUserContext } from '../user-context';
import { loadMemorySettings } from '../memory/settings';
import { loadCatalogue } from '../memory';
import { maybeDream } from '../memory/dream';
import { isFirstRunEasterEgg, maxIterations as defaultMaxIterations } from '../utils';
import { setSessionActive, setSessionInactive, updateSessionReasoning } from '../sessions';
import { createConfirmationCallback } from '../routes/ws/confirmation-manager';
import { createChildLogger } from '../logger';
import { getServer } from '../server-instance';

const log = createChildLogger({ component: 'run-executor' });

export interface ExecuteRunOptions {
    bus: ConversationEventBus;
    conversationId: string;
    user: typeof User.$inferSelect;
    userMessage?: string;
    runId: string;
    clientMessageId: string;
    confirmationPreferences: ConfirmationPreferences;
    chatModelId?: number;
    chatModelAlias?: string;
    /** Override the confirmation context (e.g., for automation hybrid confirmations) */
    confirmationContextOverride?: ConfirmationContext;
}

/**
 * Sanitize error message for client display.
 */
function sanitizeErrorForClient(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Failed query:')) {
        return 'A database error occurred. Please try again.';
    }
    const maxLength = 300;
    if (message.length > maxLength) {
        return message.slice(0, maxLength / 2) + '...' + message.slice(-maxLength / 2);
    }
    return message;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** A model alias belongs to one queued run; omitting it explicitly returns to the concrete model. */
function resolveQueuedModel(
    currentChatModelId: number | undefined,
    next: Pick<QueuedMessage, 'chatModelId' | 'chatModelAlias'>,
): [chatModelId: number | undefined, chatModelAlias: string | undefined] {
    return [next.chatModelId ?? currentChatModelId, next.chatModelAlias];
}

function ensureUniqueRunId(
    runHandle: RunHandle,
): { runId: string; suggestedRunId?: string } {
    // With bus-based model, collisions between queued run IDs are checked here
    const runIdInUse = new Set<string>();
    for (const qm of runHandle.queuedMessages) runIdInUse.add(qm.runId);

    if (!runIdInUse.has(runHandle.runId)) {
        return { runId: runHandle.runId };
    }

    const regenerated = crypto.randomUUID();
    return { runId: regenerated, suggestedRunId: runHandle.runId };
}

async function ensureSystemPromptPersisted(
    conversationId: string,
    userId: number,
    conversationRole: ConversationRole,
    userMessage?: string,
): Promise<string | undefined> {
    const conversation = await atifConversationService.getConversation(conversationId);
    const hasSystem = !!conversation?.trajectory.steps.some(s => s.source === 'system');
    if (hasSystem) return undefined;

    const isFirstEverConversation = (userMessage && isFirstRunEasterEgg(userMessage))
        || (await atifConversationService.countUserConversations(userId)) <= 1;

    const modelName = conversation?.trajectory.agent.model_name.toLowerCase() || '';
    const provideUpdatesPreamble = /^gpt-5\.[4-9]/.test(modelName)
        ? "Provide frequent, user-visible intermediary updates to communicate progress and new information to the user as you work. Tone of your updates must match your personality."
        : undefined;

    const userContext = await loadUserContext();
    const { memoriesEnabled } = await loadMemorySettings(userId);
    const now = new Date();
    const systemPrompt = await buildSystemPrompt({
        currentDate: now.toLocaleDateString('en-CA'),
        dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
        location: userContext.location,
        language: userContext.language,
        username: userContext.name,
        userContext: userContext.instructions,
        provideUpdatesPreamble,
        isFirstEverConversation,
        conversationRole,
        // Only reached for a conversation without a system prompt, so this is its baseline
        memoryCatalogue: memoriesEnabled ? await loadCatalogue() : undefined,
        memoriesEnabled,
        now,
    });

    await atifConversationService.addStep(conversationId, 'system', systemPrompt);
    return systemPrompt;
}

async function persistUserMessage(
    bus: ConversationEventBus,
    conversationId: string,
    runId: string,
    clientMessageId: string,
    message: string,
): Promise<void> {
    const userStep = await atifConversationService.addStep(conversationId, 'user', message);
    bus.publish({
        type: 'user_step_saved',
        conversationId,
        runId,
        clientMessageId,
        stepId: userStep.step_id,
        message,
    });
}

/**
 * Execute a run on a conversation, publishing all events to the bus.
 * Handles queued messages by looping internally.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<void> {
    const { bus, conversationId, user, confirmationPreferences, confirmationContextOverride } = options;
    let userMessage: string | undefined = options.userMessage;
    let runId = options.runId;
    let clientMessageId = options.clientMessageId;
    let currentChatModelId = options.chatModelId;
    let currentChatModelAlias = options.chatModelAlias;
    let carryOverQueue: QueuedMessage[] = [];

    while (true) {
        const runHandle = createRunHandle(runId, clientMessageId, conversationId);
        // Carry over remaining queued messages from previous run
        if (carryOverQueue.length > 0) {
            runHandle.queuedMessages = carryOverQueue;
            runHandle.stopMode = 'soft';
            runHandle.stopReason = 'soft_interrupt';
            carryOverQueue = [];
        }
        bus.activeRun = runHandle;

        const { runId: runIdAuthoritative, suggestedRunId: suggestedRunIdOverride } =
            ensureUniqueRunId(runHandle);

        if (runIdAuthoritative !== runHandle.runId) {
            runHandle.runId = runIdAuthoritative;
        }

        const runStartedEvent = {
            type: 'run_started' as const,
            conversationId,
            runId: runIdAuthoritative,
            clientMessageId: runHandle.clientMessageId,
            ...(suggestedRunIdOverride ? { suggestedRunId: suggestedRunIdOverride } : {}),
        };
        bus.publish(runStartedEvent);

        // Broadcast to all connected clients so the home page discovers new runs
        // without requiring navigation or polling.
        getServer()?.publish('runs', JSON.stringify(runStartedEvent));

        setSessionActive(conversationId);

        // Resolved per run rather than once, so a conversation that becomes Home or a
        // delegated task picks up the right framing on its next run.
        const conversationRole = await atifConversationService
            .getConversationRole(conversationId, user)
            .catch(() => 'manual' as ConversationRole);

        let systemPromptOverride: string | undefined;
        try {
            systemPromptOverride = await ensureSystemPromptPersisted(conversationId, user.id, conversationRole, userMessage);
        } catch (error) {
            log.error({ err: error, conversationId }, 'Failed to persist system prompt');
        }

        if (isNonEmptyString(userMessage)) {
            await persistUserMessage(bus, conversationId, runIdAuthoritative, runHandle.clientMessageId, userMessage);
            userMessage = undefined;
        }

        const confirmationContext: ConfirmationContext = confirmationContextOverride ?? {
            requestConfirmation: createConfirmationCallback(bus, conversationId, runHandle),
            preferences: confirmationPreferences,
        };

        let preemptedToQueuedRun = false;
        let shouldStartNextFromQueueAfterComplete = false;
        let queuedAfterComplete: QueuedMessage[] = [];

        try {
            const runner = runResearchWithConversation({
                conversationId,
                user,
                maxIterations: defaultMaxIterations,
                abortSignal: runHandle.abortController.signal,
                confirmationContext,
                systemPrompt: systemPromptOverride,
                chatModelId: currentChatModelId,
                chatModelAlias: currentChatModelAlias,
                conversationRole,
                runId: runIdAuthoritative,
                // Claimed, not copied: what a run leaves unclaimed is what wakes the
                // conversation once it settles (see parent-inbox).
                drainInjectedSteps: () => runHandle.injectedSteps.splice(0),
                onTextDelta: (delta) => {
                    bus.publish({
                        type: 'text_delta',
                        conversationId,
                        runId: runIdAuthoritative,
                        data: { delta },
                    });
                },
            });

            let iteratorResult = await runner.next();
            while (!iteratorResult.done) {
                const iteration = iteratorResult.value;

                if (iteration.isToolCallStart) {
                    if (iteration.compactionSummary) {
                        bus.publish({
                            type: 'compaction',
                            conversationId,
                            runId: runIdAuthoritative,
                            data: { summary: iteration.compactionSummary },
                        });
                    }
                    bus.publish({
                        type: 'step_start',
                        conversationId,
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
                    bus.publish({
                        type: 'step_end',
                        conversationId,
                        runId: runIdAuthoritative,
                        data: {
                            thought: iteration.thought,
                            message: iteration.message,
                            toolCalls: iteration.toolCalls,
                            toolResults: iteration.toolResults ?? [],
                            stepId: iteration.stepId!,
                            metrics: iteration.metrics,
                        },
                    });
                } else if (iteration.compactionSummary) {
                    bus.publish({
                        type: 'compaction',
                        conversationId,
                        runId: runIdAuthoritative,
                        data: { summary: iteration.compactionSummary },
                    });
                }

                // Check for mid run soft-interrupt
                if (iteration.toolCalls.length > 0 && runHandle.stopMode === 'soft' && runHandle.queuedMessages.length > 0) {
                    bus.publish({
                        type: 'run_stopped',
                        conversationId,
                        runId: runIdAuthoritative,
                        reason: 'soft_interrupt',
                    });

                    await runner.return(undefined as any);
                    preemptedToQueuedRun = true;
                    break;
                }

                iteratorResult = await runner.next();
            }

            if (preemptedToQueuedRun) {
                setSessionInactive(conversationId);
                const [next, ...rest] = runHandle.queuedMessages;
                if (next) {
                    runId = next.runId;
                    clientMessageId = next.clientMessageId;
                    userMessage = next.message;
                    [currentChatModelId, currentChatModelAlias] = resolveQueuedModel(currentChatModelId, next);
                    carryOverQueue = rest;
                    continue;
                }
                bus.onRunFinished();
                return;
            }

            if (!iteratorResult!.done) {
                continue;
            }

            const result = iteratorResult!.value;
            if (result) {
                bus.publish({
                    type: 'run_complete',
                    conversationId,
                    runId: runIdAuthoritative,
                    data: {
                        response: result.response,
                        stepId: result.stepId,
                    },
                });
            }

            // Check if there are queued messages to process after completion
            queuedAfterComplete = runHandle.queuedMessages;
            shouldStartNextFromQueueAfterComplete = runHandle.stopMode === 'soft' && queuedAfterComplete.length > 0;

            setSessionInactive(conversationId);

            if (shouldStartNextFromQueueAfterComplete) {
                const [next, ...rest] = queuedAfterComplete;
                if (next) {
                    runId = next.runId;
                    clientMessageId = next.clientMessageId;
                    userMessage = next.message;
                    [currentChatModelId, currentChatModelAlias] = resolveQueuedModel(currentChatModelId, next);
                    carryOverQueue = rest;
                    continue;
                }
            }

            bus.onRunFinished();

            // A settled run is the moment new material exists and nobody is waiting on
            // the turn. Whether it is time to consolidate is the dream's own business.
            void maybeDream(user);
            return;
        } catch (error) {
            if (error instanceof PlatformBillingError) {
                bus.publish({
                    type: 'billing_error',
                    conversationId,
                    runId: runIdAuthoritative,
                    error: error.details,
                });
                setSessionInactive(conversationId);
                bus.onRunFinished();
                return;
            }

            if (error instanceof PlatformAuthError) {
                bus.publish({
                    type: 'auth_error',
                    conversationId,
                    runId: runIdAuthoritative,
                    error: { code: 'session_expired', message: error.message },
                });
                setSessionInactive(conversationId);
                bus.onRunFinished();
                return;
            }

            if (error instanceof ResearchPausedError) {
                const reason: StopReason = runHandle.stopMode === 'hard'
                    ? (runHandle.stopReason ?? 'user_stop')
                    : 'disconnect';

                bus.publish({
                    type: 'run_stopped',
                    conversationId,
                    runId: runIdAuthoritative,
                    reason,
                });

                const shouldAutoStart = reason === 'soft_interrupt'
                    && runHandle.queuedMessages.length > 0;

                setSessionInactive(conversationId);

                if (shouldAutoStart) {
                    const [next, ...rest] = runHandle.queuedMessages;
                    if (next) {
                        runId = next.runId;
                        clientMessageId = next.clientMessageId;
                        userMessage = next.message;
                        [currentChatModelId, currentChatModelAlias] = resolveQueuedModel(currentChatModelId, next);
                        carryOverQueue = rest;
                        continue;
                    }
                }

                bus.onRunFinished();
                return;
            }

            log.error({ err: error, conversationId }, 'Run error');
            bus.publish({
                type: 'run_stopped',
                conversationId,
                runId: runIdAuthoritative,
                reason: 'error',
                error: sanitizeErrorForClient(error),
            });

            setSessionInactive(conversationId);
            bus.onRunFinished();
            return;
        }
    }
}
