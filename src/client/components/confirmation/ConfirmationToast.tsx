// Toast notification for confirmation requests from background tasks

import { useState } from 'react';
import { ChevronDown, ChevronUp, X, Bot, Clock, Send, MessageCircleQuestion } from 'lucide-react';
import type { PendingConfirmation } from '../../types/confirmation';
import { DiffView } from '../tool-views/DiffView';
import { shortenHomePath, parseMcpToolName, cleanOperationType } from '../../utils/formatting';
import { getButtonClass, formatTimeRemaining, hasExpandableContent, getMessagePreview, getOperationTypePillClass, HIDDEN_MCP_ARGS, formatArgValue } from './utils';
import { useTranslation } from 'react-i18next';

interface ConfirmationToastProps {
    confirmation: PendingConfirmation;
    onRespond: (key: string, optionId: string, guidance?: string) => void;
    onDismiss: (key: string) => void;
    onNavigateToConversation?: (conversationId: string) => void;
    onNavigateToAutomations?: () => void;
}

export function ConfirmationToast({
    confirmation,
    onRespond,
    onDismiss,
    onNavigateToConversation,
    onNavigateToAutomations,
}: ConfirmationToastProps) {
    const { t } = useTranslation();
    const [isExpanded, setIsExpanded] = useState(false);
    const [guidanceText, setGuidanceText] = useState('');

    const { request, source, expiresAt, key } = confirmation;
    // A routine's confirmation reads as the routine's whether it arrived live on the
    // conversation or was polled for from the routines page.
    const isAutomation = source.type === 'automation' || (source.type === 'chat' && !!source.isRoutine);
    const sourceLabel = source.type === 'automation' ? source.automationName : source.conversationTitle;
    const isAgentQuestion = request.operation === 'ask_user';

    // Get structured command info from context (for shell_command operations)
    const commandInfo = request.context?.commandInfo;
    const isMcpToolCall = request.operation === 'mcp_tool_call';
    const mcpToolInfo = isMcpToolCall && request.context?.toolName
        ? parseMcpToolName(request.context.toolName)
        : null;
    const displayOpType = request.context?.operationType && !isAgentQuestion
        ? cleanOperationType(request.context.operationType)
        : null;
    const expandable = hasExpandableContent(request);
    const messagePreview = getMessagePreview(request);

    // Use all standard options - guidance is now sent independently via the input area
    const displayOptions = request.options;

    const handleSendGuidance = () => {
        if (guidanceText.trim()) {
            onRespond(key, 'guidance', guidanceText.trim());
        }
    };

    const handleNavigate = () => {
        if (source.type === 'chat' && onNavigateToConversation) {
            onNavigateToConversation(source.conversationId);
        } else if (source.type === 'automation') {
            // Navigate to automation's conversation if available, otherwise to automations page
            if (source.conversationId && onNavigateToConversation) {
                onNavigateToConversation(source.conversationId);
            } else if (onNavigateToAutomations) {
                onNavigateToAutomations();
            }
        }
    };

    const isClickable = (source.type === 'chat' && !!onNavigateToConversation) ||
                        (source.type === 'automation' && (!!onNavigateToAutomations || (!!source.conversationId && !!onNavigateToConversation)));

    return (
        <div className={`confirmation-toast ${isAutomation ? 'confirmation-toast--automation' : ''} ${isAgentQuestion ? 'confirmation-toast--question' : ''}`}>
            <div className="toast-header">
                <div className="toast-info">
                    {/* Source indicator - clickable to navigate */}
                    {isAutomation ? (
                        <span
                            className={`toast-conversation automation-source ${isClickable ? 'toast-conversation-clickable' : ''}`}
                            onClick={isClickable ? handleNavigate : undefined}
                            role={isClickable ? 'button' : undefined}
                            tabIndex={isClickable ? 0 : undefined}
                            onKeyDown={isClickable ? (e) => { if (e.key === 'Enter') handleNavigate(); } : undefined}
                        >
                            <Bot size={12} />
                            {sourceLabel}
                        </span>
                    ) : (
                        <span
                            className={`toast-conversation ${isClickable ? 'toast-conversation-clickable' : ''}`}
                            onClick={isClickable ? handleNavigate : undefined}
                            role={isClickable ? 'button' : undefined}
                            tabIndex={isClickable ? 0 : undefined}
                            onKeyDown={isClickable ? (e) => { if (e.key === 'Enter') handleNavigate(); } : undefined}
                        >
                            {source.conversationTitle}
                        </span>
                    )}

                    <div className="toast-title-row">
                        <span className={`toast-title ${isAgentQuestion ? 'agent-question-title' : ''}`}>
                            {isAgentQuestion && <MessageCircleQuestion size={12} className="question-icon" />}
                            {mcpToolInfo?.friendlyName || t(`confirmation.titles.${request.operation}`, { defaultValue: request.title })}
                        </span>
                        {isAgentQuestion && <span className="question-badge">{t('confirmation.question')}</span>}
                        {displayOpType && (
                            <span className={getOperationTypePillClass(displayOpType)}>
                                {displayOpType}
                            </span>
                        )}
                    </div>

                    {/* Command reason or message preview (not for MCP — args shown in body) */}
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
                            title={isExpanded ? t('confirmation.collapse') : t('confirmation.expand')}
                        >
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                    )}

                    {/* Dismiss button */}
                    <button
                        className="toast-close-btn"
                        onClick={() => onDismiss(key)}
                        title={t('common.dismiss')}
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
                                <span className="toast-command-label">{t('confirmation.command')}</span>
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
                    {!commandInfo && !isMcpToolCall && request.message && request.message.length > 120 && (
                        <div className="toast-message">{request.message}</div>
                    )}

                    {/* MCP tool args */}
                    {isMcpToolCall && request.context?.toolArgs && (() => {
                        const args = Object.entries(request.context!.toolArgs!)
                            .filter(([k]) => !HIDDEN_MCP_ARGS.has(k));
                        if (args.length === 0) return null;
                        return (
                            <div className="mcp-args-list">
                                {args.map(([key, value]) => (
                                    <div key={key} className="mcp-arg-row">
                                        <span className="mcp-arg-key">{key}</span>
                                        <span className="mcp-arg-separator">:</span>
                                        {formatArgValue(value)}
                                    </div>
                                ))}
                            </div>
                        );
                    })()}

                    {/* Diff view */}
                    {request.diff && <DiffView diff={request.diff} />}
                </div>
            )}

            {/* Action buttons */}
            <div className="toast-actions">
                {displayOptions.map((option) => (
                    <button
                        key={option.id}
                        className={getButtonClass(option.style)}
                        onClick={() => onRespond(key, option.id)}
                        title={option.description}
                    >
                        {t(`confirmation.options.${option.id}`, { defaultValue: option.label })}
                    </button>
                ))}
            </div>

            {/* Independent guidance input */}
            <div className="toast-guidance-section">
                <div className="toast-guidance-input-row">
                    <input
                        type="text"
                        className="toast-guidance-input"
                        placeholder={isAgentQuestion ? t('confirmation.guidancePlaceholderQuestion') : t('confirmation.guidancePlaceholderDefault')}
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
                        title={t('confirmation.sendGuidance')}
                    >
                        <Send size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
