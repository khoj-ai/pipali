// Message list container with empty state

import { useEffect, useRef, useCallback } from 'react';
import { Sparkles } from 'lucide-react';
import type { Message } from '../../types';
import { MessageItem } from './MessageItem';

interface MessageListProps {
    messages: Message[];
    conversationId?: string;
    platformUrl?: string;
    onDeleteMessage?: (messageId: string, role: 'user' | 'assistant') => void;
}

export function MessageList({ messages, conversationId, platformUrl, onDeleteMessage }: MessageListProps) {
    const lastUserMessageRef = useRef<HTMLDivElement>(null);
    const mainContentRef = useRef<HTMLElement>(null);
    const previousConversationIdRef = useRef<string | undefined>(undefined);
    const previousMessagesLengthRef = useRef<number>(0);
    const previousThoughtsLengthRef = useRef<number>(0);
    // Track if user is near bottom (updated on scroll events)
    const isNearBottomRef = useRef<boolean>(true);

    // Find the index of the last user message
    const lastUserMessageIndex = messages.findLastIndex(msg => msg.role === 'user');

    // Get the streaming message's thoughts count
    const streamingMessage = messages.find(msg => msg.role === 'assistant' && msg.isStreaming);
    const currentThoughtsLength = streamingMessage?.thoughts?.length ?? 0;

    // Track scroll position to detect if user is near bottom
    const handleScroll = useCallback(() => {
        const container = mainContentRef.current;
        if (container) {
            const threshold = 150;
            isNearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
        }
    }, []);

    // Set up scroll listener
    useEffect(() => {
        const container = mainContentRef.current;
        if (container) {
            container.addEventListener('scroll', handleScroll, { passive: true });
            // Initial check
            handleScroll();
            return () => container.removeEventListener('scroll', handleScroll);
        }
    }, [handleScroll]);

    // Scroll to last user message when conversation messages are freshly loaded
    // or when a new message is sent while near the bottom
    useEffect(() => {
        const prevLength = previousMessagesLengthRef.current;
        previousMessagesLengthRef.current = messages.length;

        // Only scroll when messages transition from empty to loaded (fresh load)
        // This handles both initial load and conversation switches
        const isFreshLoad = prevLength === 0 && messages.length > 0;
        const isNewConversation = conversationId !== previousConversationIdRef.current;

        if (isNewConversation) {
            previousConversationIdRef.current = conversationId;
        }

        if (isFreshLoad && messages.length > 0) {
            // Use requestAnimationFrame to ensure DOM has updated with the new ref
            requestAnimationFrame(() => {
                lastUserMessageRef.current?.scrollIntoView({ behavior: 'instant' });
            });
            return;
        }

        // Check if new messages were added (user sent a message)
        const newMessagesAdded = messages.length > prevLength && prevLength > 0;
        if (newMessagesAdded && isNearBottomRef.current) {
            // Scroll to show the new user message
            requestAnimationFrame(() => {
                lastUserMessageRef.current?.scrollIntoView({ behavior: 'smooth' });
            });
        }
    }, [conversationId, messages.length]);

    // Scroll when first thought/tool call arrives (content starts streaming)
    useEffect(() => {
        const prevThoughtsLength = previousThoughtsLengthRef.current;
        previousThoughtsLengthRef.current = currentThoughtsLength;

        // First thought arrived - scroll to keep user message visible
        const firstThoughtArrived = prevThoughtsLength === 0 && currentThoughtsLength > 0;
        if (firstThoughtArrived && isNearBottomRef.current) {
            requestAnimationFrame(() => {
                lastUserMessageRef.current?.scrollIntoView({ behavior: 'smooth' });
            });
        }
    }, [currentThoughtsLength]);

    return (
        <main className="main-content" ref={mainContentRef}>
            <div className="messages-container">
                {messages.length === 0 ? (
                    <div className="empty-state">
                        <Sparkles className="empty-icon" size={32} strokeWidth={1.5} />
                        <h2>What can I help you with?</h2>
                        <p>Ask me anything about your files, data, or tasks.</p>
                    </div>
                ) : (
                    <div className="messages">
                        {messages.map((msg, index) => (
                            <div key={msg.stableId} ref={index === lastUserMessageIndex ? lastUserMessageRef : undefined}>
                                <MessageItem message={msg} platformUrl={platformUrl} onDelete={onDeleteMessage} />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
