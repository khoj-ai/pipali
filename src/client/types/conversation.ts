// Conversation types for chat history and state

import type { Message } from './message';

export type ConversationSummary = {
    id: string;
    title: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
    isActive?: boolean;
    latestReasoning?: string;
};

// Per-conversation state for tracking active tasks
export type ConversationState = {
    isProcessing: boolean;
    isPaused: boolean;
    latestReasoning?: string;
    // Store messages for this conversation to preserve streaming updates when switching
    messages: Message[];
};
