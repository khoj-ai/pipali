// Message list container with empty state

import React, { useRef, useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import type { Message } from '../../types';
import { MessageItem } from './MessageItem';

interface MessageListProps {
    messages: Message[];
}

export function MessageList({ messages }: MessageListProps) {
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

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
                            <MessageItem key={msg.id} message={msg} />
                        ))}
                        <div ref={messagesEndRef} />
                    </div>
                )}
            </div>
        </main>
    );
}
