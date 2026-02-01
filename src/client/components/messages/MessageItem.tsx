// Individual message component

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Trash2 } from 'lucide-react';
import type { Message } from '../../types';
import { ThoughtsSection } from '../thoughts/ThoughtsSection';
import { StreamingIndicator } from './StreamingIndicator';
import { ExternalLink } from '../ExternalLink';
import { safeMarkdownUrlTransform, localImageSrc } from '../../utils/markdown';
import { getApiBaseUrl } from '../../utils/api';
import { BillingMessage } from '../billing';

interface MessageItemProps {
    message: Message;
    platformFrontendUrl?: string;
    onDelete?: (messageId: string, role: 'user' | 'assistant') => void;
}

export function MessageItem({ message, platformFrontendUrl, onDelete }: MessageItemProps) {
    const isUser = message.role === 'user';
    const [isHovered, setIsHovered] = useState(false);

    const canDelete = onDelete && !message.isStreaming;

    // Render billing message if present
    if (message.billingInfo && platformFrontendUrl) {
        return (
            <div className="message assistant-message">
                <BillingMessage
                    code={message.billingInfo.code}
                    message={message.billingInfo.message}
                    platformFrontendUrl={platformFrontendUrl}
                />
            </div>
        );
    }

    return (
        <div
            className={`message ${isUser ? 'user-message' : 'assistant-message'}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {isHovered && canDelete && (
                <div className="message-actions">
                    <button
                        className="message-action-btn"
                        onClick={() => onDelete(message.id, message.role)}
                        title="Delete message"
                    >
                        <Trash2 size={14} />
                    </button>
                </div>
            )}

            {/* Thoughts / Reasoning */}
            {message.thoughts && message.thoughts.length > 0 && (
                <ThoughtsSection thoughts={message.thoughts} isStreaming={message.isStreaming} />
            )}

            {/* Message Content */}
            {message.content ? (
                <div className="message-content">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
                        rehypePlugins={[rehypeKatex]}
                        urlTransform={safeMarkdownUrlTransform}
                        components={{
                            a: ExternalLink,
                            img: ({ src, alt }) => {
                                const resolvedSrc = localImageSrc(src, getApiBaseUrl());
                                return resolvedSrc
                                    ? <img src={resolvedSrc} alt={alt || ''} className="message-inline-image" />
                                    : null;
                            },
                        }}
                    >
                        {message.content}
                    </ReactMarkdown>
                </div>
            ) : message.isStreaming ? (
                <StreamingIndicator />
            ) : null}
        </div>
    );
}
