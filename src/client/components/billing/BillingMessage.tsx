// Billing message component for chat thread display

import { useTranslation } from 'react-i18next';
import { CreditCard, AlertTriangle, ExternalLink as ExternalLinkIcon, X } from 'lucide-react';
import type { BillingAlertCode } from '../../types/billing';
import { getBillingActionLabel, getBillingTitle } from './billing-messages';
import { ExternalLink } from '../ExternalLink';

interface BillingMessageProps {
    code: BillingAlertCode;
    message: string;
    cardBonusUsd?: number;
    platformFrontendUrl: string;
    onContinue?: () => void;
    onDismiss?: () => void;
}

/**
 * A styled billing message for the chat thread.
 * Shows a friendly message with a CTA to resolve the billing issue.
 */
export function BillingMessage({ code, message, cardBonusUsd, platformFrontendUrl, onContinue, onDismiss }: BillingMessageProps) {
    const { t } = useTranslation();
    const billingUrl = `${platformFrontendUrl}/dashboard/billing`;
    const isCreditsError = code === 'insufficient_credits';
    const title = getBillingTitle(code, cardBonusUsd);
    const actionLabel = getBillingActionLabel(code, cardBonusUsd);

    return (
        <div className={`billing-message ${isCreditsError ? 'billing-message--credits' : 'billing-message--limit'}`}>
            <div className="billing-message-header">
                <span className="billing-message-icon">
                    {isCreditsError ? <CreditCard size={18} /> : <AlertTriangle size={18} />}
                </span>
                <span className="billing-message-title">{title}</span>
                {onDismiss && (
                    <button className="billing-message-dismiss" onClick={onDismiss} title={t('common.dismiss')}>
                        <X size={16} />
                    </button>
                )}
            </div>
            <p className="billing-message-text">{message}</p>
            <div className="billing-message-actions">
                <ExternalLink
                    href={billingUrl}
                    className="billing-message-action"
                >
                    {actionLabel}
                    <ExternalLinkIcon size={14} />
                </ExternalLink>
                {onContinue && (
                    <button className="billing-message-continue" onClick={onContinue}>
                        {t('billing.doneContinue')}
                    </button>
                )}
            </div>
        </div>
    );
}
