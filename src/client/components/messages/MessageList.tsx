// Message list container with empty state

import { Sparkles } from 'lucide-react';
import type { Message } from '../../types';
import { MessageItem } from './MessageItem';

interface MessageListProps {
    messages: Message[];
    onDeleteMessage?: (messageId: string, role: 'user' | 'assistant') => void;
}

export function MessageList({ messages, onDeleteMessage }: MessageListProps) {
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
                        {messages.map((msg) => (
                            <MessageItem key={msg.id} message={msg} onDelete={onDeleteMessage} />
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
