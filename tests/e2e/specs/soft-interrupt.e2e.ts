/**
 * Soft Interrupt Tests
 *
 * Soft interrupt = sending a new message while a run is active.
 * The server should finish the current step, stop the active run, then start a new run.
 *
 * Key behaviors:
 * - Current step completes (tool results are NOT marked [interrupted])
 * - Active run stops with reason 'soft_interrupt'
 * - New run starts automatically with the queued message
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

test.describe('Soft Interrupt', () => {
    let chatPage: ChatPage;

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
    });

    test('sending a message while processing starts a new run', async ({ page }) => {
        // Start a slow multi-step task
        await chatPage.sendMessage('run a pausable analysis');

        await chatPage.waitForProcessing();
        const convId = await chatPage.waitForConversationId();
        expect(convId).toBeTruthy();

        // Wait for at least one step to start
        await chatPage.waitForThoughts();

        // Send a new message to trigger soft interrupt
        await chatPage.sendMessage('you good');

        // Wait for the new run to complete
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        // Verify both user messages are present
        const userMessages = await chatPage.getUserMessages();
        expect(userMessages.length).toBe(2);
        expect(userMessages[0]).toContain('pausable');
        expect(userMessages[1]).toContain('you good');

        // The last response should be from the second message
        const response = await chatPage.getLastAssistantMessage();
        expect(response.toLowerCase()).toContain('great');

        // Key assertion: Soft interrupt should NOT leave interrupted tool results.
        // Tool results should complete normally before the run stops.
        await expect(page.locator('.thought-item:has-text("[interrupted]")')).toHaveCount(0);
    });

    test('multiple soft interrupts queue and process in order', async ({ page }) => {
        // Start a slow task
        await chatPage.sendMessage('run a pausable analysis');

        await chatPage.waitForProcessing();
        await chatPage.waitForThoughts();

        // Queue two messages while the run is still active
        await chatPage.sendMessage('hello');
        await chatPage.sendMessage('you good');

        // Wait for all runs to complete
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        // Verify all user messages are present in order
        const userMessages = await chatPage.getUserMessages();
        expect(userMessages).toHaveLength(3);
        expect(userMessages[0]).toContain('pausable');
        expect(userMessages[1]).toBe('hello');
        expect(userMessages[2]).toBe('you good');

        // Each user message should have a corresponding assistant response
        const counts = await chatPage.getMessageCount();
        expect(counts.assistant).toBe(3);

        // The last response should be from the last queued message
        const response = await chatPage.getLastAssistantMessage();
        expect(response.toLowerCase()).toContain('great');

        // Soft interrupts should NOT produce [interrupted] tool results
        await expect(page.locator('.thought-item:has-text("[interrupted]")')).toHaveCount(0);
    });

    test('soft interrupt during step execution waits for step to complete', async ({ page }) => {
        // Start a slow task with visible tool calls
        await chatPage.sendMessage('run a pausable analysis');

        await chatPage.waitForProcessing();

        // Wait for at least one pending tool call to appear
        await page.locator('.thought-item.pending').first().waitFor({ state: 'visible', timeout: 15000 });

        // Send soft interrupt while tool is executing
        await chatPage.sendMessage('you good');

        // Wait for completion
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        // Key assertion: Soft interrupt should NOT leave interrupted tool results
        // This verifies the step completed normally before the run stopped
        await expect(page.locator('.thought-item:has-text("[interrupted]")')).toHaveCount(0);
    });
});
