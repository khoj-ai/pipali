// Message list container with empty state

import { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import type { Message } from '../../types';
import { MessageItem } from './MessageItem';

interface MessageListProps {
    messages: Message[];
    conversationId?: string;
    onDeleteMessage?: (messageId: string, role: 'user' | 'assistant') => void;
}

export function MessageList({ messages, conversationId, onDeleteMessage }: MessageListProps) {
    const lastUserMessageRef = useRef<HTMLDivElement>(null);
    const previousConversationIdRef = useRef<string | undefined>(undefined);
    const previousMessagesLengthRef = useRef<number>(0);

    // Find the index of the last user message
    const lastUserMessageIndex = messages.findLastIndex(msg => msg.role === 'user');

    // Scroll to last user message when conversation messages are freshly loaded
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
        }
    }, [conversationId, messages.length]);

    return (
        <main className="main-content">
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
                            <div key={msg.id} ref={index === lastUserMessageIndex ? lastUserMessageRef : undefined}>
                                <MessageItem message={msg} onDelete={onDeleteMessage} />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
