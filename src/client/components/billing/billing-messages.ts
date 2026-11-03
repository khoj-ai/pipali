// Pool of friendly billing messages for chat thread display

import i18n from '../../i18n';
import type { BillingAlertCode } from '../../types/billing';

function formatUsd(amount: number): string {
    const fractionDigits = Number.isInteger(amount) ? 0 : 2;
    return new Intl.NumberFormat(i18n.language, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
    }).format(amount);
}

/**
 * Get a random friendly message for the given billing error code.
 * With free credits on offer for adding a card, tell the user about them instead.
 */
export function getRandomBillingMessage(code: BillingAlertCode, cardBonusUsd?: number): string {
    if (cardBonusUsd !== undefined) return getCardBonusMessage(cardBonusUsd);

    const key = code === 'insufficient_credits'
        ? 'billing.insufficientCredits.messages'
        : 'billing.spendLimit.messages';

    const messages = i18n.t(key, { returnObjects: true }) as string[];
    const index = Math.floor(Math.random() * messages.length);
    // Array always has at least one element, non-null assertion is safe
    return messages[index]!;
}

export function getCardBonusMessage(cardBonusUsd: number): string {
    return i18n.t('billing.cardBonus.message', { amount: formatUsd(cardBonusUsd) });
}

/**
 * Get the action button label for the given billing error code.
 */
export function getBillingActionLabel(code: BillingAlertCode, cardBonusUsd?: number): string {
    if (cardBonusUsd !== undefined) return i18n.t('billing.cardBonus.action');
    return code === 'insufficient_credits'
        ? i18n.t('billing.insufficientCredits.action')
        : i18n.t('billing.spendLimit.action');
}

/**
 * Get the title for the given billing error code.
 */
export function getBillingTitle(code: BillingAlertCode, cardBonusUsd?: number): string {
    if (cardBonusUsd !== undefined) return i18n.t('billing.cardBonus.title');
    return code === 'insufficient_credits'
        ? i18n.t('billing.insufficientCredits.title')
        : i18n.t('billing.spendLimit.title');
}
