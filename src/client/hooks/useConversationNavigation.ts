import { createContext, useContext } from 'react';

/**
 * Opens a conversation by id, for anything deep in the tree that names one.
 *
 * Delegated conversations are kept out of the sidebar, so a trajectory step that
 * started one is the way back to it. Threading the callback through every layer
 * between the app and a tool call would touch components that have no other
 * interest in it.
 */
export const ConversationNavigationContext = createContext<((conversationId: string) => void) | null>(null);

export function useConversationNavigation(): ((conversationId: string) => void) | null {
    return useContext(ConversationNavigationContext);
}
