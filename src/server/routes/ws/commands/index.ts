/**
 * Command Pattern for WebSocket Messages
 *
 * Each command type has:
 * - A validator to check the message shape
 * - An executor to handle the command
 *
 * This provides a clean separation of concerns and makes
 * the WebSocket handler easier to test and maintain.
 */

import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from '../../ws';
import type { ClientMessage } from '../message-types';
import type { Session, RunningState } from '../session-state';
import type { User } from '../../../db/schema';
import type { ConfirmationPreferences } from '../../../processor/confirmation';

// ============================================================================
// Command Context
// ============================================================================

/**
 * Context passed to command executors
 */
export interface CommandContext {
    ws: ServerWebSocket<WebSocketData>;
    /** Get or create sessions map for this connection */
    getSessions: () => Map<string, Session>;
    /** Get user (lazy load) */
    getUser: () => Promise<typeof User.$inferSelect | null>;
    /** Send message to client */
    send: (message: Record<string, unknown>, conversationId: string) => void;
    /** Send error to client */
    sendError: (error: string, conversationId?: string) => void;
}

// ============================================================================
// Command Interface
// ============================================================================

export interface Command<T extends ClientMessage = ClientMessage> {
    /**
     * Type guard to check if message matches this command
     */
    matches(message: ClientMessage): message is T;

    /**
     * Execute the command
     */
    execute(ctx: CommandContext, message: T): Promise<void>;
}

// ============================================================================
// Re-exports
// ============================================================================

export { MessageCommandHandler } from './message';
export { StopCommandHandler } from './stop';
export { ForkCommandHandler } from './fork';
export { ConfirmationResponseHandler } from './confirmation-response';
