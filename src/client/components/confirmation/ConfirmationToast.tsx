// Individual toast notification for a confirmation request from background conversations

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { ConfirmationRequest, ConfirmationOption } from '../../types';
import { DiffView } from '../tool-views/DiffView';
import { parseCommandMessage, shortenHomePath } from '../../utils/parseCommand';

interface ConfirmationToastProps {
    convId: string;
    convTitle: string;
    request: ConfirmationRequest;
    onRespond: (convId: string, optionId: string) => void;
    onDismiss: (convId: string) => void;
}

export function ConfirmationToast({
    convId,
    convTitle,
    request,
    onRespond,
    onDismiss,
}: ConfirmationToastProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    // Get button style class based on option style
    const getButtonClass = (option: ConfirmationOption): string => {
        switch (option.style) {
            case 'primary':
                return 'toast-btn primary';
            case 'danger':
                return 'toast-btn danger';
            default:
                return 'toast-btn secondary';
        }
    };

    const commandInfo = request.message ? parseCommandMessage(request.message) : null;

    // Determine if we have expandable content
    const hasExpandableContent = commandInfo?.command || request.diff || (request.message && request.message.length > 120);

    // For non-command messages, show truncated preview
    const messagePreview = !commandInfo && request.message
        ? (request.message.length > 120 ? request.message.slice(0, 120) + '...' : request.message)
        : !commandInfo && request.context?.toolName
            ? `${request.context.toolName}: ${JSON.stringify(request.context.toolArgs || {}).slice(0, 80)}...`
            : '';

    return (
        <div className="confirmation-toast">
            <div className="toast-header">
                <div className="toast-info">
                    <span className="toast-conversation">{convTitle}</span>
                    <span className="toast-title">{request.title}</span>
                    {/* For command executions, show reason by default */}
                    {commandInfo?.reason && (
                        <span className="toast-preview">{commandInfo.reason}</span>
                    )}
                    {/* For non-command messages, show truncated preview */}
                    {messagePreview && (
                        <span className="toast-preview">{messagePreview}</span>
                    )}
                </div>
                <div className="toast-controls">
                    {/* Show expand button if there's more content */}
                    {hasExpandableContent && (
                        <button
                            className="toast-expand-btn"
                            onClick={() => setIsExpanded(!isExpanded)}
                            title={isExpanded ? 'Collapse' : 'Expand'}
                        >
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                    )}
                    <button
                        className="toast-close-btn"
                        onClick={() => onDismiss(convId)}
                        title="Dismiss"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {isExpanded && (
                <div className="toast-body">
                    {/* For command executions, show the command block */}
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
                    {/* For non-command messages, show full message when expanded */}
                    {!commandInfo && request.message && request.message.length > 120 && (
                        <div className="toast-message">{request.message}</div>
                    )}
                    {request.diff && <DiffView diff={request.diff} />}
                </div>
            )}

            <div className="toast-actions">
                {request.options.slice(0, 2).map((option, idx) => (
                    <button
                        key={option.id}
                        className={getButtonClass(option)}
                        onClick={() => onRespond(convId, option.id)}
                        title={option.description}
                    >
                        <span className="btn-shortcut">{idx + 1}</span>
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
