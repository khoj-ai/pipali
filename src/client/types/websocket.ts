// WebSocket message types for server communication

export type BillingErrorCode = 'insufficient_credits' | 'spend_limit_reached';

export interface BillingError {
    code: BillingErrorCode;
    message: string;
    credits_balance_cents?: number;
    current_period_spent_cents?: number;
    spend_hard_limit_cents?: number;
}

export type WebSocketMessage = {
    type: 'iteration' | 'complete' | 'error' | 'research' | 'pause' | 'confirmation_request' | 'conversation_created' | 'tool_call_start' | 'user_message_persisted' | 'billing_error';
    data?: any;
    error?: string | BillingError;
    conversationId?: string;
};
