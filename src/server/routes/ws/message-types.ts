/**
 * WebSocket Message Types
 *
 * Defines the protocol for client-server communication over WebSocket.
 * This follows the run-based model where each user message creates a "run"
 * with a stable runId that connects all related events.
 */

import type { ATIFToolCall, ATIFObservationResult, ATIFMetrics, ATIFStep } from '../../processor/conversation/atif/atif.types';
import type { ConfirmationRequest, ConfirmationResponse } from '../../processor/confirmation';

// ============================================================================
// Client → Server Messages
// ============================================================================

/**
 * Start new run or soft-interrupt active run
 */
export interface MessageCommand {
    type: 'message';
    message: string;
    conversationId?: string;
    clientMessageId: string;  // Client-generated ID for dedup
    runId: string;            // Client-generated run ID (server may override)
}

/**
 * Hard stop active run
 */
export interface StopCommand {
    type: 'stop';
    conversationId: string;
    runId?: string;  // Optional: guard against stopping wrong run
}

/**
 * Fork conversation (background task)
 */
export interface ForkCommand {
    type: 'fork';
    message: string;
    sourceConversationId: string;
    clientMessageId: string;
    runId: string;
}

/**
 * Confirmation response
 */
export interface ConfirmationResponseCommand {
    type: 'confirmation_response';
    conversationId: string;
    runId: string;
    data: ConfirmationResponse;
}

export type ClientMessage =
    | MessageCommand
    | StopCommand
    | ForkCommand
    | ConfirmationResponseCommand;

// ============================================================================
// Server → Client Messages
// ============================================================================

/**
 * Conversation lifecycle - new conversation created
 */
export interface ConversationCreatedMessage {
    type: 'conversation_created';
    conversationId: string;
    history?: ATIFStep[];
}

/**
 * Run lifecycle - run started
 */
export interface RunStartedMessage {
    type: 'run_started';
    conversationId: string;
    runId: string;                  // Authoritative runId
    clientMessageId: string;        // Echo back for client correlation
    suggestedRunId?: string;        // Original client suggestion (if overridden)
}

/**
 * Run lifecycle - run stopped (user_stop, soft_interrupt, disconnect, error)
 */
export interface RunStoppedMessage {
    type: 'run_stopped';
    conversationId: string;
    runId: string;
    reason: StopReason;
    error?: string;  // Present when reason is 'error'
}

export type StopReason = 'user_stop' | 'soft_interrupt' | 'disconnect' | 'error';

/**
 * Run lifecycle - run completed naturally
 */
export interface RunCompleteMessage {
    type: 'run_complete';
    conversationId: string;
    runId: string;
    data: {
        response: string;
        stepId: number;
    };
}

/**
 * Step lifecycle - step started (preview of what's about to execute)
 */
export interface StepStartMessage {
    type: 'step_start';
    conversationId: string;
    runId: string;
    data: {
        thought?: string;
        message?: string;
        toolCalls: ATIFToolCall[];
    };
}

/**
 * Step lifecycle - step ended (complete with results)
 */
export interface StepEndMessage {
    type: 'step_end';
    conversationId: string;
    runId: string;
    data: {
        thought?: string;
        message?: string;
        toolCalls: ATIFToolCall[];
        toolResults: ATIFObservationResult[];
        stepId: number;
        metrics?: ATIFMetrics;
    };
}

/**
 * Confirmation request
 */
export interface ConfirmationRequestMessage {
    type: 'confirmation_request';
    conversationId: string;
    runId: string;
    data: ConfirmationRequest;
}

/**
 * User message saved to DB
 */
export interface UserStepSavedMessage {
    type: 'user_step_saved';
    conversationId: string;
    runId: string;
    clientMessageId: string;
    stepId: number;
}

/**
 * Billing error
 */
export interface BillingErrorMessage {
    type: 'billing_error';
    conversationId?: string;
    runId?: string;
    error: BillingError;
}

export interface BillingError {
    code: 'insufficient_credits' | 'spend_limit_reached';
    message: string;
    credits_balance_cents?: number;
    current_period_spent_cents?: number;
    spend_hard_limit_cents?: number;
}

export type ServerMessage =
    | ConversationCreatedMessage
    | RunStartedMessage
    | RunStoppedMessage
    | RunCompleteMessage
    | StepStartMessage
    | StepEndMessage
    | ConfirmationRequestMessage
    | UserStepSavedMessage
    | BillingErrorMessage;

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Queued message for soft interrupt
 */
export interface QueuedMessage {
    runId: string;
    clientMessageId: string;
    message: string;
}

/**
 * Pending confirmation with resolve/reject handlers
 */
export interface PendingConfirmation {
    requestId: string;
    resolve: (response: ConfirmationResponse) => void;
    reject: (error: Error) => void;
}
