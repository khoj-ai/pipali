/**
 * Values the server and the client must agree on.
 *
 * Anything one side writes and the other reads back belongs here, declared as the
 * writer and the reader together. Kept apart, a change to one leaves the other
 * quietly parsing a format nobody produces any more.
 */

/** Pipali's persistent memory directory, relative to the user's home directory. */
export const PIPALI_MEMORY_RELATIVE_DIR = '.pipali/memory';

/** Leads every task summary, and is how a delegate step finds the task it started */
export function formatConversationHeader(conversationId: string): string {
    return `Conversation: ${conversationId}`;
}

export const CONVERSATION_HEADER =
    /^Conversation: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/im;
