// Confirmation Dialog Component
// Displays a modal dialog for user confirmation of dangerous operations
// Positioned above the chat input with keyboard shortcuts (1, 2, 3)

import React, { useEffect } from 'react';
import type { ConfirmationRequest, ConfirmationOption } from '../../types';
import { DiffView } from '../tool-views/DiffView';
import { parseCommandMessage, shortenHomePath } from '../../utils/parseCommand';

interface ConfirmationDialogProps {
    request: ConfirmationRequest;
    onRespond: (optionId: string) => void;
}

export function ConfirmationDialog({ request, onRespond }: ConfirmationDialogProps) {
    // Handle keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Number keys 1, 2, 3 for quick selection
            const keyNum = parseInt(e.key);
            if (keyNum >= 1 && keyNum <= request.options.length) {
                e.preventDefault();
                const option = request.options[keyNum - 1];
                if (option) {
                    onRespond(option.id);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [request.options, onRespond]);

    // Get button style class based on option style
    const getButtonClass = (option: ConfirmationOption): string => {
        const baseClass = 'confirmation-btn';
        switch (option.style) {
            case 'primary':
                return `${baseClass} primary`;
            case 'danger':
                return `${baseClass} danger`;
            case 'warning':
                return `${baseClass} warning`;
            default:
                return `${baseClass} secondary`;
        }
    };

    // Get risk level badge class
    const getRiskBadgeClass = (level?: string): string => {
        switch (level) {
            case 'high':
                return 'risk-badge high';
            case 'medium':
                return 'risk-badge medium';
            case 'low':
                return 'risk-badge low';
            default:
                return 'risk-badge';
        }
    };

    const commandInfo = request.message ? parseCommandMessage(request.message) : null;

    return (
        <div className="confirmation-container">
            <div className="confirmation-dialog">
                <div className="confirmation-header">
                    <h3 className="confirmation-title">{request.title}</h3>
                    {request.context?.riskLevel && (
                        <span className={getRiskBadgeClass(request.context.riskLevel)}>
                            {request.context.riskLevel} risk
                        </span>
                    )}
                </div>

                <div className="confirmation-body">
                    {/* Structured command execution view */}
                    {commandInfo ? (
                        <div className="command-confirmation">
                            {commandInfo.reason && (
                                <div className="command-section">
                                    <div className="command-section-label">Reason</div>
                                    <div className="command-section-content reason-content">
                                        {commandInfo.reason}
                                    </div>
                                </div>
                            )}
                            {commandInfo.command && (
                                <div className="command-section">
                                    <div className="command-section-header">
                                        <span className="command-section-label">Command</span>
                                        {commandInfo.workdir && (
                                            <code className="workdir-pill" title={commandInfo.workdir}>
                                                in {shortenHomePath(commandInfo.workdir)}
                                            </code>
                                        )}
                                    </div>
                                    <pre className="command-section-content command-content">
                                        <code>{commandInfo.command}</code>
                                    </pre>
                                </div>
                            )}
                        </div>
                    ) : request.message ? (
                        /* Fallback: plain message for non-command operations */
                        <div className="confirmation-message">
                            {request.message.split('\n').map((line, idx) => (
                                <p key={idx}>{line || <br />}</p>
                            ))}
                        </div>
                    ) : null}

                    {/* Diff view for showing changes */}
                    {request.diff && <DiffView diff={request.diff} />}

                    {/* File path if no diff and no message */}
                    {!request.diff && !request.message && request.context?.affectedFiles && request.context.affectedFiles.length > 0 && (
                        <div className="confirmation-files">
                            <span className="files-label">Affected files:</span>
                            <ul className="files-list">
                                {request.context.affectedFiles.map((file, idx) => (
                                    <li key={idx} className="file-item">{file}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>

                <div className="confirmation-actions">
                    {request.options.map((option, index) => (
                        <button
                            key={option.id}
                            className={getButtonClass(option)}
                            onClick={() => onRespond(option.id)}
                            title={`${option.description} (Press ${index + 1})`}
                        >
                            <span className="btn-shortcut">{index + 1}</span>
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
