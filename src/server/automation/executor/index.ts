/**
 * Automation Executor
 *
 * Manages execution queue and runs automations using the research loop.
 * Handles concurrency, rate limiting, retry logic, and execution tracking.
 */

import { db } from '../../db';
import { Automation, AutomationExecution, Conversation, PendingConfirmation, User } from '../../db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import { runResearchToCompletion } from '../../processor/research-runner';
import { atifConversationService } from '../../processor/conversation/atif/atif.service';
import type { TriggerEventData } from '../types';
import type { ConfirmationContext } from '../../processor/confirmation';
import { createEmptyPreferences } from '../../processor/confirmation';
import type { ConfirmationRequest, ConfirmationResponse } from '../../processor/confirmation/confirmation.types';
import { createStandardConfirmationOptions } from '../../processor/confirmation/confirmation.types';

// Max concurrent executions
const MAX_CONCURRENT = 3;

// Retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAYS = [15000, 30000]; // 15s, 30s

// Confirmation timeout (24 hours)
const CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Execution queue (in-memory for MVP)
interface QueuedExecution {
    automationId: string;
    triggerData: TriggerEventData;
    executionId: string;
}

const executionQueue: QueuedExecution[] = [];

// Currently running executions
const runningExecutions = new Map<string, AbortController>();

// Pending confirmations waiting for user response
const pendingConfirmations = new Map<string, {
    resolve: (response: ConfirmationResponse) => void;
    reject: (error: Error) => void;
    executionId: string;
}>();

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
            console.log(`[Automation] Rate limit exceeded (hourly) for ${automation.id}`);
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
            console.log(`[Automation] Rate limit exceeded (daily) for ${automation.id}`);
            return false;
        }
    }

    return true;
}

/**
 * Queue an automation for execution
 */
export async function queueExecution(
    automationId: string,
    triggerData: TriggerEventData
): Promise<string | null> {
    console.log(`[Automation] Queuing execution for ${automationId}`);

    // Get automation to check rate limits
    const [automation] = await db.select()
        .from(Automation)
        .where(eq(Automation.id, automationId));

    if (!automation) {
        console.error(`[Automation] Not found: ${automationId}`);
        return null;
    }

    if (automation.status !== 'active') {
        console.log(`[Automation] Skipping inactive automation: ${automationId}`);
        return null;
    }

    // Check rate limits
    const withinLimits = await checkRateLimits(automation);
    if (!withinLimits) {
        return null;
    }

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
        console.error(`[Automation] Failed to create execution record for ${automationId}`);
        return null;
    }

    executionQueue.push({
        automationId,
        triggerData,
        executionId: execution.id,
    });

    // Process queue (non-blocking)
    processQueue();

    return execution.id;
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

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            await runExecution(executionId, automationId, triggerData);
            return; // Success - exit retry loop
        } catch (error) {
            lastError = error as Error;
            const errorMessage = lastError.message;

            // Don't retry for certain error types
            if (
                errorMessage === 'Confirmation timeout expired' ||
                errorMessage === 'Automation not found' ||
                errorMessage === 'User not found'
            ) {
                console.log(`[Automation] Non-retryable error for ${executionId}: ${errorMessage}`);
                return;
            }

            // Update retry count in DB
            await db.update(AutomationExecution)
                .set({ retryCount: attempt + 1 })
                .where(eq(AutomationExecution.id, executionId));

            if (attempt < MAX_RETRIES) {
                const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
                console.log(`[Automation] Retry ${attempt + 1}/${MAX_RETRIES} for ${executionId} in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // All retries failed
    console.error(`[Automation] All retries failed for ${executionId}:`, lastError);
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
 * Create confirmation context that queues confirmations for user approval
 */
function createAutomationConfirmationContext(executionId: string): ConfirmationContext {
    // Create preferences for this automation execution
    // Automations start with empty preferences (always ask for confirmation)
    const preferences = createEmptyPreferences();

    return {
        preferences,
        requestConfirmation: async (request: ConfirmationRequest): Promise<ConfirmationResponse> => {
            console.log(`[Automation] Confirmation requested for execution ${executionId}`);

            // Update execution status
            await db.update(AutomationExecution)
                .set({ status: 'awaiting_confirmation' })
                .where(eq(AutomationExecution.id, executionId));

            // Use standard options (guidance is now sent independently via the guidance field)
            const automationRequest: ConfirmationRequest = {
                ...request,
                options: createStandardConfirmationOptions(),
            };

            // Store pending confirmation in database
            const expiresAt = new Date(Date.now() + CONFIRMATION_TIMEOUT_MS);
            const insertResult = await db.insert(PendingConfirmation)
                .values({
                    executionId,
                    request: automationRequest,
                    status: 'pending',
                    expiresAt,
                })
                .returning();

            const pendingConfirmation = insertResult[0];
            if (!pendingConfirmation) {
                throw new Error('Failed to create pending confirmation');
            }

            // Create promise that will be resolved when user responds
            return new Promise((resolve, reject) => {
                pendingConfirmations.set(pendingConfirmation.id, {
                    resolve,
                    reject,
                    executionId,
                });

                // Set timeout for expiration
                setTimeout(async () => {
                    const pending = pendingConfirmations.get(pendingConfirmation.id);
                    if (pending) {
                        pendingConfirmations.delete(pendingConfirmation.id);

                        // Update database
                        await db.update(PendingConfirmation)
                            .set({ status: 'expired' })
                            .where(eq(PendingConfirmation.id, pendingConfirmation.id));

                        pending.reject(new Error('Confirmation timeout expired'));
                    }
                }, CONFIRMATION_TIMEOUT_MS);
            });
        },
    };
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
        'panini-automation',
        '1.0.0',
        'default',
        `Automation: ${automation.name}`
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
    triggerData: TriggerEventData
): Promise<void> {
    // Check if already running
    if (runningExecutions.has(automationId)) {
        console.log(`[Automation] ${automationId} already running, skipping`);
        return;
    }

    const abortController = new AbortController();
    runningExecutions.set(automationId, abortController);

    try {
        // Get automation details
        const [automation] = await db.select()
            .from(Automation)
            .where(eq(Automation.id, automationId));

        if (!automation) {
            console.error(`[Automation] Not found: ${automationId}`);
            await markExecutionFailed(executionId, 'Automation not found');
            return;
        }

        // Get user for the automation
        const [user] = await db.select()
            .from(User)
            .where(eq(User.id, automation.userId));

        if (!user) {
            console.error(`[Automation] User not found for: ${automationId}`);
            await markExecutionFailed(executionId, 'User not found');
            return;
        }

        // Update execution to running
        await db.update(AutomationExecution)
            .set({ status: 'running', startedAt: new Date() })
            .where(eq(AutomationExecution.id, executionId));

        console.log(`[Automation] Starting execution ${executionId}`);

        // Get or create the automation's conversation
        const conversationId = await getOrCreateAutomationConversation(automation, user);

        // Build the prompt with trigger context
        const contextualPrompt = buildPromptWithContext(automation.prompt, triggerData);

        // Add the automation prompt as user message to the conversation
        await atifConversationService.addStep(
            conversationId,
            'user',
            contextualPrompt
        );

        // Create confirmation context for this execution
        const confirmationContext = createAutomationConfirmationContext(executionId);

        // Run research using the shared runner
        const result = await runResearchToCompletion({
            conversationId,
            user,
            maxIterations: automation.maxIterations,
            abortSignal: abortController.signal,
            confirmationContext,
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

        console.log(`[Automation] Execution ${executionId} completed (${result.iterationCount} iterations)`);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[Automation] Execution error:`, error);

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
 * Respond to a pending confirmation
 */
export async function respondToConfirmation(
    confirmationId: string,
    response: ConfirmationResponse
): Promise<boolean> {
    // Check if it exists in DB first
    const [dbPending] = await db.select()
        .from(PendingConfirmation)
        .where(eq(PendingConfirmation.id, confirmationId));

    if (!dbPending) {
        console.error(`[Automation] Confirmation not found: ${confirmationId}`);
        return false;
    }

    if (dbPending.status !== 'pending') {
        console.error(`[Automation] Confirmation already processed: ${confirmationId}`);
        return false;
    }

    // Determine status based on response
    const isApproved = response.selectedOptionId === 'yes' || response.selectedOptionId === 'yes_dont_ask';
    const hasGuidance = response.selectedOptionId === 'guidance';
    const confirmationStatus = isApproved || hasGuidance ? 'approved' : 'denied';

    await db.update(PendingConfirmation)
        .set({
            status: confirmationStatus,
            respondedAt: new Date(),
        })
        .where(eq(PendingConfirmation.id, confirmationId));

    // Update execution status based on response
    if (isApproved || hasGuidance) {
        // Either approved or has guidance - continue execution
        await db.update(AutomationExecution)
            .set({ status: 'running' })
            .where(eq(AutomationExecution.id, dbPending.executionId));
    } else {
        // Hard denial - mark execution as cancelled
        await db.update(AutomationExecution)
            .set({ status: 'cancelled', completedAt: new Date(), errorMessage: 'User denied confirmation' })
            .where(eq(AutomationExecution.id, dbPending.executionId));
    }

    // If we have an in-memory promise waiting, resolve it
    const pending = pendingConfirmations.get(confirmationId);
    if (pending) {
        pendingConfirmations.delete(confirmationId);
        pending.resolve(response);
    } else {
        // Server may have restarted - the execution is orphaned but DB is updated
        console.log(`[Automation] Confirmation ${confirmationId} responded but no in-memory promise (server restart?)`);
    }

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
        request: r.request as ConfirmationRequest,
        expiresAt: r.expiresAt,
    }));
}

/**
 * Cancel a running execution
 */
export function cancelExecution(automationId: string): boolean {
    const controller = runningExecutions.get(automationId);
    if (controller) {
        controller.abort();
        return true;
    }
    return false;
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
        console.log(`[Automation] Cleaned up ${result.length} orphaned execution(s) from previous server instance`);
    }

    return result.length;
}
