// Confirmation Dialog Component
// Displays a modal dialog for user confirmation of dangerous operations
// Positioned above the chat input with keyboard shortcuts (1, 2, 3)

import React, { useEffect, useState } from 'react';
import { MessageCircleQuestion, Send } from 'lucide-react';
import type { ConfirmationRequest, ConfirmationOption } from '../../types';
import { DiffView } from '../tool-views/DiffView';
import { shortenHomePath } from '../../utils/parseCommand';
import { getOperationTypePillClass } from './utils';

interface ConfirmationDialogProps {
    request: ConfirmationRequest;
    onRespond: (optionId: string, guidance?: string) => void;
}

/**
 * Parse MCP tool name into server and tool parts
 */
function parseMcpToolName(toolName: string): { serverName: string; toolName: string } | null {
    const separatorIndex = toolName.indexOf('__');
    if (separatorIndex === -1) return null;
    return {
        serverName: toolName.slice(0, separatorIndex),
        toolName: toolName.slice(separatorIndex + 2),
    };
}

/**
 * Format a tool argument value for display
 */
function formatArgValue(value: unknown): React.ReactNode {
    if (value === null || value === undefined) {
        return <span className="arg-value null">null</span>;
    }
    if (typeof value === 'boolean') {
        return <span className={`arg-value boolean ${value ? 'true' : 'false'}`}>{String(value)}</span>;
    }
    if (typeof value === 'number') {
        return <span className="arg-value number">{value}</span>;
    }
    if (typeof value === 'string') {
        // Truncate long strings
        const displayValue = value.length > 150 ? value.slice(0, 150) + '...' : value;
        return <code className="arg-value string">{displayValue}</code>;
    }
    if (typeof value === 'object') {
        const jsonStr = JSON.stringify(value, null, 2);
        const displayValue = jsonStr.length > 200 ? jsonStr.slice(0, 200) + '...' : jsonStr;
        return <pre className="arg-value object"><code>{displayValue}</code></pre>;
    }
    return <span className="arg-value">{String(value)}</span>;
}

export function ConfirmationDialog({ request, onRespond }: ConfirmationDialogProps) {
    const [guidanceText, setGuidanceText] = useState('');

    // Check if this is an agent question
    const isAgentQuestion = request.operation === 'ask_user';

    // Handle keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't capture keyboard if typing in guidance input
            if (document.activeElement?.tagName === 'INPUT') {
                return;
            }
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

    const handleSendGuidance = () => {
        if (guidanceText.trim()) {
            onRespond('guidance', guidanceText.trim());
        }
    };

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

    // Get structured command info from context (for shell_command operations)
    const commandInfo = request.context?.commandInfo;

    // Check if this is an MCP tool call
    const isMcpToolCall = request.operation === 'mcp_tool_call';
    const mcpToolInfo = isMcpToolCall && request.context?.toolName
        ? parseMcpToolName(request.context.toolName)
        : null;
    const mcpToolArgs = isMcpToolCall ? request.context?.toolArgs : null;

    return (
        <div className="confirmation-container">
            <div className={`confirmation-dialog ${isAgentQuestion ? 'agent-question' : ''}`}>
                <div className="confirmation-header">
                    <h3 className={`confirmation-title ${isAgentQuestion ? 'agent-question-title' : ''}`}>
                        {isAgentQuestion && <MessageCircleQuestion size={16} className="question-icon" />}
                        {request.title}
                    </h3>
                    <div className="confirmation-badges">
                        {isAgentQuestion && (
                            <span className="question-badge">Question</span>
                        )}
                        {request.context?.operationType && !isAgentQuestion && (
                            <span className={getOperationTypePillClass(request.context.operationType)}>
                                {request.context.operationType}
                            </span>
                        )}
                        {request.context?.riskLevel && !isAgentQuestion && (
                            <span className={getRiskBadgeClass(request.context.riskLevel)}>
                                {request.context.riskLevel} risk
                            </span>
                        )}
                    </div>
                </div>

                <div className="confirmation-body">
                    {/* Structured MCP tool call view */}
                    {isMcpToolCall && mcpToolInfo ? (
                        <div className="mcp-tool-confirmation">
                            <div className="mcp-tool-header">
                                <div className="mcp-tool-info">
                                    <span className="mcp-tool-label">Tool</span>
                                    <code className="mcp-tool-name">{mcpToolInfo.toolName}</code>
                                </div>
                                <div className="mcp-server-info">
                                    <span className="mcp-server-label">Server</span>
                                    <code className="mcp-server-name">{mcpToolInfo.serverName}</code>
                                </div>
                            </div>
                            {mcpToolArgs && Object.keys(mcpToolArgs).length > 0 && (
                                <div className="mcp-tool-args">
                                    <div className="mcp-args-label">Arguments</div>
                                    <div className="mcp-args-list">
                                        {Object.entries(mcpToolArgs).map(([key, value]) => (
                                            <div key={key} className="mcp-arg-row">
                                                <span className="mcp-arg-key">{key}</span>
                                                <span className="mcp-arg-separator">:</span>
                                                {formatArgValue(value)}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {mcpToolArgs && Object.keys(mcpToolArgs).length === 0 && (
                                <div className="mcp-tool-args">
                                    <div className="mcp-args-label">Arguments</div>
                                    <div className="mcp-no-args">No arguments</div>
                                </div>
                            )}
                        </div>
                    ) : commandInfo ? (
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

                    {/* File path if no diff, no message, and no command info */}
                    {!request.diff && !request.message && !commandInfo && request.context?.affectedFiles && request.context.affectedFiles.length > 0 && (
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

                {/* Free-form input for custom response */}
                <div className="confirmation-guidance-section">
                    <div className="confirmation-guidance-input-row">
                        <input
                            type="text"
                            className="confirmation-guidance-input"
                            placeholder={isAgentQuestion ? "Or type a custom response..." : "Or provide alternative instructions..."}
                            value={guidanceText}
                            onChange={(e) => setGuidanceText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && guidanceText.trim()) {
                                    e.preventDefault();
                                    handleSendGuidance();
                                }
                            }}
                        />
                        <button
                            className="confirmation-btn confirmation-guidance-send"
                            onClick={handleSendGuidance}
                            disabled={!guidanceText.trim()}
                            title="Send custom response"
                        >
                            <Send size={14} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
