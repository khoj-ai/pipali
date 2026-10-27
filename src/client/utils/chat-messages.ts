import type { ATIFStep } from '../../server/processor/conversation/atif/atif.types';
import { PARENT_INBOX_KINDS, isAgentAnswer } from '../../shared';
import type { Message, Thought } from '../types';
import { generateDeterministicId, generateUUID } from './formatting';

export function isNumericIdString(value: string): boolean {
    return /^\d+$/.test(value);
}

export interface ChatHistory {
    messages: Message[];
    /** True while the last turn waits on its answer, even before its run records a step */
    turnOpen: boolean;
}

/**
 * Rebuild the chat from persisted steps. A turn opens at a user message, or at a report
 * from background work that arrives with no turn open, since that wakes the conversation.
 * It closes at its answer: the one step a run records without tool calls, last.
 */
export function buildChatHistory(steps: ATIFStep[], recalledMemoriesLabel: (count: number) => string): ChatHistory {
    const messages: Message[] = [];
    let currentAgentMessage: Message | null = null;
    let thoughts: Thought[] = [];
    let firstAgentStepId: string | null = null;
    // A run is bracketed by the step that started it and its own last step.
    let runStartedAt: string | undefined;
    let lastAgentTimestamp: string | undefined;
    let lastAnswerAt: string | undefined;
    let turnOpen = false;

    const finalizeCurrentAgent = (isUnanswered = false) => {
        if (currentAgentMessage) {
            if (thoughts.length > 0) {
                currentAgentMessage.thoughts = thoughts;
            }
            currentAgentMessage.startedAt = runStartedAt;
            currentAgentMessage.createdAt = lastAgentTimestamp;
            messages.push(currentAgentMessage);
        } else if (thoughts.length > 0) {
            // Use the first agent step_id for orphaned thoughts so deletion works
            const msgId = firstAgentStepId ?? generateUUID();
            messages.push({
                role: 'assistant',
                content: '',
                thoughts: thoughts,
                id: msgId,
                stableId: msgId,
                startedAt: runStartedAt,
                createdAt: lastAgentTimestamp,
                ...(isUnanswered ? { isUnanswered } : {}),
            });
        }
        thoughts = [];
        currentAgentMessage = null;
        firstAgentStepId = null;
        lastAgentTimestamp = undefined;
    };

    for (const msg of steps) {
        // Memories recalled for this turn - render collapsed, like compaction.
        // Blockquoted so bold lines inside memory bodies don't read as new thought headings.
        if (msg.source === 'system' && msg.extra?.kind === 'memory_recall') {
            const recalled = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message);
            const count = Array.isArray(msg.extra?.memory_paths) ? msg.extra.memory_paths.length : 0;
            const quoted = recalled
                .replace(/^# Memory recalled\n/, '')
                .split('\n')
                .map((line: string) => line ? `> ${line}` : '>')
                .join('\n');
            thoughts.push({
                type: 'thought',
                content: `**${recalledMemoriesLabel(count)}**\n${quoted}`,
                id: generateDeterministicId('memory-recall', recalled),
                isInternalThought: true,
            });
            continue;
        }

        if (msg.source === 'system' && PARENT_INBOX_KINDS.some(kind => kind === msg.extra?.kind)) {
            if (!turnOpen) {
                finalizeCurrentAgent();
                // A moved update keeps when it arrived, which can be before the answer it now follows
                runStartedAt = lastAnswerAt && Date.parse(lastAnswerAt) > Date.parse(msg.timestamp) ? lastAnswerAt : msg.timestamp;
                turnOpen = true;
            }
            continue;
        }

        if (msg.source === 'user') {
            // Check if this is a compaction step - render as thought instead of user message
            if (msg.extra?.is_compaction === true) {
                // Add compaction summary as a thought for the next agent message
                const summaryContent = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message);
                const content = `**Compact Context.**\n${summaryContent}`;
                thoughts.push({
                    type: 'thought',
                    content: content,
                    id: generateDeterministicId('compaction', content),
                    isInternalThought: true,
                });
                continue;
            }
            finalizeCurrentAgent();
            const rawContent = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message);
            const attachMatch = rawContent.match(/\n\n<attached_files>\n([\s\S]*?)\n<\/attached_files>$/);
            const attachedFiles = attachMatch
                ? attachMatch[1]!.split('\n').map((line: string) => line.replace(/^- /, '').trim()).filter(Boolean)
                : undefined;
            const stepId = msg.step_id != null ? String(msg.step_id) : generateUUID();
            messages.push({
                role: 'user',
                content: rawContent.replace(/\n\n<attached_files>[\s\S]*?<\/attached_files>$/, ''),
                id: stepId,
                stableId: stepId,
                attachedFiles,
                createdAt: msg.timestamp,
            });
            runStartedAt = msg.timestamp;
            turnOpen = true;
        }

        if (msg.source === 'agent') {
            // Track first agent step_id for this message group (used for orphaned thoughts)
            if (firstAgentStepId === null) {
                firstAgentStepId = msg.step_id != null ? String(msg.step_id) : generateUUID();
            }
            lastAgentTimestamp = msg.timestamp;
            let toolResultsMap: Map<string, string> = new Map();
            const message = msg.message ?? '';
            const hasMessage = message.trim() !== '';
            const isAnswer = isAgentAnswer(msg);
            const stepGroupId = isAnswer
                ? undefined
                : (msg.step_id != null ? String(msg.step_id) : msg.tool_calls?.[0]?.tool_call_id || generateUUID());

            if (msg.reasoning_content) {
                thoughts.push({
                    type: 'thought',
                    content: msg.reasoning_content,
                    id: generateDeterministicId('thought', msg.reasoning_content),
                    isInternalThought: true,
                    stepGroupId,
                });
            }

            // Build tool results map from observation if present
            if (msg.observation && msg.observation.results) {
                toolResultsMap = new Map(
                    msg.observation.results
                        .filter((res: any) => res.source_call_id && res.content)
                        .map((res: any) => [res.source_call_id, typeof res.content === 'string' ? res.content : JSON.stringify(res.content)])
                );
            }

            // Add tool calls as thoughts (with results if available)
            if (!isAnswer) {
                // If there's a message alongside tool calls, add it as a thought first
                if (hasMessage) {
                    thoughts.push({
                        type: 'thought',
                        content: message,
                        id: generateDeterministicId('thought', message),
                        stepGroupId,
                    });
                }
                for (const tc of msg.tool_calls ?? []) {
                    thoughts.push({
                        type: 'tool_call',
                        toolName: tc.function_name,
                        toolArgs: tc.arguments,
                        toolResult: toolResultsMap.get(tc.tool_call_id),
                        content: '',
                        id: tc.tool_call_id,
                        stepGroupId,
                    });
                }
            } else {
                if (hasMessage) {
                    const stepId = msg.step_id != null ? String(msg.step_id) : generateUUID();
                    currentAgentMessage = {
                        role: 'assistant',
                        content: message,
                        id: stepId,
                        stableId: stepId,
                    };
                }
                finalizeCurrentAgent();
                lastAnswerAt = msg.timestamp;
                // Steps after this that no turn opens have no known start
                runStartedAt = undefined;
                turnOpen = false;
            }
        }
    }

    finalizeCurrentAgent(turnOpen);
    return { messages, turnOpen };
}

/**
 * History loaded mid-run holds what the run has recorded so far as an unanswered reply.
 * A live run placeholder replays the same steps, so keeping both would show them twice.
 */
export function dropUnansweredReply(messages: Message[]): Message[] {
    return messages.at(-1)?.isUnanswered ? messages.slice(0, -1) : messages;
}

/**
 * Determine whether a live (in-memory) message should be preserved when merging
 * with server-persisted history. Messages that are already represented in history
 * should NOT be preserved to avoid duplication.
 */
export function shouldPreserveLiveMessage(msg: Message): boolean {
    // Billing/auth/errors etc aren't persisted
    if (msg.billingInfo) return true;
    if (msg.authInfo) return true;
    if (msg.runErrorInfo) return true;
    // Keep in-progress streaming placeholders
    if (msg.isStreaming) return true;
    // Keep run-based assistant messages that have content (completed but not yet
    // reconciled with history via id). Don't preserve stopped/interrupted assistants
    // that have no content — their thoughts are already persisted in history.
    if (msg.role === 'assistant' && !isNumericIdString(msg.stableId) && (msg.content ?? '').trim()) return true;
    // Keep optimistic user messages (id=clientMessageId UUID) until persisted
    if (msg.role === 'user' && !isNumericIdString(msg.id)) return true;
    return false;
}

/**
 * Merge server-persisted history with live in-memory messages. Live messages that
 * pass `shouldPreserveLiveMessage` and aren't already present in history (by stableId
 * or role:id) are appended.
 */
export function mergeHistoryWithLive(history: Message[], live: Message[]): Message[] {
    if (live.length === 0) return history;
    const merged = [...history];
    const seenStableIds = new Set(history.map(m => m.stableId));
    const seenRoleIds = new Set(history.map(m => `${m.role}:${m.id}`));
    for (const msg of live) {
        if (!shouldPreserveLiveMessage(msg)) continue;
        const roleIdKey = `${msg.role}:${msg.id}`;
        if (seenStableIds.has(msg.stableId) || seenRoleIds.has(roleIdKey)) continue;
        merged.push(msg);
        seenStableIds.add(msg.stableId);
        seenRoleIds.add(roleIdKey);
    }
    return merged;
}

