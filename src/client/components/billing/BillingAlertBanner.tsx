// Billing alert banner for sidebar display

import React from 'react';
import { AlertTriangle, CreditCard, X, ExternalLink } from 'lucide-react';
import type { BillingAlert } from '../../types/billing';
import { getBillingActionLabel, getBillingTitle } from './billing-messages';

interface BillingAlertBannerProps {
    alerts: BillingAlert[];
    platformUrl: string;
    onDismissAll: () => void;
}

/**
 * Compact billing alert banner for the sidebar.
 * Shows consolidated billing alerts with a CTA to resolve.
 */
export function BillingAlertBanner({
    alerts,
    platformUrl,
    onDismissAll,
}: BillingAlertBannerProps) {
    const latestAlert = alerts[0];
    if (!latestAlert) return null;

    const isCreditsError = latestAlert.code === 'insufficient_credits';
    const billingUrl = `${platformUrl}/billing`;
    const title = getBillingTitle(latestAlert.code);
    const actionLabel = getBillingActionLabel(latestAlert.code);

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
                        aria-label="Dismiss billing alert"
                    >
                        <X size={14} />
                    </button>
                </div>
                <p className="billing-alert-message">
                    {isCreditsError
                        ? 'Add credits to continue using Pipali.'
                        : 'Increase your spending limit to continue.'}
                </p>
                {alerts.length > 1 && (
                    <span className="billing-alert-count">
                        +{alerts.length - 1} more {alerts.length === 2 ? 'task' : 'tasks'} affected
                    </span>
                )}
                <a
                    href={billingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="billing-alert-action"
                >
                    {actionLabel}
                    <ExternalLink size={12} />
                </a>
            </div>
        </div>
    );
}
