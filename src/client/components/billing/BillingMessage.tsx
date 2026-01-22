// Billing message component for chat thread display

import { CreditCard, AlertTriangle, ExternalLink } from 'lucide-react';
import type { BillingAlertCode } from '../../types/billing';
import { getBillingActionLabel, getBillingTitle } from './billing-messages';

interface BillingMessageProps {
    code: BillingAlertCode;
    message: string;
    platformUrl: string;
}

/**
 * A styled billing message for the chat thread.
 * Shows a friendly message with a CTA to resolve the billing issue.
 */
export function BillingMessage({ code, message, platformUrl }: BillingMessageProps) {
    const billingUrl = `${platformUrl}/dashboard/billing`;
    const isCreditsError = code === 'insufficient_credits';
    const title = getBillingTitle(code);
    const actionLabel = getBillingActionLabel(code);

    return (
        <div className={`billing-message ${isCreditsError ? 'billing-message--credits' : 'billing-message--limit'}`}>
            <div className="billing-message-header">
                <span className="billing-message-icon">
                    {isCreditsError ? <CreditCard size={18} /> : <AlertTriangle size={18} />}
                </span>
                <span className="billing-message-title">{title}</span>
            </div>
            <p className="billing-message-text">{message}</p>
            <a
                href={billingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="billing-message-action"
            >
                {actionLabel}
                <ExternalLink size={14} />
            </a>
        </div>
    );
}
