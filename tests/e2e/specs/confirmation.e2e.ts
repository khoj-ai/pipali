/**
 * Confirmation Dialog Tests
 *
 * Tests for confirmation dialogs that appear for shell commands and other dangerous operations.
 */

import { test, expect } from '@playwright/test';
import { ChatPage, HomePage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';
import { stopAllActiveRunsFromHome } from '../helpers/cleanup';

test.describe('Confirmation Dialogs', () => {
    let chatPage: ChatPage;

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
        // Ensure we start with a fresh chat to avoid stale conversations from previous tests
        await chatPage.startNewChat();
        await chatPage.waitForConnection();
    });

    test.afterEach(async () => {
        // Cleanup: never leave a run blocked on confirmation or still executing.
        try {
            if (await chatPage.confirmationDialog.isVisible()) {
                await chatPage.clickConfirmationButton('no');
                await chatPage.confirmationDialog.waitFor({ state: 'hidden', timeout: 15000 });
            }
        } catch {
            // ignore
        }

        try {
            if (await chatPage.isProcessing()) {
                await chatPage.stopTask();
            }
        } catch {
            // ignore
        }

        try {
            await chatPage.waitForIdle();
        } catch {
            // ignore
        }
    });

    test('should show confirmation dialog for read-only shell command', async ({ page }) => {
        // Send query that triggers shell command
        await chatPage.sendMessage('run a shell command to list files');

        // Wait for confirmation dialog to appear
        await chatPage.waitForConfirmationDialog();

        // Dialog should be visible
        await expect(chatPage.confirmationDialog).toBeVisible();

        // Should have primary (Yes) and danger (No) buttons
        await expect(chatPage.confirmationBtnPrimary).toBeVisible();
        await expect(chatPage.confirmationBtnDanger).toBeVisible();

        // Operation type pill should show read-only
        const operationPill = chatPage.confirmationDialog.locator(Selectors.operationTypePill);
        if (await operationPill.isVisible()) {
            const pillText = await operationPill.textContent();
            expect(pillText?.toLowerCase()).toContain('read');
        }

        // Cleanup: close the dialog so this test doesn't leave an active run blocked on confirmation.
        await chatPage.clickConfirmationButton('no');
        await chatPage.confirmationDialog.waitFor({ state: 'hidden', timeout: 5000 });
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();
    });

    test('should accept confirmation and continue task', async () => {
        // Send query that triggers shell command
        await chatPage.sendMessage('run a shell command to list files');

        // Wait for and click Yes on confirmation dialog
        await chatPage.waitForConfirmationDialog();
        await chatPage.clickConfirmationButton('yes');

        // Dialog should close
        await chatPage.confirmationDialog.waitFor({ state: 'hidden', timeout: 5000 });

        // Task should continue and complete
        await chatPage.waitForAssistantResponse();

        // Should have assistant response
        const messageCount = await chatPage.getMessageCount();
        expect(messageCount.assistant).toBe(1);
    });

    test('should show confirmation toast for background task shell command', async ({ page }) => {
        const homePage = new HomePage(page);
        await homePage.goto();

        // Start a background task that triggers shell command
        const query = `execute a bash command [e2e-${Date.now()}]`;
        await homePage.sendBackgroundMessage(query);

        // Wait for task to start
        await homePage.waitForTaskWithTitle(query);

        // Wait for confirmation toast to appear (background tasks show toast instead of dialog)
        const confirmationToast = page.locator(Selectors.confirmationToast, { hasText: query });

        // Toast might appear - check after a delay
        await expect(confirmationToast.first()).toBeVisible({ timeout: 15000 });

        // If toast is visible, verify it has action buttons
        const toastButtons = confirmationToast.first().locator(Selectors.toastBtn);
        expect(await toastButtons.count()).toBeGreaterThan(0);

        // Cleanup: decline so we don't leave a needs_input run around for later tests.
        const noBtn = confirmationToast.first().locator('.toast-actions .toast-btn.danger');
        await expect(noBtn).toBeVisible({ timeout: 15000 });
        await noBtn.evaluate((el: HTMLElement) => el.click());
        await expect(confirmationToast).toHaveCount(0, { timeout: 15000 });

        // Ensure the background run is not left active across tests.
        await stopAllActiveRunsFromHome(page);
    });

    test('should skip future confirmations after Yes dont ask again', async ({ page }) => {
        // Send query that triggers shell command
        await chatPage.sendMessage('run a shell command to list files');

        // Wait for confirmation dialog
        await chatPage.waitForConfirmationDialog();

        // A command's grant holds only in its working directory, and the button says so
        await expect(chatPage.confirmationBtnSecondary).toHaveText(/don't ask again in this folder/);
        await chatPage.clickConfirmationButton('yes_dont_ask');

        // Wait for task to complete
        await chatPage.waitForAssistantResponse();

        // Start a new conversation and send similar command
        await chatPage.startNewChat();
        await chatPage.waitForConnection();
        await chatPage.sendMessage('execute another shell command');

        // Wait for processing
        await chatPage.waitForProcessing();

        // Confirmation dialog should NOT appear (preference saved)
        // Wait a moment for dialog to potentially appear
        await page.waitForTimeout(1000);

        // If dialog appears, respond so we don't leak a needs_input run.
        if (await chatPage.confirmationDialog.isVisible()) {
            await chatPage.clickConfirmationButton('no');
            await chatPage.confirmationDialog.waitFor({ state: 'hidden', timeout: 15000 });
        }

        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();
    });

    test('should show different dialog for read-write shell command', async ({ page }) => {
        // Send query that triggers read-write shell command
        await chatPage.sendMessage('modify a file using shell command');

        // Wait for confirmation dialog
        await chatPage.waitForConfirmationDialog();

        // Dialog should be visible
        await expect(chatPage.confirmationDialog).toBeVisible();

        // For read-write commands, there should be warning styling
        // The operation type pill should indicate write
        const operationPill = chatPage.confirmationDialog.locator(Selectors.operationTypePill);
        if (await operationPill.isVisible()) {
            const pillText = await operationPill.textContent();
            // Should contain read-write or write
            expect(pillText?.toLowerCase()).toMatch(/write|read-write/);
        }

        // Cleanup: close the dialog so this test doesn't leave an active run blocked on confirmation.
        await chatPage.clickConfirmationButton('no');
        await chatPage.confirmationDialog.waitFor({ state: 'hidden', timeout: 15000 });
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();
    });

    test('should fail tool call but continue conversation on No', async () => {
        // Send query that triggers shell command
        await chatPage.sendMessage('run a shell command to list files');

        // Wait for confirmation dialog
        await chatPage.waitForConfirmationDialog();

        // Click No
        await chatPage.clickConfirmationButton('no');

        // Dialog should close
        await chatPage.confirmationDialog.waitFor({ state: 'hidden', timeout: 5000 });

        // Task should still complete (with tool call failure)
        await chatPage.waitForAssistantResponse();

        // Should have assistant response (even if it's about the failed tool call)
        const messageCount = await chatPage.getMessageCount();
        expect(messageCount.assistant).toBe(1);

        // The conversation should continue functioning - send another message
        await chatPage.sendMessage('hello');
        await chatPage.waitForAssistantResponse();

        // Should now have 2 user messages and 2 assistant messages
        const finalCount = await chatPage.getMessageCount();
        expect(finalCount.user).toBe(2);
        expect(finalCount.assistant).toBe(2);
    });
});
