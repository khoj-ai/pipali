// Individual message component

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Trash2 } from 'lucide-react';
import type { Message } from '../../types';
import { ThoughtsSection } from '../thoughts/ThoughtsSection';
import { StreamingIndicator } from './StreamingIndicator';

interface MessageItemProps {
    message: Message;
    onDelete?: (messageId: string, role: 'user' | 'assistant') => void;
}

export function MessageItem({ message, onDelete }: MessageItemProps) {
    const isUser = message.role === 'user';
    const [isHovered, setIsHovered] = useState(false);

    const canDelete = onDelete && !message.isStreaming;

    return (
        <div
            className={`message ${isUser ? 'user-message' : 'assistant-message'}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div className="message-header">
                <div className="message-label">
                    {isUser ? 'You' : 'Panini'}
                </div>
                {canDelete && isHovered && (
                    <button
                        className="message-delete-btn"
                        onClick={() => onDelete(message.id, message.role)}
                        title="Delete message"
                    >
                        <Trash2 size={14} />
                    </button>
                )}
            </div>

            {/* Thoughts / Reasoning */}
            {message.thoughts && message.thoughts.length > 0 && (
                <ThoughtsSection thoughts={message.thoughts} isStreaming={message.isStreaming} />
            )}

            {/* Message Content */}
            {message.content ? (
                <div className="message-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                        {message.content}
                    </ReactMarkdown>
                </div>
            ) : message.isStreaming ? (
                <StreamingIndicator />
            ) : null}
        </div>
    );
}
