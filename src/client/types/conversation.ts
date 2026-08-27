// Conversation types for chat history and state

import type { Message } from './message';

export type ConversationSummary = {
    id: string;
    title: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
    chatModelId?: number | null;
    isActive?: boolean;
    isAutomation?: boolean;
    /** Set when this conversation is a task delegated by another conversation. */
    parentConversationId?: string | null;
    isPinned?: boolean;
    latestReasoning?: string;
    matchSnippet?: string;
};

// Per-conversation state for tracking active tasks
export type ConversationState = {
    isProcessing: boolean;
    isStopped: boolean;
    isCompleted: boolean;
    latestReasoning?: string;
    // Store messages for this conversation to preserve streaming updates when switching
    messages: Message[];
};
