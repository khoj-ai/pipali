/**
 * Automation Executor
 *
 * Manages execution queue and runs automations using the research loop.
 * Handles concurrency, rate limiting, retry logic, and execution tracking.
 */

import { db } from '../../db';
import { Automation, AutomationExecution, Conversation, PendingConfirmation, User } from '../../db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { atifConversationService } from '../../processor/conversation/atif/atif.service';
import type { TriggerEventData } from '../types';
import type { ConfirmationOutcome, ConfirmationPersistence } from '../../processor/confirmation';
import { createEmptyPreferences, CONFIRMATION_OPTIONS, CONFIRMATION_TIMEOUT_MS } from '../../processor/confirmation';
import type { ConfirmationRequest, ConfirmationResponse } from '../../processor/confirmation/confirmation.types';
import { getBus, getOrCreateBus } from '../../events/conversation-event-bus';
import { stopConversationRun } from '../../events/conversation-runs';
import { resolveConfirmationOnBus } from '../../routes/ws/confirmation-manager';
import { executeRun } from '../../events/run-executor';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'automation' });

// Max concurrent executions
const MAX_CONCURRENT = 3;

// Retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAYS = [15000, 30000]; // 15s, 30s

// Execution queue (in-memory for MVP)
interface QueuedExecution {
    automationId: string;
    triggerData: TriggerEventData;
    executionId: string;
}

const executionQueue: QueuedExecution[] = [];

// Currently running executions, by automation. The conversation lands once the run has
// one, and is how cancelling reaches the run and the confirmations it is blocked on.
const runningExecutions = new Map<string, { conversationId?: string }>();

/**
 * Check if automation has exceeded rate limits
 */
async function checkRateLimits(automation: typeof Automation.$inferSelect): Promise<boolean> {
    const now = new Date();

    // Check hourly limit
    if (automation.maxExecutionsPerHour) {
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const hourlyCount = await db.select({ count: sql<number>`count(*)` })
            .from(AutomationExecution)
            .where(and(
                eq(AutomationExecution.automationId, automation.id),
                gte(AutomationExecution.createdAt, oneHourAgo)
            ));

        if (Number(hourlyCount[0]?.count ?? 0) >= automation.maxExecutionsPerHour) {
            log.info(`Rate limit exceeded (hourly) for ${automation.id}`);
            return false;
        }
    }

    // Check daily limit
    if (automation.maxExecutionsPerDay) {
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const dailyCount = await db.select({ count: sql<number>`count(*)` })
            .from(AutomationExecution)
            .where(and(
                eq(AutomationExecution.automationId, automation.id),
                gte(AutomationExecution.createdAt, oneDayAgo)
            ));

        if (Number(dailyCount[0]?.count ?? 0) >= automation.maxExecutionsPerDay) {
            log.info(`Rate limit exceeded (daily) for ${automation.id}`);
            return false;
        }
    }

    return true;
}

/**
 * Queue an automation for execution.
 * Returns executionId and conversationId, or null if the automation
 * cannot run (not found, inactive, rate-limited).
 */
export async function queueExecution(
    automationId: string,
    triggerData: TriggerEventData
): Promise<{ executionId: string; conversationId: string } | null> {
    log.info(`Queuing execution for ${automationId}`);

    // Get automation to check rate limits
    const [automation] = await db.select()
        .from(Automation)
        .where(eq(Automation.id, automationId));

    if (!automation) {
        log.error(`Not found: ${automationId}`);
        return null;
    }

    if (automation.status !== 'active') {
        log.info(`Skipping inactive automation: ${automationId}`);
        return null;
    }

    // Check rate limits
    const withinLimits = await checkRateLimits(automation);
    if (!withinLimits) {
        return null;
    }

    // Ensure conversation exists before queuing so callers always get a conversationId
    const [user] = await db.select()
        .from(User)
        .where(eq(User.id, automation.userId));
    if (!user) {
        log.error(`User not found for: ${automationId}`);
        return null;
    }
    const conversationId = await getOrCreateAutomationConversation(automation, user);

    // Create execution record
    const insertResult = await db.insert(AutomationExecution)
        .values({
            automationId,
            status: 'pending',
            triggerData,
        })
        .returning();

    const execution = insertResult[0];
    if (!execution) {
        log.error(`Failed to create execution record for ${automationId}`);
        return null;
    }

    executionQueue.push({
        automationId,
        triggerData,
        executionId: execution.id,
    });

    // Process queue (non-blocking)
    processQueue();

    return { executionId: execution.id, conversationId };
}

/**
 * Process the execution queue
 */
async function processQueue(): Promise<void> {
    while (
        executionQueue.length > 0 &&
        runningExecutions.size < MAX_CONCURRENT
    ) {
        const item = executionQueue.shift();
        if (!item) break;

        // Don't await - run in background with retry logic
        runExecutionWithRetry(item.executionId, item.automationId, item.triggerData);
    }
}

/**
 * Run execution with retry logic
 */
async function runExecutionWithRetry(
    executionId: string,
    automationId: string,
    triggerData: TriggerEventData
): Promise<void> {
    let lastError: Error | null = null;
    let includeUserMessage = true;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            await runExecution(executionId, automationId, triggerData, { includeUserMessage });
            return; // Success - exit retry loop
        } catch (error) {
            lastError = error as Error;
            const errorMessage = lastError.message;
            includeUserMessage = false;

            // Don't retry for certain error types
            if (
                errorMessage === 'Confirmation timeout expired' ||
                errorMessage === 'Automation not found' ||
                errorMessage === 'User not found'
            ) {
                log.info(`Non-retryable error for ${executionId}: ${errorMessage}`);
                return;
            }

            // Update retry count in DB
            await db.update(AutomationExecution)
                .set({ retryCount: attempt + 1 })
                .where(eq(AutomationExecution.id, executionId));

            if (attempt < MAX_RETRIES) {
                const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
                log.info(`Retry ${attempt + 1}/${MAX_RETRIES} for ${executionId} in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // All retries failed
    log.error({ err: lastError, executionId }, 'All retries failed');
    await markExecutionFailed(executionId, lastError?.message || 'Unknown error after retries');
}

/**
 * Build prompt with trigger context injected
 */
function buildPromptWithContext(
    basePrompt: string,
    triggerData: TriggerEventData
): string {
    let context = '';

    if (triggerData.type === 'cron') {
        context = `[Scheduled execution at ${triggerData.scheduledTime || triggerData.timestamp}]\n\n`;
    } else if (triggerData.type === 'file_watch' && triggerData.file) {
        context = `[Triggered by file ${triggerData.file.event}: ${triggerData.file.path}]\n\n`;
    } else if (triggerData.type === 'external' && triggerData.external) {
        context = `[Triggered externally via ${triggerData.external.source}]\n`;
        if (triggerData.external.metadata && Object.keys(triggerData.external.metadata).length > 0) {
            context += `Metadata: ${JSON.stringify(triggerData.external.metadata)}\n\n`;
        }
    }

    return context + basePrompt;
}

/**
 * Record an automation's confirmations, so one raised while nobody is watching the run is
 * still answerable later from the routines page.
 *
 * The request itself travels the conversation's event bus like any other, so a client
 * watching the routine gets the dialog the moment the run asks.
 */
export function createAutomationConfirmationPersistence(executionId: string): ConfirmationPersistence {
    const rowByRequest = new Map<string, string>();

    return {
        async onRequest(request: ConfirmationRequest): Promise<void> {
            await db.update(AutomationExecution)
                .set({ status: 'awaiting_confirmation' })
                .where(eq(AutomationExecution.id, executionId));

            const [row] = await db.insert(PendingConfirmation)
                .values({
                    executionId,
                    request,
                    status: 'pending',
                    expiresAt: new Date(Date.now() + CONFIRMATION_TIMEOUT_MS),
                })
                .returning({ id: PendingConfirmation.id });

            if (row) rowByRequest.set(request.requestId, row.id);
        },

        async onSettled(request: ConfirmationRequest, outcome: ConfirmationOutcome): Promise<void> {
            const rowId = rowByRequest.get(request.requestId);
            if (!rowId) return;
            rowByRequest.delete(request.requestId);
            await recordConfirmationOutcome(rowId, executionId, outcome);
        },
    };
}

/**
 * Close out a recorded confirmation and move its execution on.
 *
 * A run abandons its confirmations when it is stopped or interrupted; the row is no longer
 * actionable either way, so it retires as expired.
 */
async function recordConfirmationOutcome(
    confirmationId: string,
    executionId: string,
    outcome: ConfirmationOutcome,
): Promise<void> {
    const answered = outcome.status === 'answered';
    const selectedOptionId = answered ? outcome.response.selectedOptionId : undefined;
    // Guidance declines the operation but keeps the run going, so only a hard denial ends it.
    const proceeding = selectedOptionId === CONFIRMATION_OPTIONS.YES
        || selectedOptionId === CONFIRMATION_OPTIONS.YES_DONT_ASK
        || selectedOptionId === CONFIRMATION_OPTIONS.GUIDANCE;

    // The row is the lock between the two doors onto this confirmation: whichever answer
    // lands second leaves it already settled and stops here.
    const [settled] = await db.update(PendingConfirmation)
        .set(answered
            ? { status: proceeding ? 'approved' : 'denied', respondedAt: new Date() }
            : { status: 'expired' })
        .where(and(
            eq(PendingConfirmation.id, confirmationId),
            eq(PendingConfirmation.status, 'pending'),
        ))
        .returning({ id: PendingConfirmation.id });

    if (!settled || !answered) return;

    await db.update(AutomationExecution)
        .set(proceeding
            ? { status: 'running' }
            : { status: 'cancelled', completedAt: new Date(), errorMessage: 'User denied confirmation' })
        .where(eq(AutomationExecution.id, executionId));
}

/**
 * Get or create a conversation for the automation.
 * All runs of an automation persist to the same conversation.
 * Returns the conversation ID.
 */
async function getOrCreateAutomationConversation(
    automation: typeof Automation.$inferSelect,
    user: typeof User.$inferSelect
): Promise<string> {
    // If automation already has a conversation, use it
    if (automation.conversationId) {
        const [existing] = await db.select()
            .from(Conversation)
            .where(eq(Conversation.id, automation.conversationId));
        if (existing) {
            return existing.id;
        }
    }

    // Create a new conversation for this automation
    const conversation = await atifConversationService.createConversation(
        user,
        'pipali-automation',
        '1.0.0',
        'default',
        `Routine: ${automation.name}`,
        automation.chatModelId ?? undefined,
    );

    // Link the conversation to the automation (bidirectional)
    await db.update(Automation)
        .set({ conversationId: conversation.id })
        .where(eq(Automation.id, automation.id));

    await db.update(Conversation)
        .set({ automationId: automation.id })
        .where(eq(Conversation.id, conversation.id));

    return conversation.id;
}

/**
 * Run a single automation execution
 */
async function runExecution(
    executionId: string,
    automationId: string,
    triggerData: TriggerEventData,
    options?: { includeUserMessage?: boolean }
): Promise<void> {
    // Check if already running
    if (runningExecutions.has(automationId)) {
        log.info(`${automationId} already running, skipping`);
        return;
    }

    const running: { conversationId?: string } = {};
    runningExecutions.set(automationId, running);

    try {
        // Get automation details
        const [automation] = await db.select()
            .from(Automation)
            .where(eq(Automation.id, automationId));

        if (!automation) {
            log.error(`Not found: ${automationId}`);
            await markExecutionFailed(executionId, 'Automation not found');
            return;
        }

        // Get user for the automation
        const [user] = await db.select()
            .from(User)
            .where(eq(User.id, automation.userId));

        if (!user) {
            log.error(`User not found for: ${automationId}`);
            await markExecutionFailed(executionId, 'User not found');
            return;
        }

        // Update execution to running
        await db.update(AutomationExecution)
            .set({ status: 'running', startedAt: new Date() })
            .where(eq(AutomationExecution.id, executionId));

        log.info(`Starting execution ${executionId}`);

        // Get or create the automation's conversation
        const conversationId = await getOrCreateAutomationConversation(automation, user);
        running.conversationId = conversationId;

        // Build the prompt with trigger context
        const contextualPrompt = buildPromptWithContext(automation.prompt, triggerData);

        // Always create bus so WS observers can subscribe mid-run
        const bus = getOrCreateBus(conversationId);

        // Automations record their confirmations (24h window, answerable from the routines
        // page) on top of the bus every run publishes them on.
        const confirmationPersistence = createAutomationConfirmationPersistence(executionId);

        const runId = crypto.randomUUID();
        await executeRun({
            bus,
            conversationId,
            user,
            // When we retry an execution, avoid persisting duplicate user messages.
            // The initial attempt already wrote the user prompt into the conversation.
            userMessage: options?.includeUserMessage === false ? undefined : contextualPrompt,
            runId,
            clientMessageId: executionId,
            confirmationPreferences: createEmptyPreferences(),
            confirmationPersistence,
            // Unset follows the user's default, resolved per run rather than pinned here.
            chatModelId: automation.chatModelId ?? undefined,
        });

        // Update execution as completed
        await db.update(AutomationExecution)
            .set({
                status: 'completed',
                completedAt: new Date(),
            })
            .where(eq(AutomationExecution.id, executionId));

        // Update automation last executed time
        await db.update(Automation)
            .set({ lastExecutedAt: new Date() })
            .where(eq(Automation.id, automationId));

        log.info(`Execution ${executionId} completed`);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ err: error }, 'Execution error');

        // Check if it's a confirmation timeout - handle specially, don't retry
        if (errorMessage === 'Confirmation timeout expired') {
            await db.update(AutomationExecution)
                .set({
                    status: 'cancelled',
                    errorMessage: 'Confirmation timeout expired',
                    completedAt: new Date(),
                })
                .where(eq(AutomationExecution.id, executionId));
        }

        // Re-throw to let retry wrapper handle it
        throw error;

    } finally {
        runningExecutions.delete(automationId);
        processQueue(); // Check if more can run
    }
}

/**
 * Mark an execution as failed
 */
async function markExecutionFailed(executionId: string, errorMessage: string): Promise<void> {
    await db.update(AutomationExecution)
        .set({
            status: 'failed',
            errorMessage,
            completedAt: new Date(),
        })
        .where(eq(AutomationExecution.id, executionId));
}

/**
 * Answer a recorded confirmation, by its row id, from outside the run's conversation.
 *
 * The waiting run owns the promise, so the answer is handed to it on the bus and settles
 * the row through the same path a dialog's answer takes. Without a run still waiting -
 * the server restarted under it, or it moved on - only the record is closed out.
 */
export async function respondToConfirmation(
    confirmationId: string,
    response: ConfirmationResponse
): Promise<boolean> {
    const [pending] = await db.select({
        status: PendingConfirmation.status,
        request: PendingConfirmation.request,
        executionId: PendingConfirmation.executionId,
        conversationId: Automation.conversationId,
    })
        .from(PendingConfirmation)
        .innerJoin(AutomationExecution, eq(PendingConfirmation.executionId, AutomationExecution.id))
        .innerJoin(Automation, eq(AutomationExecution.automationId, Automation.id))
        .where(eq(PendingConfirmation.id, confirmationId));

    if (!pending) {
        log.error(`Confirmation not found: ${confirmationId}`);
        return false;
    }

    if (pending.status !== 'pending') {
        log.error(`Confirmation already processed: ${confirmationId}`);
        return false;
    }

    // Callers address the row; the run knows the request it raised.
    const answer: ConfirmationResponse = { ...response, requestId: pending.request.requestId };

    const bus = pending.conversationId ? getBus(pending.conversationId) : undefined;
    const runHandle = bus?.activeRun;
    if (bus && runHandle?.pendingConfirmations.has(answer.requestId)) {
        resolveConfirmationOnBus(bus, runHandle, answer);
        return true;
    }

    log.info(`Confirmation ${confirmationId} answered with no run waiting on it`);
    await recordConfirmationOutcome(confirmationId, pending.executionId, { status: 'answered', response: answer });
    return true;
}

/**
 * Get all pending confirmations for a user
 */
export async function getPendingConfirmations(userId: number): Promise<Array<{
    id: string;
    executionId: string;
    automationId: string;
    automationName: string;
    conversationId: string | null;
    request: ConfirmationRequest;
    expiresAt: Date;
}>> {
    const results = await db.select({
        id: PendingConfirmation.id,
        executionId: PendingConfirmation.executionId,
        request: PendingConfirmation.request,
        expiresAt: PendingConfirmation.expiresAt,
        automationId: Automation.id,
        automationName: Automation.name,
        conversationId: Automation.conversationId,
    })
        .from(PendingConfirmation)
        .innerJoin(AutomationExecution, eq(PendingConfirmation.executionId, AutomationExecution.id))
        .innerJoin(Automation, eq(AutomationExecution.automationId, Automation.id))
        .where(and(
            eq(Automation.userId, userId),
            eq(PendingConfirmation.status, 'pending')
        ));

    return results.map(r => ({
        id: r.id,
        executionId: r.executionId,
        automationId: r.automationId,
        automationName: r.automationName,
        conversationId: r.conversationId,
        request: r.request as ConfirmationRequest,
        expiresAt: r.expiresAt,
    }));
}

/**
 * Cancel a running execution.
 *
 * Stopping the run is what reaches its confirmations: a run blocked on one can only be
 * freed by rejecting it, which the shared stop path does.
 */
export function cancelExecution(automationId: string): boolean {
    const running = runningExecutions.get(automationId);
    if (!running) return false;

    // Free the slot immediately so a queued execution can take it.
    runningExecutions.delete(automationId);

    if (running.conversationId) stopConversationRun(running.conversationId);
    return true;
}

/**
 * Get number of running executions
 */
export function getRunningExecutionCount(): number {
    return runningExecutions.size;
}

/**
 * Get queue length
 */
export function getQueueLength(): number {
    return executionQueue.length;
}

/**
 * Clean up orphaned executions on server startup
 * Marks any executions stuck in 'running' or 'awaiting_confirmation' as cancelled
 * since they can't continue after a server restart (the async process was lost)
 */
export async function cleanupOrphanedExecutions(): Promise<number> {
    // Find executions that were interrupted by server restart
    const orphanedStatuses = ['running', 'awaiting_confirmation', 'pending'] as const;

    const result = await db.update(AutomationExecution)
        .set({
            status: 'cancelled',
            completedAt: new Date(),
            errorMessage: 'Execution interrupted by server restart',
        })
        .where(
            sql`${AutomationExecution.status} IN (${sql.join(orphanedStatuses.map(s => sql`${s}`), sql`, `)})`
        )
        .returning({ id: AutomationExecution.id });

    // Also clean up any pending confirmations for these executions
    if (result.length > 0) {
        await db.update(PendingConfirmation)
            .set({ status: 'expired' })
            .where(eq(PendingConfirmation.status, 'pending'));
    }

    if (result.length > 0) {
        log.info(`Cleaned up ${result.length} orphaned execution(s) from previous server instance`);
    }

    return result.length;
}
