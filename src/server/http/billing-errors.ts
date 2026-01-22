/**
 * Error types for platform billing errors (402 Payment Required)
 */

export type BillingErrorCode = 'insufficient_credits' | 'spend_limit_reached';

export interface BillingErrorDetails {
    code: BillingErrorCode;
    message: string;
    credits_balance_cents?: number;
    current_period_spent_cents?: number;
    spend_hard_limit_cents?: number;
}

/**
 * Error thrown when platform returns 402 Payment Required.
 * Contains structured billing information for proper UI handling.
 */
export class PlatformBillingError extends Error {
    public readonly code: BillingErrorCode;
    public readonly details: BillingErrorDetails;

    constructor(details: BillingErrorDetails) {
        super(details.message);
        this.name = 'PlatformBillingError';
        this.code = details.code;
        this.details = details;
    }

    /**
     * Parse a 402 error response into a PlatformBillingError.
     * Returns null if the response is not a valid billing error.
     */
    static fromResponse(status: number, body: string): PlatformBillingError | null {
        if (status !== 402) return null;

        try {
            const parsed = JSON.parse(body);
            if (parsed.error?.type === 'billing_error') {
                return new PlatformBillingError({
                    code: parsed.error.code,
                    message: parsed.error.message,
                    credits_balance_cents: parsed.error.credits_balance_cents,
                    current_period_spent_cents: parsed.error.current_period_spent_cents,
                    spend_hard_limit_cents: parsed.error.spend_hard_limit_cents,
                });
            }
        } catch {
            // Not valid JSON or not a billing error format
        }

        return null;
    }
}
