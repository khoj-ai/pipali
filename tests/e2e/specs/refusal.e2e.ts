/**
 * Refusal Tests
 *
 * What the chat shows when a model declines to respond, and that the conversation
 * stays usable afterwards.
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

test.describe('Model refusal', () => {
    test('a refusal explains why and what to try next, and the chat carries on', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('decline with a reason');

        const card = page.locator('.run-error-message');
        await expect(card).toBeVisible();
        await expect(card.locator('.run-error-message-title')).toHaveText('The model declined this request');
        await expect(card.locator('.run-error-message-text')).toHaveText(
            "The model won't write out its internal reasoning. Ask for a short explanation of the answer, or a summary of what it did, and send it again."
        );

        await chatPage.sendMessage('hello');
        await expect(page.getByText('Quick response completed!')).toBeVisible();
    });
});
