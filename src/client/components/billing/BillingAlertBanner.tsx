// Billing alert banner for sidebar display

import React from 'react';
import { AlertTriangle, CreditCard, X, ExternalLink as ExternalLinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from '../ExternalLink';
import type { BillingAlert } from '../../types/billing';
import { getBillingActionLabel, getBillingTitle, getCardBonusMessage } from './billing-messages';

interface BillingAlertBannerProps {
    alerts: BillingAlert[];
    platformFrontendUrl: string;
    onDismissAll: () => void;
}

/**
 * Compact billing alert banner for the sidebar.
 * Shows consolidated billing alerts with a CTA to resolve.
 */
export function BillingAlertBanner({
    alerts,
    platformFrontendUrl,
    onDismissAll,
}: BillingAlertBannerProps) {
    const { t } = useTranslation();
    const latestAlert = alerts[0];
    if (!latestAlert) return null;

    const isCreditsError = latestAlert.code === 'insufficient_credits';
    const cardBonusUsd = latestAlert.details?.card_bonus_usd;
    const billingUrl = `${platformFrontendUrl}/dashboard/billing`;
    const title = getBillingTitle(latestAlert.code, cardBonusUsd);
    const actionLabel = getBillingActionLabel(latestAlert.code, cardBonusUsd);

    return (
        <div className={`billing-alert-banner ${isCreditsError ? '' : 'billing-alert-banner--limit'}`}>
            <div className="billing-alert-content">
                <div className="billing-alert-header">
                    <span className="billing-alert-icon">
                        {isCreditsError ? <CreditCard size={16} /> : <AlertTriangle size={16} />}
                    </span>
                    <span className="billing-alert-title">{title}</span>
                    <button
                        className="billing-alert-dismiss"
                        onClick={onDismissAll}
                        aria-label={t('sidebar.dismissBillingAlert')}
                    >
                        <X size={14} />
                    </button>
                </div>
                <p className="billing-alert-message">
                    {cardBonusUsd !== undefined
                        ? getCardBonusMessage(cardBonusUsd)
                        : isCreditsError
                            ? t('billing.addCreditsMessage')
                            : t('billing.increaseLimitMessage')}
                </p>
                {alerts.length > 1 && (
                    <span className="billing-alert-count">
                        {t('billing.moreTasksAffected', { count: alerts.length - 1 })}
                    </span>
                )}
                <ExternalLink
                    href={billingUrl}
                    className="billing-alert-action"
                >
                    {actionLabel}
                    <ExternalLinkIcon size={12} />
                </ExternalLink>
            </div>
        </div>
    );
}
