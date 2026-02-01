/**
 * Chat Flow Journey Test
 *
 * A comprehensive sequential test covering the complete user journey
 * through a conversation lifecycle, from new chat to completion.
 */

import { test, expect } from '@playwright/test';
import { ChatPage, HomePage } from '../helpers/page-objects';

// Use slow pausable query for reliable pause/resume testing
const PAUSABLE_QUERY = 'run a pausable analysis';

test.describe('Chat Flow - Complete User Journey', () => {
    test('complete chat lifecycle from new chat to completion', async ({ page, context }) => {
        const chatPage = new ChatPage(page);
        const homePage = new HomePage(page);

        // Clear any persisted state from previous runs
        await context.clearCookies();

        // ============================================
        // 1. Open new chat - verify empty state
        // ============================================
        // Navigate directly to "/" to ensure clean state
        await page.goto('/');
        await chatPage.waitForConnection();

        // Chat body should be empty (no messages)
        let messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(0);
        expect(messageCount.assistant).toBe(0);

        // Input should be focused and empty
        expect(await chatPage.isInputFocused()).toBe(true);
        expect(await chatPage.isInputEmpty()).toBe(true);

        // ============================================
        // 2. Send message - verify input clears, user message appears
        // ============================================
        await chatPage.inputTextarea.fill(PAUSABLE_QUERY);
        expect(await chatPage.isInputEmpty()).toBe(false);

        await chatPage.sendButton.click();

        // Input should be cleared after sending
        expect(await chatPage.isInputEmpty()).toBe(true);

        // User message should appear
        await page.waitForTimeout(300);
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(1);

        // ============================================
        // 3. Verify processing state (stop button, sidebar active marker)
        // ============================================
        await chatPage.waitForProcessing();
        expect(await chatPage.isProcessing()).toBe(true);

        // Stop button should be visible
        await expect(chatPage.stopButton).toBeVisible();

        // Sidebar should show active task marker
        await chatPage.waitForActiveTaskInSidebar();
        expect(await chatPage.hasActiveTaskInSidebar()).toBe(true);

        // ============================================
        // 4. Verify train of thought appears collapsed with steps
        // ============================================
        // Wait for thoughts to appear
        await chatPage.waitForThoughts();
        await expect(chatPage.thoughtsSection).toBeVisible();

        // Initially collapsed
        expect(await chatPage.isThoughtsExpanded()).toBe(false);

        // Summary should show step count
        const summary = await chatPage.getThoughtsSummary();
        expect(summary).toMatch(/\d+\s*step/i);

        // ============================================
        // 5. Expand thoughts, verify content
        // ============================================
        await chatPage.expandThoughts();
        expect(await chatPage.isThoughtsExpanded()).toBe(true);

        // Should have thought items
        const thoughtCount = await chatPage.getThoughtCount();
        expect(thoughtCount).toBeGreaterThan(0);

        // Collapse for cleaner view
        await chatPage.collapseThoughts();

        // ============================================
        // 6. Verify conversation ID is assigned
        // ============================================
        const convId = await chatPage.waitForConversationId();
        expect(convId).toBeTruthy();

        // ============================================
        // 7. Go to home page - verify active task card
        // ============================================
        await chatPage.goHome();

        // Should show task card for the running task
        await homePage.waitForTaskCount(1);
        expect(await homePage.getTaskCardCount()).toBeGreaterThanOrEqual(1);

        // Task should be running
        const status = await homePage.getTaskStatus(0);
        expect(status).toBe('running');

        // ============================================
        // 8. Return to chat - verify state persists
        // ============================================
        await homePage.clickTaskCard(0);
        await chatPage.waitForConnection();

        // Should be on the same conversation
        const currentConvId = await chatPage.getConversationId();
        expect(currentConvId).toBe(convId);

        // User message should still be there
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(1);

        // ============================================
        // 9. Stop - verify state on home page
        // ============================================
        // Wait for processing if needed
        if (await chatPage.isProcessing()) {
            await chatPage.stopTask();
        }

        // Verify stopped state
        expect(await chatPage.isStopped()).toBe(true);

        // Input hint should indicate stopped
        const hint = await chatPage.inputHint.textContent();
        expect(hint?.toLowerCase()).toContain('stopped');

        // Check home page shows stopped status
        await chatPage.goHome();

        // Wait for task to show stopped status
        await homePage.waitForTaskStatus(0, 'stopped');

        // Task should show stopped status
        const stoppedStatus = await homePage.getTaskStatus(0);
        expect(stoppedStatus).toBe('stopped');

        // ============================================
        // 10. Send follow-up - wait for completion
        // ============================================
        // Go back to chat
        await homePage.clickTaskCard(0);
        await chatPage.waitForConnection();

        await chatPage.sendMessage('continue');

        // Wait for task to complete
        await chatPage.waitForAssistantResponse();

        // ============================================
        // 11. Verify final response, inactive sidebar marker
        // ============================================
        // Should have assistant response
        messageCount = await chatPage.getMessageCount();
        // The stopped run keeps its assistant message (with thoughts), and the follow-up starts a new run.
        expect(messageCount.assistant).toBe(2);

        // Final response should be visible
        const response = await chatPage.getLastAssistantMessage();
        expect(response).toBeTruthy();
        expect(response.length).toBeGreaterThan(0);

        // Sidebar should no longer show active marker (task complete)
        await chatPage.waitForNoActiveTaskInSidebar();
        expect(await chatPage.hasActiveTaskInSidebar()).toBe(false);

        // ============================================
        // 12. Start new chat - verify clean state
        // ============================================
        await chatPage.startNewChat();
        await chatPage.waitForConnection();

        // Should be on a new chat (no conversation ID)
        const newChatConvId = await chatPage.getConversationId();
        expect(newChatConvId).toBeNull();

        // Chat body should be empty
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(0);
        expect(messageCount.assistant).toBe(0);

        // ============================================
        // 13. Send simple message - verify no thoughts section
        // ============================================
        await chatPage.sendMessage('you good');
        await chatPage.waitForAssistantResponse();

        // Should have response
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(1);
        expect(messageCount.assistant).toBe(1);

        // For simple responses without tool calls, thoughts section should not be visible
        // or should have minimal content
        const thoughtsVisible = await chatPage.thoughtsSection.isVisible();
        if (thoughtsVisible) {
            // If visible, should have no or minimal thoughts
            await chatPage.expandThoughts();
            const simpleThoughtCount = await chatPage.getThoughtCount();
            // Simple queries may have 0 thoughts
            expect(simpleThoughtCount).toBeLessThanOrEqual(1);
        }

        // ============================================
        // 14. Go to home - no active cards (all tasks completed)
        // ============================================
        await chatPage.goHome();
        await page.waitForTimeout(500);

        // Completed tasks should show as completed cards on home
        const taskCount = await homePage.getTaskCardCount();
        expect(taskCount).toBeGreaterThanOrEqual(1);
        const finalStatus = await homePage.getTaskStatus(0);
        expect(finalStatus).toBe('completed');
    });
});
