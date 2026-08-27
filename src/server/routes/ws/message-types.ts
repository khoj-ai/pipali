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
    chatModelId?: number;
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
    chatModelId?: number;
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

/**
 * Observe a conversation (subscribe to live events + replay recent)
 */
export interface ObserveCommand {
    type: 'observe';
    conversationId: string;
}

export type ClientMessage =
    | MessageCommand
    | StopCommand
    | ForkCommand
    | ConfirmationResponseCommand
    | ObserveCommand;

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
 * Run lifecycle - partial text delta for real-time streaming
 */
export interface TextDeltaMessage {
    type: 'text_delta';
    conversationId: string;
    runId: string;
    data: {
        delta: string;
    };
}

/**
 * Run lifecycle - partial reasoning delta for real-time streaming
 */
export interface ReasoningDeltaMessage {
    type: 'reasoning_delta';
    conversationId: string;
    runId: string;
    data: {
        delta: string;
    };
}

/**
 * Step lifecycle - a tool call the model is still writing out.
 * `argChars` is cumulative, so a later message supersedes earlier ones for the
 * same call, and step_start supersedes them all.
 */
export interface ToolCallProgressMessage {
    type: 'tool_call_progress';
    conversationId: string;
    runId: string;
    data: {
        callId: string;
        name: string;
        argChars: number;
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
 * Confirmation resolved (by any client)
 * Lets other observers dismiss dialogs/toasts for already-answered confirmations.
 */
export interface ConfirmationResolvedMessage {
    type: 'confirmation_resolved';
    conversationId: string;
    runId: string;
    data: {
        requestId: string;
        selectedOptionId: string;
        timestamp?: string;
    };
}

/**
 * Message deleted (by any client/device)
 * Used to synchronize deletions across multiple observers without forcing a full history reload.
 */
export interface MessageDeletedMessage {
    type: 'message_deleted';
    conversationId: string;
    data: {
        stepId: number;
        role: 'user' | 'assistant';
    };
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
    /** The user message text. Observers that missed the optimistic ADD_USER_MESSAGE need this. */
    message?: string;
}

/**
 * Compaction summary (conversation memory compaction)
 */
export interface CompactionMessage {
    type: 'compaction';
    conversationId: string;
    runId: string;
    data: {
        summary: string;
    };
}

/**
 * Observe status response (whether a conversation currently has an active run)
 */
export interface ObserveStatusMessage {
    type: 'observe_status';
    conversationId: string;
    hasActiveRun: boolean;
    runId?: string;
    clientMessageId?: string;
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

/**
 * Platform authentication error (session expired, refresh failed)
 */
export interface AuthErrorMessage {
    type: 'auth_error';
    conversationId?: string;
    runId?: string;
    error: AuthError;
}

export interface AuthError {
    code: 'session_expired';
    message: string;
}

export type ServerMessage =
    | ConversationCreatedMessage
    | RunStartedMessage
    | RunStoppedMessage
    | RunCompleteMessage
    | TextDeltaMessage
    | ReasoningDeltaMessage
    | ToolCallProgressMessage
    | StepStartMessage
    | StepEndMessage
    | ConfirmationRequestMessage
    | ConfirmationResolvedMessage
    | MessageDeletedMessage
    | UserStepSavedMessage
    | CompactionMessage
    | ObserveStatusMessage
    | BillingErrorMessage
    | AuthErrorMessage;

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
    chatModelId?: number;
    /** alias for dynamic selection by platform */
    chatModelAlias?: string;
}

/**
 * Pending confirmation with resolve/reject handlers
 */
export interface PendingConfirmation {
    requestId: string;
    /** The original request, stored so we can match by operation type */
    request: ConfirmationRequest;
    resolve: (response: ConfirmationResponse) => void;
    reject: (error: Error) => void;
}
