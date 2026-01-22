// Pool of friendly billing messages for chat thread display

import type { BillingAlertCode } from '../../types/billing';

const INSUFFICIENT_CREDITS_MESSAGES = [
    "I've run out of credits to help you right now. Top up your balance to continue our conversation.",
    "Looks like the credits tank is empty! Add some credits and I'll be ready to help again.",
    "I'd love to help, but we're out of credits. A quick top-up will get us going again.",
    "Time for a refill! Add credits to your account and let's pick up where we left off.",
];

const SPEND_LIMIT_MESSAGES = [
    "You've hit your spending limit for this period. Adjust your limits or wait for the next billing cycle to continue.",
    "We've reached your spending cap. You can increase your limit or we can continue next billing period.",
    "Spending limit reached for this period. Adjust your settings to keep going, or let's reconnect later.",
];

/**
 * Get a random friendly message for the given billing error code.
 */
export function getRandomBillingMessage(code: BillingAlertCode): string {
    const messages = code === 'insufficient_credits'
        ? INSUFFICIENT_CREDITS_MESSAGES
        : SPEND_LIMIT_MESSAGES;

    const index = Math.floor(Math.random() * messages.length);
    // Array always has at least one element, non-null assertion is safe
    return messages[index]!;
}

/**
 * Get the action button label for the given billing error code.
 */
export function getBillingActionLabel(code: BillingAlertCode): string {
    return code === 'insufficient_credits' ? 'Add Credits' : 'Manage Limits';
}

/**
 * Get the title for the given billing error code.
 */
export function getBillingTitle(code: BillingAlertCode): string {
    return code === 'insufficient_credits' ? 'Credits Depleted' : 'Spend Limit Reached';
}
