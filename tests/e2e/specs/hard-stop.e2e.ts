/**
 * Hard Stop Tests
 *
 * Hard stop = stop button / Escape while a run is active.
 * Expected behavior:
 * - Abort research immediately
 * - Mark any pending tool calls as "[interrupted]"
 * - Enter "stopped" UI state (user must send a new message to start a new run)
 * - Run ends with reason 'user_stop'
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

test.describe('Hard Stop', () => {
    let chatPage: ChatPage;

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
    });

    test('stop button ends the run and enters stopped state', async () => {
        // Start a slow task
        await chatPage.sendMessage('run a pausable analysis');

        await chatPage.waitForProcessing();
        await chatPage.waitForThoughts();

        // Click stop button
        await chatPage.stopTask();

        // Verify stopped state
        expect(await chatPage.isProcessing()).toBe(false);
        expect(await chatPage.isStopped()).toBe(true);

        // User can send a new message to start a new run
        await chatPage.sendMessage('you good');
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        // Should no longer be in stopped state after new message completes
        expect(await chatPage.isStopped()).toBe(false);
    });

    test('escape key stops the run and marks pending tools as interrupted', async ({ page }) => {
        // Start a slow task
        await chatPage.sendMessage('run a pausable analysis');

        await chatPage.waitForProcessing();
        await chatPage.waitForConversationId();
        await chatPage.waitForThoughts();

        // Ensure we stop while a tool call is still pending
        await page.locator('.thought-item.pending').first().waitFor({ state: 'visible', timeout: 15000 });

        // Press Escape to stop
        await chatPage.pressEscape();

        // Verify stopped state via input hint
        await expect(chatPage.inputHint).toContainText(/stopped/i, { timeout: 15000 });
        await chatPage.waitForIdle();
        expect(await chatPage.isStopped()).toBe(true);

        // Expand thoughts to inspect results
        await chatPage.expandThoughts();

        // Hard stop should mark in-progress tool calls as interrupted
        await expect(page.locator('.thought-item:has-text("[interrupted]")').first()).toBeVisible({ timeout: 15000 });
        const interruptedCount = await page.locator('.thought-item:has-text("[interrupted]")').count();
        expect(interruptedCount).toBeGreaterThanOrEqual(1);

        // No pending items should remain after stop
        await expect(page.locator('.thought-item.pending')).toHaveCount(0);
    });

    test('stop during confirmation closes the dialog and stops the run', async () => {
        // Trigger a shell command which requires confirmation
        await chatPage.sendMessage('run command to list files');

        await chatPage.waitForProcessing();

        // Wait for confirmation dialog to appear
        await chatPage.confirmationDialog.waitFor({ state: 'visible', timeout: 15000 });

        // Click stop while confirmation is pending
        await chatPage.stopTask();

        // Confirmation dialog should close
        await chatPage.confirmationDialog.waitFor({ state: 'hidden', timeout: 15000 });

        // Should be in stopped state
        expect(await chatPage.isStopped()).toBe(true);
    });

    test('stop clears any queued messages', async () => {
        // Start a slow task
        await chatPage.sendMessage('run a pausable analysis');

        await chatPage.waitForProcessing();
        await chatPage.waitForThoughts();

        // Queue a message (soft interrupt)
        await chatPage.sendMessage('hello');

        // Then hard stop
        await chatPage.stopTask();

        // Should be in stopped state
        expect(await chatPage.isStopped()).toBe(true);

        // The queued message should NOT start a new run automatically
        // (that's the difference between hard stop and soft interrupt)
        await chatPage.waitForIdle();
        expect(await chatPage.isProcessing()).toBe(false);

        // There should only be the original user message, not the queued one being processed
        // The queued message is still in the UI but no assistant response for it yet
        const counts = await chatPage.getMessageCount();
        // Both user messages show, but only one assistant response (the first run's interrupted response)
        expect(counts.user).toBe(2);
        expect(counts.assistant).toBe(1);
    });
});
