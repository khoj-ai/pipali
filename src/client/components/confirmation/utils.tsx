// Shared utilities for confirmation components

import type { ConfirmationRequest, ConfirmationOption } from '../../types/confirmation';

/**
 * Get CSS class for button based on option style
 */
export function getButtonClass(style?: ConfirmationOption['style']): string {
    switch (style) {
        case 'primary':
            return 'toast-btn primary';
        case 'danger':
            return 'toast-btn danger';
        case 'warning':
            return 'toast-btn warning';
        default:
            return 'toast-btn secondary';
    }
}

/**
 * Format time remaining until expiration
 */
export function formatTimeRemaining(expiresAt: string): string {
    const expires = new Date(expiresAt);
    const now = new Date();
    const diffMs = expires.getTime() - now.getTime();

    if (diffMs < 0) return 'Expired';

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffHours > 0) {
        return `${diffHours}h ${diffMinutes}m remaining`;
    }
    return `${diffMinutes}m remaining`;
}

/**
 * Check if request has expandable content (command, diff, or long message)
 */
export function hasExpandableContent(request: ConfirmationRequest): boolean {
    const commandInfo = request.context?.commandInfo;
    const hasMcpArgs = request.operation === 'mcp_tool_call' && request.context?.toolArgs
        && Object.keys(request.context.toolArgs).filter(k => !HIDDEN_MCP_ARGS.has(k)).length > 0;
    return !!(commandInfo?.command || request.diff || hasMcpArgs || (request.message && request.message.length > 120));
}

/**
 * Get CSS class for operation type pill
 */
export function getOperationTypePillClass(opType?: string): string {
    switch (opType) {
        case 'read-only':
        case 'safe':
            return 'operation-type-pill safe';
        case 'read-write':
        case 'unsafe':
            return 'operation-type-pill unsafe';
        default:
            return 'operation-type-pill';
    }
}

/**
 * Get truncated message preview
 */
export function getMessagePreview(request: ConfirmationRequest): string {
    const commandInfo = request.context?.commandInfo;

    if (commandInfo?.reason) {
        return commandInfo.reason.length > 120
            ? commandInfo.reason.slice(0, 120) + '...'
            : commandInfo.reason;
    }

    else if (request.message) {
        return request.message.length > 120
            ? request.message.slice(0, 120) + '...'
            : request.message;
    }

    else if (request.operation === 'mcp_tool_call' && request.context?.toolArgs) {
        // Show MCP tool args compactly (not raw JSON)
        const args = Object.entries(request.context.toolArgs)
            .filter(([k]) => !HIDDEN_MCP_ARGS.has(k))
            .map(([k, v]) => {
                const val = typeof v === 'string'
                    ? (v.length > 40 ? v.slice(0, 37) + '\u2026' : v)
                    : JSON.stringify(v);
                return `${k}: ${val}`;
            })
            .join(', ');
        return args || '';
    }

    return '';
}

/** MCP args to hide from the user (noise) */
export const HIDDEN_MCP_ARGS = new Set(['operation_type', 'includeSnapshot']);

/**
 * Format a tool argument value for compact inline display
 */
export function formatArgValue(value: unknown): React.ReactNode {
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
        const displayValue = value.length > 120 ? value.slice(0, 120) + '\u2026' : value;
        return <code className="arg-value string">{displayValue}</code>;
    }
    if (typeof value === 'object') {
        const jsonStr = JSON.stringify(value, null, 2);
        const displayValue = jsonStr.length > 150 ? jsonStr.slice(0, 150) + '\u2026' : jsonStr;
        return <pre className="arg-value object"><code>{displayValue}</code></pre>;
    }
    return <span className="arg-value">{String(value)}</span>;
}
