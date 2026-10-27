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

    test('interrupting a streaming final response preserves it across reload', async ({ page }) => {
        // Slow no-tool answer: still in flight when we interrupt below.
        await chatPage.sendMessage('answer then interrupt');
        await chatPage.waitForProcessing();
        const convId = await chatPage.waitForConversationId();
        expect(convId).toBeTruthy();

        // Interrupt while the final answer is still in flight.
        await chatPage.sendMessage('you good');

        // Both runs finish: interrupted answer, then follow-up.
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        const userMessages = await chatPage.getUserMessages();
        expect(userMessages).toHaveLength(2);
        expect(userMessages[0]).toContain('answer then interrupt');
        expect(userMessages[1]).toContain('you good');

        // The interrupted answer must be completed, not discarded.
        const finalAnswer = chatPage.assistantMessages.filter({ hasText: 'Final answer that must survive the interrupt.' });
        await expect(finalAnswer).toHaveCount(1);

        // Reload: the answer must persist (saved to the DB, not lost on interrupt).
        await chatPage.gotoConversation(convId);
        await chatPage.waitForConversationHistory();
        await expect(finalAnswer).toHaveCount(1);
    });

    test('soft interrupt during step execution waits for step to complete', async ({ page, request }) => {
        await chatPage.sendMessage('work through a long step');
        const convId = await chatPage.waitForConversationId();

        // Once approved, the command holds its step open for seconds
        await chatPage.clickConfirmationButton('yes');
        await expect(page.locator('.thought-item.pending')).toBeVisible();

        await chatPage.sendMessage('you good');
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        // The step ran to completion rather than being cut short
        await expect(page.locator('.thought-item:has-text("[interrupted]")')).toHaveCount(0);
        const res = await request.get(`/api/chat/${convId}/history`);
        const { history } = await res.json() as {
            history: Array<{ message?: string; observation?: { results?: Array<{ content?: unknown }> } }>;
        };
        const toolOutput = history.flatMap(s => s.observation?.results ?? []).map(r => String(r.content)).join('\n');
        expect(toolOutput).toContain('long-step-finished');

        // The run stopped at that step instead of answering, so the interrupt landed mid-step
        expect(history.map(s => s.message)).not.toContain('The long step is done.');
    });
});
