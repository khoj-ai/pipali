/**
 * Billing Tests
 *
 * What the chat shows when the platform refuses a run the account can't pay for.
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

test.describe('Billing', () => {
    test('running out of starter credits offers free credits for adding a card', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('spend my last free credit');

        const offer = page.locator('.billing-message');
        await expect(offer).toBeVisible();
        await expect(offer.locator('.billing-message-title')).toHaveText('Free Credits Used Up');
        await expect(offer.locator('.billing-message-text')).toHaveText(
            "Add a card to get $20 more in free credits. Your card won't be charged."
        );
        const addCard = offer.locator('.billing-message-action');
        await expect(addCard).toHaveText('Add Card');
        await expect(addCard).toHaveAttribute('href', /\/dashboard\/billing$/);
    });
});
