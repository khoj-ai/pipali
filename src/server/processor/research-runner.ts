/**
 * Shared Research Runner
 *
 * This module provides a shared function for running research with conversation persistence.
 * It's used by:
 * - api.ts: Simple non-streaming research
 * - ws.ts: Streaming research with callbacks
 * - automation executor: Automation-triggered research
 *
 * This consolidates the common pattern of:
 * 1. Loading conversation from DB
 * 2. Running the research loop
 * 3. Adding ATIF steps for each iteration
 * 4. Handling the final response
 */

import { User } from '../db/schema';
import { research, ResearchPausedError } from './director';
import { atifConversationService } from './conversation/atif/atif.service';
import { addStepToTrajectory } from './conversation/atif/atif.utils';
import { maxIterations as defaultMaxIterations } from '../utils';
import { loadUserContext } from '../user-context';
import type { ResearchIteration } from './director/types';
import type { ConfirmationContext } from './confirmation';

export { ResearchPausedError };

export interface ResearchRunnerOptions {
    /** The conversation ID to run research on */
    conversationId: string;
    /** The user running the research */
    user: typeof User.$inferSelect;
    /** User message to add before running research */
    userMessage?: string;
    /** Maximum number of iterations (default: from utils) */
    maxIterations?: number;
    /** Abort signal for pause support */
    abortSignal?: AbortSignal;
    /** Confirmation context for dangerous operations */
    confirmationContext?: ConfirmationContext;
    /** Callback when tool calls are about to start (before execution) */
    onToolCallStart?: (iteration: ResearchIteration) => void;
    /** Callback when an iteration completes (after execution) */
    onIteration?: (iteration: ResearchIteration) => void;
    /** Callback to update reasoning/thought display */
    onReasoning?: (thought: string) => void;
}

export interface ResearchRunnerResult {
    /** The final response text */
    response: string;
    /** Number of iterations completed */
    iterationCount: number;
    /** The conversation ID */
    conversationId: string;
}

/**
 * Run research on a conversation and persist results to DB.
 *
 * This is an async generator that yields iterations as they complete.
 * The final result can be obtained by consuming all iterations.
 *
 * @example
 * // Simple usage (api.ts style)
 * const runner = runResearchWithConversation({ conversationId, user });
 * let result: ResearchRunnerResult | undefined;
 * for await (const iteration of runner) {
 *   // Optionally process iterations
 * }
 * result = runner.result;
 *
 * @example
 * // Streaming usage (ws.ts style)
 * const runner = runResearchWithConversation({
 *   conversationId,
 *   user,
 *   onToolCallStart: (iter) => sendToClient({ type: 'tool_call_start', data: iter }),
 *   onIteration: (iter) => sendToClient({ type: 'iteration', data: iter }),
 * });
 * for await (const iteration of runner) {
 *   // Iterations are handled via callbacks
 * }
 */
export async function* runResearchWithConversation(
    options: ResearchRunnerOptions
): AsyncGenerator<ResearchIteration, ResearchRunnerResult> {
    const {
        conversationId,
        user,
        userMessage,
        maxIterations = defaultMaxIterations,
        abortSignal,
        confirmationContext,
        onToolCallStart,
        onIteration,
        onReasoning,
    } = options;

    // Load conversation from DB
    const conversation = await atifConversationService.getConversation(conversationId);

    if (!conversation) {
        throw new Error('Conversation not found');
    }

    const trajectory = conversation.trajectory;

    // Check if this is a new conversation (no system prompt yet) or existing
    const isNewConversation = !trajectory.steps.some(s => s.source === 'system');

    // For existing conversations, persist user message immediately.
    // For new conversations, we add to in-memory first, then persist after system prompt.
    if (userMessage) {
        if (isNewConversation) {
            // Add to in-memory only - will persist after system prompt for correct ordering
            addStepToTrajectory(trajectory, 'user', userMessage);
        } else {
            // Existing conversation - persist immediately
            const userStep = await atifConversationService.addStep(
                conversationId,
                'user',
                userMessage,
            );
            trajectory.steps.push(userStep);
        }
    }

    let finalResponse = '';
    let finalThought: ResearchIteration['thought'];
    let finalMetrics: ResearchIteration['metrics'];
    let finalRaw: ResearchIteration['raw'];
    let iterationCount = 0;
    let systemPromptPersisted = false;

    // Load user context for personalization
    const userContext = await loadUserContext();

    // Run research loop
    for await (const iteration of research({
        chatHistory: trajectory,
        maxIterations,
        currentDate: new Date().toLocaleDateString('en-CA'), // YYYY-MM-DD in local time
        dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
        username: userContext.name,
        location: userContext.location,
        personality: userContext.instructions,
        user,
        abortSignal,
        confirmationContext,
    })) {
        iterationCount++;

        // On first iteration (new conversation), persist system prompt and user message to DB
        // System prompt is persisted first to maintain correct ordering: system → user → agent
        if (iteration.systemPrompt && !systemPromptPersisted) {
            const systemStep = await atifConversationService.addStep(
                conversationId,
                'system',
                iteration.systemPrompt,
            );
            // Insert system prompt at start of in-memory trajectory
            trajectory.steps.unshift(systemStep);

            // Now persist the user message (which was added to in-memory earlier)
            if (userMessage) {
                const userStep = await atifConversationService.addStep(
                    conversationId,
                    'user',
                    userMessage,
                );
                // Replace the temporary in-memory user step with the DB version
                const userStepIndex = trajectory.steps.findLastIndex(s => s.source === 'user');
                if (userStepIndex >= 0) {
                    trajectory.steps[userStepIndex] = userStep;
                }
            }
            systemPromptPersisted = true;
        }

        // Update reasoning if callback provided
        if (iteration.thought && onReasoning) {
            onReasoning(iteration.thought);
        }

        // Handle tool call start (before execution)
        if (iteration.isToolCallStart) {
            if (onToolCallStart) {
                onToolCallStart(iteration);
            }
            yield iteration;
            continue;
        }

        // Check for text tool (final response)
        const textTool = iteration.toolCalls.find(tc => tc.function_name === 'text');
        if (textTool) {
            finalResponse = textTool.arguments.response || '';
            finalThought = iteration.thought;
            finalMetrics = iteration.metrics;
            finalRaw = iteration.raw;

            // If there's a thought with the final response, yield it for display
            if (iteration.thought || iteration.message) {
                const thoughtIteration: ResearchIteration = {
                    thought: iteration.thought,
                    message: iteration.message,
                    toolCalls: [],
                    toolResults: [],
                };
                if (onIteration) {
                    onIteration(thoughtIteration);
                }
                yield thoughtIteration;
            }
            // Don't add the text tool as a step, we'll add it as the final response
        } else if (iteration.toolCalls.length > 0 && iteration.toolResults) {
            // Persist to DB and update in-memory trajectory so the director sees it in the next iteration
            const agentStep = await atifConversationService.addStep(
                conversationId,
                'agent',
                iteration.message ?? '',
                iteration.metrics,
                iteration.toolCalls,
                { results: iteration.toolResults },
                iteration.thought,
                iteration.raw,
            );
            trajectory.steps.push(agentStep);

            if (onIteration) {
                onIteration(iteration);
            }
            yield iteration;
        }
    }

    // If no final response was generated, create a fallback
    if (!finalResponse) {
        finalResponse = 'Failed to generate response.';
    }

    // Add final response as the last agent step
    await atifConversationService.addStep(
        conversationId,
        'agent',
        finalResponse,
        finalMetrics,
        undefined,
        undefined,
        finalThought,
        finalRaw,
    );

    return {
        response: finalResponse,
        iterationCount,
        conversationId,
    };
}

/**
 * Simplified version that runs research to completion and returns the result.
 * Use this when you don't need to process individual iterations.
 *
 * @example
 * const result = await runResearchToCompletion({ conversationId, user });
 * console.log(result.response);
 */
export async function runResearchToCompletion(
    options: ResearchRunnerOptions
): Promise<ResearchRunnerResult> {
    const generator = runResearchWithConversation(options);

    // Consume all iterations
    let result: IteratorResult<ResearchIteration, ResearchRunnerResult>;
    do {
        result = await generator.next();
    } while (!result.done);

    return result.value;
}
