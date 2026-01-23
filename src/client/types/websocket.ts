// WebSocket protocol types (run-based model)

import type { ConfirmationRequest } from './confirmation';

export type BillingErrorCode = 'insufficient_credits' | 'spend_limit_reached';

export interface BillingError {
    code: BillingErrorCode;
    message: string;
    credits_balance_cents?: number;
    current_period_spent_cents?: number;
    spend_hard_limit_cents?: number;
}

export type ToolCall = {
    tool_call_id: string;
    function_name: string;
    arguments: unknown;
    operation_type?: string;
};

export type ToolResult = {
    source_call_id: string;
    content: unknown;
};

export type Metrics = {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
    cost_usd?: number;
};

export interface ConfirmationResponse {
    requestId: string;
    selectedOptionId: string;
    guidance?: string;
    inputData?: {
        selectedIds?: string[];
        numericValue?: number;
        textValue?: string;
    };
    persistPreference?: boolean;
    timestamp: string;
}

// ============================================================================
// Client → Server
// ============================================================================

export type MessageCommand = {
    type: 'message';
    message: string;
    conversationId?: string;
    clientMessageId: string;
    runId: string;
};

export type StopCommand = {
    type: 'stop';
    conversationId: string;
    runId?: string;
};

export type ForkCommand = {
    type: 'fork';
    message: string;
    sourceConversationId: string;
    clientMessageId: string;
    runId: string;
};

export type ConfirmationResponseCommand = {
    type: 'confirmation_response';
    conversationId: string;
    runId: string;
    data: ConfirmationResponse;
};

export type ClientMessage =
    | MessageCommand
    | StopCommand
    | ForkCommand
    | ConfirmationResponseCommand;

// ============================================================================
// Server → Client
// ============================================================================

export type StopReason = 'user_stop' | 'soft_interrupt' | 'disconnect' | 'error';

export type ATIFHistoryStep = {
    step_id: number;
    source: 'system' | 'user' | 'assistant' | 'tool';
    message?: string;
    tool_calls?: ToolCall[];
    tool_results?: ToolResult[];
};

export type ConversationCreatedMessage = {
    type: 'conversation_created';
    conversationId: string;
    history?: ATIFHistoryStep[];
};

export type RunStartedMessage = {
    type: 'run_started';
    conversationId: string;
    runId: string;
    clientMessageId: string;
    suggestedRunId?: string;
};

export type RunStoppedMessage = {
    type: 'run_stopped';
    conversationId: string;
    runId: string;
    reason: StopReason;
    error?: string;
};

export type RunCompleteMessage = {
    type: 'run_complete';
    conversationId: string;
    runId: string;
    data: { response: string; stepId: number };
};

export type StepStartMessage = {
    type: 'step_start';
    conversationId: string;
    runId: string;
    data: { thought?: string; message?: string; toolCalls: ToolCall[] };
};

export type StepEndMessage = {
    type: 'step_end';
    conversationId: string;
    runId: string;
    data: {
        thought?: string;
        message?: string;
        toolCalls: ToolCall[];
        toolResults: ToolResult[];
        stepId: number;
        metrics?: Metrics;
    };
};

export type ConfirmationRequestMessage = {
    type: 'confirmation_request';
    conversationId: string;
    runId: string;
    data: ConfirmationRequest;
};

export type UserStepSavedMessage = {
    type: 'user_step_saved';
    conversationId: string;
    runId: string;
    clientMessageId: string;
    stepId: number;
};

export type BillingErrorMessage = {
    type: 'billing_error';
    conversationId?: string;
    runId?: string;
    error: BillingError;
};

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

