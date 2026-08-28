// Individual message component

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Paperclip, Clock, Copy, Check, Pencil, GitBranch } from 'lucide-react';
import type { Message } from '../../types';
import { ThoughtsSection } from '../thoughts/ThoughtsSection';
import { StreamingIndicator } from './StreamingIndicator';
import { ChatMarkdown } from '../ChatMarkdown';
import { BillingMessage } from '../billing';
import { AuthErrorMessage } from '../auth';
import { RunErrorMessage } from './RunErrorMessage';
import { formatMessageTime, getFileName } from '../../utils/formatting';
import { isNumericIdString } from '../../utils/chat-messages';
import { IS_TOUCH } from '../../utils/platform';

interface MessageItemProps {
    message: Message;
    platformFrontendUrl?: string;
    onDelete?: (messageId: string, role: 'user' | 'assistant') => void;
    onEdit?: (messageId: string, text: string) => void;
    onFork?: (messageId: string) => void;
    onBillingContinue?: (messageId: string) => void;
    onBillingDismiss?: (messageId: string) => void;
    onAuthSignIn?: (messageId: string) => void;
    onAuthDismiss?: (messageId: string) => void;
    onRunErrorDismiss?: (messageId: string) => void;
    isActiveRun?: boolean;
}

export function MessageItem({ message, platformFrontendUrl, onDelete, onEdit, onFork, onBillingContinue, onBillingDismiss, onAuthSignIn, onAuthDismiss, onRunErrorDismiss, isActiveRun = false }: MessageItemProps) {
    const { t, i18n } = useTranslation();
    const isUser = message.role === 'user';
    const isStreaming = message.isStreaming || isActiveRun;
    const [isRevealed, setIsRevealed] = useState(false);
    const [copied, setCopied] = useState(false);
    const [draft, setDraft] = useState<string | null>(null);

    // Edit and fork address a message by its step, so they wait for it to be persisted.
    const isPersisted = isNumericIdString(message.id);
    const canCopy = !!message.content;
    const canDelete = onDelete && !isStreaming;
    const canEdit = isUser && onEdit && !isStreaming && isPersisted;
    const canFork = isUser && onFork && !isStreaming && isPersisted;
    const isEditing = draft !== null;

    const copyContent = async () => {
        await navigator.clipboard.writeText(message.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const saveEdit = () => {
        const text = (draft ?? '').trim();
        setDraft(null);
        if (text && text !== message.content) onEdit?.(message.id, text);
    };

    // Render billing message if present
    if (message.billingInfo && platformFrontendUrl) {
        return (
            <div className="message assistant-message">
                <BillingMessage
                    code={message.billingInfo.code}
                    message={message.billingInfo.message}
                    platformFrontendUrl={platformFrontendUrl}
                    onContinue={onBillingContinue ? () => onBillingContinue(message.id) : undefined}
                    onDismiss={onBillingDismiss ? () => onBillingDismiss(message.id) : undefined}
                />
            </div>
        );
    }

    // Render auth error message if present
    if (message.authInfo) {
        return (
            <div className="message assistant-message">
                <AuthErrorMessage
                    onSignIn={() => onAuthSignIn?.(message.id)}
                    onDismiss={onAuthDismiss ? () => onAuthDismiss(message.id) : undefined}
                />
            </div>
        );
    }

    if (message.runErrorInfo) {
        return (
            <div className="message assistant-message">
                <RunErrorMessage
                    message={message.runErrorInfo.message}
                    onDismiss={onRunErrorDismiss ? () => onRunErrorDismiss(message.id) : undefined}
                />
            </div>
        );
    }

    return (
        <div
            className={`message ${isUser ? 'user-message' : 'assistant-message'}`}
            // A pointer hovers; a finger taps the message to reveal the same row.
            onPointerEnter={e => { if (e.pointerType === 'mouse') setIsRevealed(true); }}
            onPointerLeave={e => { if (e.pointerType === 'mouse') setIsRevealed(false); }}
            onPointerDown={e => { if (e.pointerType !== 'mouse') setIsRevealed(revealed => !revealed); }}
        >
            <div className="message-main">
                {isRevealed && !isEditing && (canCopy || canDelete || canEdit || canFork) && (
                    <div className="message-actions" onPointerDown={e => e.stopPropagation()}>
                        {isUser && message.createdAt && (
                            <span className="message-time" title={new Date(message.createdAt).toLocaleString(i18n.language)}>
                                {formatMessageTime(message.createdAt, i18n.language)}
                            </span>
                        )}
                        {canCopy && (
                            <button
                                className="message-action-btn"
                                onClick={copyContent}
                                title={copied ? t('errors.copied') : t('messages.copyMessage')}
                            >
                                {copied ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                        )}
                        {canEdit && (
                            <button
                                className="message-action-btn"
                                onClick={() => setDraft(message.content)}
                                title={t('messages.editMessage')}
                            >
                                <Pencil size={14} />
                            </button>
                        )}
                        {canFork && (
                            <button
                                className="message-action-btn"
                                onClick={() => onFork(message.id)}
                                title={t('messages.forkConversation')}
                            >
                                <GitBranch size={14} />
                            </button>
                        )}
                        {canDelete && (
                            <button
                                className="message-action-btn"
                                onClick={() => onDelete(message.id, message.role)}
                                title={t('messages.deleteMessage')}
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                )}

                {/* Thoughts / Reasoning */}
                {message.thoughts && message.thoughts.length > 0 && (
                    <ThoughtsSection
                        thoughts={message.thoughts}
                        isStreaming={isStreaming}
                        startedAt={message.startedAt}
                        endedAt={message.createdAt}
                    />
                )}

                {/* Message Content */}
                {isEditing ? (
                    <div className="message-edit">
                        <textarea
                            className="message-edit-input"
                            value={draft}
                            autoFocus
                            rows={Math.min(12, draft.split('\n').length + 1)}
                            onChange={e => setDraft(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Escape') setDraft(null);
                                if (e.key === 'Enter' && !e.shiftKey && !IS_TOUCH) {
                                    e.preventDefault();
                                    saveEdit();
                                }
                            }}
                        />
                        <div className="message-edit-actions">
                            <button className="btn-secondary" onClick={() => setDraft(null)}>{t('common.cancel')}</button>
                            <button className="btn-primary" onClick={saveEdit}>{t('messages.resend')}</button>
                        </div>
                    </div>
                ) : message.content ? (
                    <div className="message-content">
                        <ChatMarkdown>{message.content}</ChatMarkdown>
                    </div>
                ) : isStreaming ? (
                    <StreamingIndicator />
                ) : null}
            </div>

            {/* Attached files indicator */}
            {message.attachedFiles && message.attachedFiles.length > 0 && (
                <div className="message-attachments">
                    <Paperclip size={12} />
                    <span>{message.attachedFiles.map(getFileName).join(', ')}</span>
                </div>
            )}

            {/* Queued indicator: shown on user messages waiting behind an in-flight run. */}
            {isUser && message.isQueued && (
                <div className="message-queued">
                    <Clock size={11} />
                    <span>{t('messages.queued')}</span>
                </div>
            )}
        </div>
    );
}
