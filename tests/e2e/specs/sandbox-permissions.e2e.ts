/**
 * Pipali can reach its own API, so the permissions it works under are the user's to
 * grant, not Pipali's to take. Here it asks for a domain through a shell command, the
 * way it would in the app, and the user approves it.
 */

import { test, expect, type Page } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

async function allowedDomains(page: Page): Promise<string[]> {
    const response = await page.request.get('/api/user/sandbox');
    const config = await response.json() as { allowedDomains: string[] };
    return config.allowedDomains;
}

test.describe('Sandbox permission changes', () => {
    let chatPage: ChatPage;

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.startNewChat();
        await chatPage.waitForConnection();
    });

    test.afterEach(async () => {
        try {
            if (await chatPage.confirmationDialog.isVisible()) {
                await chatPage.clickConfirmationButton('no');
            }
            if (await chatPage.isProcessing()) {
                await chatPage.stopTask();
            }
            await chatPage.waitForIdle();
        } catch {
            // ignore
        }
    });

    test('applies a permission change the user approves', async ({ page }) => {
        await chatPage.sendMessage('allow e2e-approved through the sandbox');

        // The command Pipali runs to reach its own API, then the change it asks for
        await chatPage.clickConfirmationButton('yes');
        await expect(chatPage.confirmationDialog)
            .toContainText('Let commands reach: e2e-approved.example.com', { timeout: 20000 });
        await chatPage.clickConfirmationButton('yes');

        await chatPage.waitForAssistantResponse();
        expect(await allowedDomains(page)).toContain('e2e-approved.example.com');
    });
});
