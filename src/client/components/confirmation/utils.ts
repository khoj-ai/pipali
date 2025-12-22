// Shared utilities for confirmation components

import type { ConfirmationRequest, ConfirmationOption } from '../../types/confirmation';
import { parseCommandMessage } from '../../utils/parseCommand';

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
    const commandInfo = request.message ? parseCommandMessage(request.message) : null;
    return !!(commandInfo?.command || request.diff || (request.message && request.message.length > 120));
}

/**
 * Get truncated message preview for non-command messages
 */
export function getMessagePreview(request: ConfirmationRequest): string {
    const commandInfo = request.message ? parseCommandMessage(request.message) : null;

    if (!commandInfo && request.message) {
        return request.message.length > 120
            ? request.message.slice(0, 120) + '...'
            : request.message;
    }

    if (!commandInfo && request.context?.toolName) {
        return `${request.context.toolName}: ${JSON.stringify(request.context.toolArgs || {}).slice(0, 80)}...`;
    }

    return '';
}
