/**
 * Run Lifecycle Tests
 *
 * Tests for the run lifecycle events: run_started, step_start, step_end, run_complete, run_stopped.
 * These tests document the expected behavior for the WebSocket refactoring.
 *
 * A "run" is a single streaming assistant response to exactly one user message.
 * Each run has a stable runId that connects all related events.
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';

test.describe('Run Lifecycle', () => {
    let chatPage: ChatPage;

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
    });

    test.describe('Normal Run Flow', () => {
        test('single message creates a run with proper lifecycle events', async ({ page }) => {
            // Send a message that triggers tool calls
            await chatPage.sendMessage('list the files in this directory');

            // Wait for processing to start (run_started equivalent)
            await chatPage.waitForProcessing();
            expect(await chatPage.isProcessing()).toBe(true);

            // Verify conversation ID is assigned (conversation_created)
            const convId = await chatPage.waitForConversationId();
            expect(convId).toBeTruthy();

            // Wait for thoughts to appear (step_start/step_end events)
            await chatPage.waitForThoughts();
            expect(await chatPage.thoughtsSection.isVisible()).toBe(true);
            await expect(chatPage.thoughtsSummary).toContainText(/1\s*steps?\s*taken/i);

            // Wait for completion (run_complete)
            await chatPage.waitForAssistantResponse();

            // Verify final response exists
            const response = await chatPage.getLastAssistantMessage();
            expect(response.length).toBeGreaterThan(0);
            expect(response).toContain('5 items');

            // Verify no longer processing (run complete)
            await chatPage.waitForIdle();
            expect(await chatPage.isProcessing()).toBe(false);
            expect(await chatPage.isStopped()).toBe(false);

            // Verify no pending tool calls remain (pending items have .pending class)
            await chatPage.expandThoughts();
            await expect(page.locator('.thought-item.pending')).toHaveCount(0);
            // Tool result should be rendered in the thoughts section (step_end)
            // The list_files tool should have been executed and returned results
            const thoughtsList = page.locator('.thoughts-list');
            await expect(thoughtsList).toBeVisible();
            // Verify the tool call was executed (List command appears)
            await expect(thoughtsList).toContainText('List');
            // Completed step should show a success indicator
            await expect(page.locator('.thought-step.success')).toHaveCount(1);
        });

        test('zero-step run (direct response, no tool calls)', async () => {
            // Send a simple message that doesn't require tool calls
            await chatPage.sendMessage('you good');

            // Wait for completion
            await chatPage.waitForAssistantResponse();

            // Verify response exists
            const response = await chatPage.getLastAssistantMessage();
            expect(response.length).toBeGreaterThan(0);

            // Verify thoughts section is either hidden or has no tool steps
            const thoughtsVisible = await chatPage.thoughtsSection.isVisible();
            if (thoughtsVisible) {
                await chatPage.expandThoughts();
                const thoughtCount = await chatPage.getThoughtCount();
                expect(thoughtCount).toBeLessThanOrEqual(1);
            }

            // Verify idle state
            await chatPage.waitForIdle();
        });

        test('multi-step run with tool calls shows all steps', async ({ page }) => {
            // Send a query that triggers multiple tool calls (3 iterations)
            await chatPage.sendMessage('analyze my codebase slowly');

            // Wait for processing
            await chatPage.waitForProcessing();

            // Wait for multiple thoughts to accumulate
            await chatPage.waitForThoughts();
            await expect(chatPage.thoughtsSummary).toContainText(/3\s*steps?\s*taken/i, { timeout: 60000 });

            // Expand thoughts section and verify count
            await chatPage.expandThoughts();
            const thoughtCount = await chatPage.getThoughtCount();
            expect(thoughtCount).toBeGreaterThanOrEqual(3);
            // Each iteration should include the grep pattern in the rendered tool args
            // Use .thoughts-list to scope to expanded thoughts
            const thoughtsList = page.locator('.thoughts-list');
            await expect(thoughtsList).toContainText('pattern-1');
            await expect(thoughtsList).toContainText('pattern-2');
            await expect(thoughtsList).toContainText('pattern-3');

            // Should show multiple tool call entries
            await expect(chatPage.page.locator('.thought-tool')).toHaveCount(3);

            // Wait for completion
            await chatPage.waitForAssistantResponse();
            await chatPage.waitForIdle();
            expect(await chatPage.isStopped()).toBe(false);

            // Verify thoughts are preserved after completion
            const postStopCount = await chatPage.getThoughtCount();
            expect(postStopCount).toBeGreaterThanOrEqual(3);
        });
    });

    test.describe('Run State Transitions', () => {
        test('user message appears immediately (optimistic update)', async () => {
            const testMessage = 'test message for optimistic update';

            // Send message
            await chatPage.inputTextarea.fill(testMessage);
            await chatPage.sendButton.click();

            // User message should appear immediately (before server responds)
            await expect(chatPage.page.locator(Selectors.userMessage).last().locator(Selectors.messageContent)).toHaveText(
                testMessage,
                { timeout: 5000 }
            );

            // Input should be cleared
            expect(await chatPage.isInputEmpty()).toBe(true);

            // Verify server received it by waiting for the assistant response.
            await chatPage.waitForAssistantResponse();
            await chatPage.waitForIdle();
        });

        test('conversation ID is assigned on first message', async () => {
            // Initially no conversation ID
            const initialConvId = await chatPage.getConversationId();
            expect(initialConvId).toBeNull();

            // Send message
            await chatPage.sendMessage('hello');

            // Conversation ID should be assigned
            const convId = await chatPage.waitForConversationId();
            expect(convId).toBeTruthy();
            expect(convId).toMatch(/^[a-z0-9-]+$/); // UUID format
        });

        test('subsequent messages use same conversation ID', async () => {
            // First message
            await chatPage.sendMessage('first message');
            const firstConvId = await chatPage.waitForConversationId();

            // Wait for completion
            await chatPage.waitForAssistantResponse();
            await chatPage.waitForIdle();

            // Second message
            await chatPage.sendMessage('second message');
            await chatPage.waitForProcessing();

            // Should use same conversation ID
            const secondConvId = await chatPage.getConversationId();
            expect(secondConvId).toBe(firstConvId);

            // Wait for completion
            await chatPage.waitForAssistantResponse();

            // Verify both messages are present
            const messages = await chatPage.getUserMessages();
            expect(messages).toHaveLength(2);
            expect(messages[0]).toBe('first message');
            expect(messages[1]).toBe('second message');
        });
    });

    test.describe('Sidebar State Tracking', () => {
        test('sidebar shows active marker during processing', async () => {
            await chatPage.sendMessage('analyze my codebase slowly');
            await chatPage.waitForProcessing();

            // Sidebar should show active task marker
            await chatPage.waitForActiveTaskInSidebar();
            expect(await chatPage.hasActiveTaskInSidebar()).toBe(true);
        });

        test('sidebar active marker disappears on completion', async () => {
            await chatPage.sendMessage('you good');
            await chatPage.waitForAssistantResponse();
            await chatPage.waitForIdle();

            // Active marker should be gone
            await chatPage.waitForNoActiveTaskInSidebar();
            expect(await chatPage.hasActiveTaskInSidebar()).toBe(false);
        });

        test('sidebar shows latest reasoning as subtitle during processing', async () => {
            await chatPage.sendMessage('analyze my codebase slowly');
            await chatPage.waitForProcessing();
            await chatPage.waitForActiveTaskInSidebar();

            // Wait for some thoughts
            await chatPage.waitForThoughts();

            // Subtitle should show reasoning
            const subtitle = await chatPage.getConversationSubtitleFromSidebar();
            expect(subtitle.length).toBeGreaterThan(0);
        });
    });

    test.describe('Error Handling', () => {
        test('error during processing stops the run gracefully', async ({ page }) => {
            // We don't have a dedicated error scenario in the mock LLM;
            // this ensures "fast" responses don't leave the UI stuck in processing.
            await chatPage.sendMessage('quick test');
            await chatPage.waitForAssistantResponse();
            await chatPage.waitForIdle();
            expect(await chatPage.isProcessing()).toBe(false);
        });
    });

    test.describe('Page Refresh During Run', () => {
        test('refresh during processing restores conversation state', async () => {
            // Start a slow task
            await chatPage.sendMessage('run a pausable analysis');
            await chatPage.waitForProcessing();

            // Get conversation ID
            const convId = await chatPage.waitForConversationId();

            // Wait for at least one completed tool call so history is persisted
            await chatPage.waitForThoughts();
            await expect(chatPage.page.locator('.thought-item:not(.pending)').first()).toBeVisible({ timeout: 30000 });

            // Refresh the page
            await chatPage.page.reload();
            await chatPage.waitForConnection();

            // Conversation should be loaded from DB
            await chatPage.page.waitForTimeout(1000);

            // User message should be present (from DB)
            const messages = await chatPage.getUserMessages();
            expect(messages.length).toBeGreaterThanOrEqual(1);
            expect(messages[0]).toContain('run a pausable analysis');

            // URL should have same conversation ID
            const postRefreshConvId = await chatPage.getConversationId();
            expect(postRefreshConvId).toBe(convId);

            // Should not be stuck processing after refresh/disconnect.
            await chatPage.waitForIdle();
        });

        test('refresh after completion shows full history', async () => {
            // Complete a task
            await chatPage.sendMessage('you good');
            await chatPage.waitForAssistantResponse();
            await chatPage.waitForIdle();

            const convId = await chatPage.getConversationId();
            const originalResponse = await chatPage.getLastAssistantMessage();

            // Refresh
            await chatPage.page.reload();
            await chatPage.waitForConnection();
            await chatPage.page.waitForTimeout(1000);

            // History should be restored
            const messages = await chatPage.getUserMessages();
            expect(messages).toContain('you good');

            // Response should match
            const refreshedResponse = await chatPage.getLastAssistantMessage();
            expect(refreshedResponse).toBe(originalResponse);
        });
    });
});
