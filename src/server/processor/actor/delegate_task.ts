/**
 * Delegation tools.
 *
 * A delegated task is a normal conversation marked with a parent, run asynchronously
 * through the same executor as any other conversation. The child conversation id is
 * the handle: it survives restarts and resolves the live run via the event bus.
 */

import { eq, inArray } from 'drizzle-orm';
import { db, getChatModelById, getDefaultChatModel } from '../../db';
import { Conversation, User } from '../../db/schema';
import { getBus, type ConversationEvent } from '../../events/conversation-event-bus';
import { startConversationRun, stopConversationRun } from '../../events/conversation-runs';
import { deliverToParent, suppressDeliveries } from '../../events/parent-inbox';
import { getActiveStatus } from '../../sessions/activeSessionsStore';
import { atifConversationService } from '../conversation/atif/atif.service';
import type { ATIFStep } from '../conversation/atif/atif.types';
import type { ConfirmationPreferences } from '../confirmation';
import { formatConversationHeader } from '../../../shared';
import { createChildLogger } from '../../logger';
import {
    PLATFORM_TIER_MODELS,
    type PlatformModelTier,
} from '../conversation';

const log = createChildLogger({ component: 'delegate_task' });

/**
 * Tasks ended through stop_task. Their run_stopped is the expected outcome rather than
 * news, so it is not reported back - the agent that asked already knows, and hearing
 * about it would wake the conversation to announce a stop it had just carried out.
 */
const stoppedOnPurpose = new Set<string>();
const STOP_MARK_TTL_MS = 30_000;

export interface DelegateTaskArgs {
    title: string;
    message: string;
    /** Omit to use the parent conversation's intelligence tier. */
    model_tier?: PlatformModelTier;
    /** Omit to start a new task; provide to send a follow-up to one already running. */
    conversation_id?: string;
    /** Default true. When false, the call waits and returns the task's result. */
    run_in_background?: boolean;
    /** Only meaningful when run_in_background is false. */
    timeout_seconds?: number;
}

export interface InspectTaskArgs {
    conversation_id: string;
    detail?: 'latest' | 'outline' | 'full';
}

export interface StopTaskArgs {
    conversation_id: string;
}

export interface WaitForTasksArgs {
    conversation_ids: string[];
    timeout_seconds?: number;
}

export interface DelegationResult {
    compiled: string;
}

export function selectDelegatedModelAlias(
    requestedTier: PlatformModelTier | undefined,
    parentTier: PlatformModelTier | null | undefined,
): string | undefined {
    const tier = requestedTier ?? parentTier;
    return tier ? PLATFORM_TIER_MODELS[tier] : undefined;
}

function errorResult(message: string): DelegationResult {
    return { compiled: `Error: ${message}` };
}

/**
 * Identifying detail for a tool call, never its payload.
 *
 * Mirrors the client's collapsed trajectory view (formatToolCallsForSidebar): a file
 * name rather than file content, a justification rather than a shell script. Unknown
 * and MCP tools fall through to name-only so their unbounded arguments can't leak in.
 */
const MAX_ARG_CHARS = 200;

export function summarizeToolCall(functionName: string, args: Record<string, unknown>): string {
    const pick = (key: string): string | undefined => {
        const value = args?.[key];
        if (typeof value !== 'string' || !value.trim()) return undefined;
        return value.length > MAX_ARG_CHARS ? `${value.slice(0, MAX_ARG_CHARS)}…` : value;
    };

    let detail: string | undefined;
    switch (functionName) {
        case 'view_file':
        case 'read_file':
        case 'list_files':
            detail = pick('path');
            break;
        case 'edit_file':
        case 'write_file':
            detail = pick('file_path');
            break;
        case 'grep_files':
            detail = pick('pattern');
            break;
        case 'shell_command':
            detail = pick('justification');
            break;
        case 'search_web':
            detail = pick('query');
            break;
        case 'read_webpage':
            detail = pick('url');
            break;
        case 'generate_image':
            detail = pick('prompt');
            break;
        case 'delegate_task':
        case 'inspect_task':
        case 'stop_task':
        case 'wait_for_tasks':
            detail = pick('title') ?? pick('conversation_id');
            break;
    }

    return detail ? `${functionName}(${detail})` : functionName;
}

function describeStep(step: ATIFStep): string {
    const parts: string[] = [];
    if (step.message) parts.push(`Message: ${step.message}`);
    const toolCalls = step.tool_calls ?? [];
    if (toolCalls.length > 0) {
        const summarized = toolCalls.map(tc => summarizeToolCall(tc.function_name, tc.arguments ?? {}));
        parts.push(`Tools: ${summarized.join(', ')}`);
    }
    return parts.join('\n');
}

function describeStatus(conversationId: string): string {
    const status = getActiveStatus(conversationId);
    if (!status?.isActive) return 'completed or idle';
    const bus = getBus(conversationId);
    if ((bus?.activeRun?.pendingConfirmations.size ?? 0) > 0) {
        return 'running, waiting on user confirmation';
    }
    return 'running';
}

/**
 * Start a task, or send a follow-up to one already running.
 *
 * In the background (the default) this returns once the run is under way and the result
 * arrives later as a message in the parent. In the foreground it waits and returns the
 * result itself.
 */
export async function delegateTask(
    args: DelegateTaskArgs,
    options: {
        user?: typeof User.$inferSelect;
        parentConversationId?: string;
        confirmationPreferences?: ConfirmationPreferences;
        abortSignal?: AbortSignal;
        parentChatModelId?: number;
    },
): Promise<DelegationResult> {
    const { user, parentConversationId } = options;
    if (!user) return errorResult('Cannot delegate - no user context available');
    if (!parentConversationId) return errorResult('Cannot delegate - no parent conversation');
    if (!args?.message?.trim()) return errorResult('message is required');

    const targetId = args.conversation_id;
    if (targetId) {
        const [existing] = await db.select().from(Conversation).where(eq(Conversation.id, targetId));
        if (!existing || existing.userId !== user.id) return errorResult(`Conversation ${targetId} not found`);
    }

    try {
        const parentModel = options.parentChatModelId !== undefined
            ? await getChatModelById(options.parentChatModelId)
            : await getDefaultChatModel(user);
        const chatModelAlias = parentModel?.aiModelApi?.name === 'Pipali'
            ? selectDelegatedModelAlias(args.model_tier, parentModel.chatModel.tier)
            : undefined;

        const result = await startConversationRun({
            user,
            message: args.message,
            conversationId: targetId,
            title: args.title,
            parentConversationId,
            chatModelId: parentModel?.chatModel.id,
            chatModelAlias,
            // Inherit as a copy: what the user already approved carries over, but the
            // child saying "don't ask again" must not rewrite the parent's policy.
            confirmationPreferences: options.confirmationPreferences
                ? { skipConfirmationFor: new Set(options.confirmationPreferences.skipConfirmationFor) }
                : undefined,
            // Subscribed before the run starts. Subscribing afterwards would lose the
            // result of a task that finishes quickly.
            onEvent: createDelegatedRunWatcher(parentConversationId, user, args.title),
        });

        log.info({
            childConversationId: result.conversationId,
            parentConversationId,
            queued: result.queued,
            background: args.run_in_background !== false,
        }, 'Delegated task started');

        // Foreground: hold the turn and hand back the result, so "do this and tell me
        // what you find" is one tool call rather than delegate-then-wait.
        if (args.run_in_background === false) {
            return await waitForTasks(
                { conversation_ids: [result.conversationId], timeout_seconds: args.timeout_seconds },
                { user, abortSignal: options.abortSignal, parentConversationId },
            );
        }

        return {
            compiled: JSON.stringify({
                status: 'started',
                conversation_id: result.conversationId,
            }),
        };
    } catch (error) {
        log.error({ err: error, parentConversationId }, 'Failed to delegate task');
        return errorResult(error instanceof Error ? error.message : String(error));
    }
}

/**
 * Forward a delegated run's outcome to the conversation that started it.
 *
 * The final response is passed through in full - it is the point of the task. Progress
 * is not forwarded; the parent can poll with inspect_task if it wants detail.
 */
function createDelegatedRunWatcher(
    parentConversationId: string,
    user: typeof User.$inferSelect,
    title: string,
): (event: ConversationEvent) => void {
    let done = false;

    return (event: ConversationEvent) => {
        if (done) return;
        const childConversationId = event.conversationId;

        if (event.type === 'run_complete') {
            done = true;
            void deliverToParent({
                parentConversationId,
                user,
                message: [
                    `[Delegated task completed] ${title}`,
                    `Conversation: ${childConversationId}`,
                    '',
                    event.data.response || '(no final response)',
                ].join('\n'),
            });
        } else if (event.type === 'run_stopped') {
            done = true;
            if (childConversationId && stoppedOnPurpose.delete(childConversationId)) return;

            const reason = event.error ? `${event.reason}: ${event.error}` : event.reason;
            void deliverToParent({
                parentConversationId,
                user,
                message: [
                    `[Delegated task did not finish] ${title}`,
                    `Conversation: ${childConversationId}`,
                    `Reason: ${reason}`,
                ].join('\n'),
            });
        } else if (event.type === 'confirmation_request') {
            void deliverToParent({
                parentConversationId,
                user,
                message: [
                    `[Delegated task needs user input] ${title}`,
                    `Conversation: ${childConversationId}`,
                    `Waiting on: ${event.data.title}`,
                ].join('\n'),
            });
        } else if (event.type === 'billing_error' || event.type === 'auth_error') {
            // Nothing to report and nothing to retry - the parent would hit the same wall.
            done = true;
        }
    };
}

/**
 * Read another conversation. Returns immediately - tools in an iteration must all
 * settle before the model sees any of them, so this must never wait on a run.
 */
export async function inspectTask(
    args: InspectTaskArgs,
    options: { user?: typeof User.$inferSelect },
): Promise<DelegationResult> {
    const { user } = options;
    if (!user) return errorResult('Cannot inspect - no user context available');
    if (!args?.conversation_id) return errorResult('conversation_id is required');

    const conversation = await atifConversationService.getConversation(args.conversation_id);
    if (!conversation || conversation.userId !== user.id) {
        return errorResult(`Conversation ${args.conversation_id} not found`);
    }

    const detail = args.detail ?? 'latest';
    const steps = conversation.trajectory.steps.filter(step => step.source !== 'system');
    const status = describeStatus(args.conversation_id);
    const header = [
        formatConversationHeader(args.conversation_id),
        `Title: ${conversation.title ?? '(untitled)'}`,
        `Status: ${status}`,
    ];

    if (detail === 'full') {
        return {
            compiled: [
                ...header,
                `Steps: ${steps.length}`,
                '',
                'Conversations can be long, rather than reading it all at once, query the local API and efficiently select just what you need.',
                `Call GET /api/chat/${args.conversation_id}/history on your own server (default: http://localhost:6464).`,
                'See the introspect skill for more details.',
                '',
                'Most recent steps:',
                ...steps.slice(-3).map(describeStep),
            ].join('\n'),
        };
    }

    const lastStep = steps[steps.length - 1];
    if (!lastStep) {
        return { compiled: [...header, 'No steps yet.'].join('\n') };
    }

    // Once a task has finished, its final response is the answer - lead with it whole
    // rather than with the mechanics of how it got there.
    const isActive = getActiveStatus(args.conversation_id)?.isActive ?? false;
    if (!isActive) {
        const finalResponse = [...steps].reverse().find(s => s.source === 'agent' && s.message)?.message;
        if (finalResponse) {
            return { compiled: [...header, '', 'Final response:', finalResponse].join('\n') };
        }
    }

    if (detail === 'latest') {
        return { compiled: [...header, '', describeStep(lastStep)].join('\n') };
    }

    const lastUserIndex = steps.findLastIndex(s => s.source === 'user');
    const turn = lastUserIndex >= 0 ? steps.slice(lastUserIndex) : steps.slice(-5);
    return {
        compiled: [
            ...header,
            '',
            ...turn.map(describeStep).filter(Boolean),
        ].join('\n\n'),
    };
}

/** Default and ceiling for how long the agent will sit waiting on delegated work. */
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1800;

/**
 * Block until delegated tasks finish, then return their results.
 *
 * Without this the agent has to keep taking a step to stay alive while work runs, and
 * invents busywork to fill the time. Waiting is the honest thing to do when the next
 * action genuinely depends on a result.
 *
 * The wait releases early if the run is stopped or the user sends a message, so it never
 * traps the conversation.
 */
export async function waitForTasks(
    args: WaitForTasksArgs,
    options: { user?: typeof User.$inferSelect; abortSignal?: AbortSignal; parentConversationId?: string },
): Promise<DelegationResult> {
    const { user, abortSignal, parentConversationId } = options;
    if (!user) return errorResult('Cannot wait - no user context available');

    const ids = args?.conversation_ids ?? [];
    if (ids.length === 0) return errorResult('conversation_ids is required');

    const owned = await db.select({ id: Conversation.id, userId: Conversation.userId })
        .from(Conversation)
        .where(inArray(Conversation.id, ids));
    const ownedIds = new Set(owned.filter(c => c.userId === user.id).map(c => c.id));
    const unknown = ids.filter(id => !ownedIds.has(id));
    if (unknown.length > 0) return errorResult(`Conversation(s) not found: ${unknown.join(', ')}`);

    const timeoutMs = Math.min(
        Math.max(args.timeout_seconds ?? DEFAULT_WAIT_SECONDS, 1),
        MAX_WAIT_SECONDS,
    ) * 1000;

    // The results are handed straight to the model below, so don't also append them to
    // this conversation and wake it again once the wait ends.
    const release = parentConversationId ? suppressDeliveries(parentConversationId) : () => undefined;

    // One controller decides when to stop waiting, so every per-task wait unwinds together.
    const stopWaiting = new AbortController();
    const giveUp = () => stopWaiting.abort();
    const timer = setTimeout(giveUp, timeoutMs);
    abortSignal?.addEventListener('abort', giveUp, { once: true });

    // A user message mid-wait sets stopMode without aborting the run, so watch for it -
    // otherwise the user would be stuck behind the timeout before being answered.
    const watchInterrupt = setInterval(() => {
        const activeRun = parentConversationId ? getBus(parentConversationId)?.activeRun : undefined;
        if (activeRun && activeRun.stopMode !== 'none') giveUp();
    }, 250);

    try {
        await Promise.all(ids.map(id => waitForOne(id, stopWaiting.signal)));
    } finally {
        clearTimeout(timer);
        clearInterval(watchInterrupt);
        abortSignal?.removeEventListener('abort', giveUp);
        release();
    }

    const summaries = await Promise.all(ids.map(async id => {
        const result = await inspectTask({ conversation_id: id, detail: 'latest' }, { user });
        return result.compiled;
    }));

    return { compiled: summaries.join('\n\n---\n\n') };
}

/** Resolves when this conversation's run settles, or when the caller stops waiting. */
function waitForOne(conversationId: string, stopWaiting: AbortSignal): Promise<void> {
    const bus = getBus(conversationId);
    if (!bus?.activeRun || stopWaiting.aborted) return Promise.resolve();

    return new Promise<void>(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            unsubscribe();
            stopWaiting.removeEventListener('abort', finish);
            resolve();
        };

        stopWaiting.addEventListener('abort', finish, { once: true });

        const unsubscribe = bus.subscribe(event => {
            if (
                event.type === 'run_complete'
                || event.type === 'run_stopped'
                || event.type === 'billing_error'
                || event.type === 'auth_error'
            ) {
                finish();
            }
        });
    });
}

/** Hard stop a conversation's run. */
export async function stopTask(
    args: StopTaskArgs,
    options: { user?: typeof User.$inferSelect },
): Promise<DelegationResult> {
    const { user } = options;
    if (!user) return errorResult('Cannot stop - no user context available');
    if (!args?.conversation_id) return errorResult('conversation_id is required');

    const [conversation] = await db.select().from(Conversation).where(eq(Conversation.id, args.conversation_id));
    if (!conversation || conversation.userId !== user.id) {
        return errorResult(`Conversation ${args.conversation_id} not found`);
    }

    const conversationId = args.conversation_id;
    const stopped = stopConversationRun(conversationId);
    if (stopped) {
        stoppedOnPurpose.add(conversationId);
        // The run_stopped that clears this normally lands within milliseconds. Expire it
        // anyway: a stale entry would swallow the next real failure this task reports.
        setTimeout(() => stoppedOnPurpose.delete(conversationId), STOP_MARK_TTL_MS).unref?.();
    }
    return {
        compiled: stopped
            ? `Stopped conversation ${args.conversation_id}.`
            : `Conversation ${args.conversation_id} had no run in progress.`,
    };
}
