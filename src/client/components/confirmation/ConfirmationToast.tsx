// Toast notification for confirmation requests from background tasks

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, X, Bot, Clock, Send } from 'lucide-react';
import type { PendingConfirmation } from '../../types/confirmation';
import { DiffView } from '../tool-views/DiffView';
import { parseCommandMessage, shortenHomePath } from '../../utils/parseCommand';
import { getButtonClass, formatTimeRemaining, hasExpandableContent, getMessagePreview } from './utils';

interface ConfirmationToastProps {
    confirmation: PendingConfirmation;
    onRespond: (key: string, optionId: string, guidance?: string) => void;
    onDismiss: (key: string) => void;
}

export function ConfirmationToast({
    confirmation,
    onRespond,
    onDismiss,
}: ConfirmationToastProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [guidanceText, setGuidanceText] = useState('');

    const { request, source, expiresAt, key } = confirmation;
    const isAutomation = source.type === 'automation';

    const commandInfo = request.message ? parseCommandMessage(request.message) : null;
    const expandable = hasExpandableContent(request);
    const messagePreview = getMessagePreview(request);

    // Use all standard options - guidance is now sent independently via the input area
    const displayOptions = request.options;

    const handleSendGuidance = () => {
        if (guidanceText.trim()) {
            onRespond(key, 'guidance', guidanceText.trim());
        }
    };

    return (
        <div className={`confirmation-toast ${isAutomation ? 'confirmation-toast--automation' : ''}`}>
            <div className="toast-header">
                <div className="toast-info">
                    {/* Source indicator */}
                    {isAutomation ? (
                        <span className="toast-conversation automation-source">
                            <Bot size={12} />
                            {source.automationName}
                        </span>
                    ) : (
                        <span className="toast-conversation">{source.conversationTitle}</span>
                    )}

                    <span className="toast-title">{request.title}</span>

                    {/* Command reason or message preview */}
                    {commandInfo?.reason && (
                        <span className="toast-preview">{commandInfo.reason}</span>
                    )}
                    {messagePreview && (
                        <span className="toast-preview">{messagePreview}</span>
                    )}
                </div>

                <div className="toast-controls">
                    {/* Expiry timer for automations */}
                    {expiresAt && (
                        <span className="toast-expiry" title="Time until confirmation expires">
                            <Clock size={12} />
                            {formatTimeRemaining(expiresAt)}
                        </span>
                    )}

                    {/* Expand button */}
                    {expandable && (
                        <button
                            className="toast-expand-btn"
                            onClick={() => setIsExpanded(!isExpanded)}
                            title={isExpanded ? 'Collapse' : 'Expand'}
                        >
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                    )}

                    {/* Dismiss button */}
                    <button
                        className="toast-close-btn"
                        onClick={() => onDismiss(key)}
                        title="Dismiss"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Expandable content */}
            {isExpanded && (
                <div className="toast-body">
                    {/* Command display */}
                    {commandInfo?.command && (
                        <div className="toast-command-section">
                            <div className="toast-command-header">
                                <span className="toast-command-label">Command</span>
                                {commandInfo.workdir && (
                                    <code className="toast-workdir">
                                        in {shortenHomePath(commandInfo.workdir)}
                                    </code>
                                )}
                            </div>
                            <pre className="toast-command-code">
                                <code>{commandInfo.command}</code>
                            </pre>
                        </div>
                    )}

                    {/* Full message for non-commands */}
                    {!commandInfo && request.message && request.message.length > 120 && (
                        <div className="toast-message">{request.message}</div>
                    )}

                    {/* Diff view */}
                    {request.diff && <DiffView diff={request.diff} />}
                </div>
            )}

            {/* Action buttons */}
            <div className="toast-actions">
                {displayOptions.map((option, idx) => (
                    <button
                        key={option.id}
                        className={getButtonClass(option.style)}
                        onClick={() => onRespond(key, option.id)}
                        title={option.description}
                    >
                        <span className="btn-shortcut">{idx + 1}</span>
                        {option.label}
                    </button>
                ))}
            </div>

            {/* Independent guidance input */}
            <div className="toast-guidance-section">
                <div className="toast-guidance-input-row">
                    <input
                        type="text"
                        className="toast-guidance-input"
                        placeholder="Or provide alternative instructions..."
                        value={guidanceText}
                        onChange={(e) => setGuidanceText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && guidanceText.trim()) {
                                handleSendGuidance();
                            }
                        }}
                    />
                    <button
                        className="toast-btn toast-guidance-send"
                        onClick={handleSendGuidance}
                        disabled={!guidanceText.trim()}
                        title="Send guidance (declines current operation)"
                    >
                        <Send size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
