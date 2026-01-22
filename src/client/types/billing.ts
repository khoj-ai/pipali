// Billing-related types for UI components

export type BillingAlertCode = 'insufficient_credits' | 'spend_limit_reached';

export interface BillingAlert {
    id: string;
    code: BillingAlertCode;
    message: string;
    conversationId?: string;
    conversationTitle?: string;
    source: 'chat' | 'automation';
    timestamp: Date;
    details?: {
        credits_balance_cents?: number;
        current_period_spent_cents?: number;
        spend_hard_limit_cents?: number;
    };
}
