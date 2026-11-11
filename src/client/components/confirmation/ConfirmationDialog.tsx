// Confirmation Dialog Component
// Compact inline dialog for user confirmation of operations and agent questions.
// Renders above the chat input. The chat textarea doubles as guidance input.

import { useEffect } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import type { ConfirmationRequest, ConfirmationOption } from '../../types';
import { DiffView } from '../tool-views/DiffView';
import { shortenHomePath, parseMcpToolName, cleanOperationType } from '../../utils/formatting';
import { getOperationTypePillClass, getOptionLabelKey, HIDDEN_MCP_ARGS, formatArgValue } from './utils';

import { ALT_KEY } from '../../utils/platform';
import { useTranslation } from 'react-i18next';

interface ConfirmationDialogProps {
    request: ConfirmationRequest;
    onRespond: (optionId: string, guidance?: string) => void;
}

export function ConfirmationDialog({ request, onRespond }: ConfirmationDialogProps) {
    const { t } = useTranslation();
    const isAgentQuestion = request.operation === 'ask_user';

    // Handle keyboard shortcuts (Alt+1, Alt+2, etc. to select options)
    // Use e.code (physical key) since Option+number on Mac produces special characters in e.key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!e.altKey) return;
            const match = e.code.match(/^Digit(\d)$/);
            if (!match?.[1]) return;
            const keyNum = parseInt(match[1]);
            if (keyNum >= 1 && keyNum <= request.options.length) {
                e.preventDefault();
                const option = request.options[keyNum - 1];
                if (option) onRespond(option.id);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [request.options, onRespond]);

    // Get button style class
    const getButtonClass = (option: ConfirmationOption): string => {
        const baseClass = 'confirmation-btn';
        switch (option.style) {
            case 'primary': return `${baseClass} primary`;
            case 'danger': return `${baseClass} danger`;
            case 'warning': return `${baseClass} warning`;
            default: return `${baseClass} secondary`;
        }
    };

    // Get structured command info from context
    const commandInfo = request.context?.commandInfo;

    // MCP tool call detection
    const isMcpToolCall = request.operation === 'mcp_tool_call';
    const mcpToolInfo = isMcpToolCall && request.context?.toolName
        ? parseMcpToolName(request.context.toolName)
        : null;
    const mcpToolArgs = isMcpToolCall ? request.context?.toolArgs : null;
    const filteredMcpArgs = mcpToolArgs
        ? Object.entries(mcpToolArgs).filter(([k]) => !HIDDEN_MCP_ARGS.has(k))
        : null;
    const displayOpType = request.context?.operationType && !isAgentQuestion
        ? cleanOperationType(request.context.operationType)
        : null;

    return (
        <div className="confirmation-container">
            <div className={`confirmation-dialog ${isAgentQuestion ? 'agent-question' : ''}`}>
                {/* Header: title + badges, compact single row */}
                <div className="confirmation-header">
                    <h3 className={`confirmation-title ${isAgentQuestion ? 'agent-question-title' : ''}`}>
                        {isAgentQuestion && <MessageCircleQuestion size={14} className="question-icon" />}
                        {mcpToolInfo?.friendlyName || t(`confirmation.titles.${request.operation}`, { defaultValue: request.title })}
                    </h3>
                    <div className="confirmation-badges">
                        {isAgentQuestion && (
                            <span className="question-badge">{t('confirmation.question')}</span>
                        )}
                        {displayOpType && (
                            <span className={getOperationTypePillClass(displayOpType)}>
                                {displayOpType}
                            </span>
                        )}
                    </div>
                </div>

                {/* Body: content area with max-height cap. Hidden when empty (e.g. MCP tool with no args) */}
                {(
                    (isMcpToolCall && filteredMcpArgs && filteredMcpArgs.length > 0) ||
                    (!isMcpToolCall && (commandInfo || request.message || request.diff ||
                        (request.context?.affectedFiles && request.context.affectedFiles.length > 0)))
                ) && (
                    <div className="confirmation-body">
                        {/* MCP tool call view — args only, title already shows tool name */}
                        {isMcpToolCall && filteredMcpArgs && filteredMcpArgs.length > 0 ? (
                            <div className="mcp-args-list">
                                {filteredMcpArgs.map(([key, value]) => (
                                    <div key={key} className="mcp-arg-row">
                                        <span className="mcp-arg-key">{key}</span>
                                        <span className="mcp-arg-separator">:</span>
                                        {formatArgValue(value)}
                                    </div>
                                ))}
                            </div>
                        ) : commandInfo ? (
                            <div className="command-confirmation">
                                {commandInfo.reason && (
                                    <div className="command-section">
                                        <div className="reason-content">{commandInfo.reason}</div>
                                    </div>
                                )}
                                {commandInfo.command && (
                                    <div className="command-section">
                                        <div className="command-section-header">
                                            <span className="command-section-label">{t('confirmation.command')}</span>
                                            {commandInfo.workdir && (
                                                <code className="workdir-pill" title={commandInfo.workdir}>
                                                    {t('confirmation.in')} {shortenHomePath(commandInfo.workdir)}
                                                </code>
                                            )}
                                        </div>
                                        <pre className="command-content">
                                            <code>{commandInfo.command}</code>
                                        </pre>
                                    </div>
                                )}
                            </div>
                        ) : request.message ? (
                            <div className="confirmation-message">
                                {request.message.split('\n').map((line, idx) => (
                                    <p key={idx}>{line || <br />}</p>
                                ))}
                            </div>
                        ) : null}

                        {/* Diff view for edits/writes */}
                        {request.diff && <DiffView diff={request.diff} />}

                        {/* Affected files fallback */}
                        {!request.diff && !request.message && !commandInfo && request.context?.affectedFiles && request.context.affectedFiles.length > 0 && (
                            <div className="confirmation-files">
                                <span className="files-label">{t('confirmation.affectedFiles')}</span>
                                <ul className="files-list">
                                    {request.context.affectedFiles.map((file, idx) => (
                                        <li key={idx} className="file-item">{file}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}

                {/* Actions: compact button row */}
                <div className="confirmation-actions">
                    {request.options.map((option, index) => (
                        <button
                            key={option.id}
                            className={getButtonClass(option)}
                            onClick={() => onRespond(option.id)}
                            title={`${option.description || option.label} (${ALT_KEY}${index + 1})`}
                        >
                            <span className="btn-shortcut">{index + 1}</span>
                            {t(getOptionLabelKey(request, option.id), { defaultValue: option.label })}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
