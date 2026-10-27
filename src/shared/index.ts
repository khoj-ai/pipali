/**
 * Values the server and the client must agree on.
 *
 * Anything one side writes and the other reads back belongs here, declared as the
 * writer and the reader together. Kept apart, a change to one leaves the other
 * quietly parsing a format nobody produces any more.
 */

/** Carries the settings token on requests that change what the sandbox allows. */
export const SETTINGS_TOKEN_HEADER = 'X-Pipali-Settings-Token';

/** Pipali's persistent memory directory, relative to the user's home directory. */
export const PIPALI_MEMORY_RELATIVE_DIR = '.pipali/memory';

/** Leads every task summary, and is how a delegate step finds the task it started */
export function formatConversationHeader(conversationId: string): string {
    return `Conversation: ${conversationId}`;
}

export const CONVERSATION_HEADER =
    /^Conversation: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/im;

/**
 * Kinds of `system` step reporting long-running work back to the conversation that
 * started it. One arriving between turns wakes the conversation into a turn of its own.
 */
export const PARENT_INBOX_KINDS = ['delegated_task_update', 'background_command_update'] as const;
export type ParentInboxKind = typeof PARENT_INBOX_KINDS[number];

/**
 * A run records one agent step without tool calls, its answer, last. That ends a reply
 * even with no user message after it, as when background work reporting in wakes the
 * conversation. The chat groups steps into replies by it, and deleting one removes the
 * same steps.
 */
export function isAgentAnswer(step: { source: string; tool_calls?: unknown[] } | undefined): boolean {
    return step?.source === 'agent' && !step.tool_calls?.length;
}
