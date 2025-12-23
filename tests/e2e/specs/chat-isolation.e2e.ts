/**
 * Chat Isolation Tests
 *
 * Tests to ensure conversations are properly isolated from each other.
 * Messages and responses from one conversation should not appear in another.
 */

import { test, expect } from '@playwright/test';
import { ChatPage, HomePage } from '../helpers/page-objects';

test.describe('Chat Isolation', () => {
    test('should show empty chat body and focused input on new chat', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // Chat body should be empty (no messages)
        const messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(0);
        expect(messageCount.assistant).toBe(0);

        // Input should be focused
        const isFocused = await chatPage.isInputFocused();
        expect(isFocused).toBe(true);

        // Input should be empty
        const isEmpty = await chatPage.isInputEmpty();
        expect(isEmpty).toBe(true);
    });

    test('should clear input after sending message', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // Fill input and verify it has content
        await chatPage.inputTextarea.fill('test message');
        expect(await chatPage.isInputEmpty()).toBe(false);

        // Send message
        await chatPage.sendButton.click();

        // Input should be cleared
        expect(await chatPage.isInputEmpty()).toBe(true);

        // User message should appear
        await page.waitForTimeout(500);
        const messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(1);
    });

    test('should show multi-turn conversation with separate thoughts sections', async ({
        page,
    }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // First turn with tool calls
        await chatPage.sendMessage('list all files');
        await chatPage.waitForAssistantResponse();

        // Should have first thoughts section
        const firstThoughtCount = await chatPage.getThoughtsSectionCount();
        expect(firstThoughtCount).toBeGreaterThanOrEqual(1);

        // Second turn with tool calls
        await chatPage.sendMessage('read the file content');
        await chatPage.waitForAssistantResponse();

        // Should have multiple thoughts sections (one per turn with tool calls)
        const secondThoughtCount = await chatPage.getThoughtsSectionCount();
        expect(secondThoughtCount).toBeGreaterThanOrEqual(firstThoughtCount);

        // Should have 2 user messages and 2 assistant messages
        const messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(2);
        expect(messageCount.assistant).toBe(2);
    });

    test('should not show responses from other conversations', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // Start first conversation
        await chatPage.sendMessage('first conversation question');
        await chatPage.waitForAssistantResponse();

        const firstConvId = await chatPage.getConversationId();
        const firstResponse = await chatPage.getLastAssistantMessage();
        const firstMessageCount = await chatPage.getMessageCount();

        expect(firstConvId).toBeTruthy();
        expect(firstResponse).toBeTruthy();
        expect(firstMessageCount.user).toBe(1);
        expect(firstMessageCount.assistant).toBe(1);

        // Start new conversation by navigating to home and starting fresh
        await page.goto('/');
        await chatPage.waitForConnection();

        // Send different message (will create new conversation)
        await chatPage.sendMessage('second conversation question');
        await chatPage.waitForAssistantResponse();

        const secondConvId = await chatPage.getConversationId();
        const secondMessageCount = await chatPage.getMessageCount();

        // Should be a different conversation
        expect(secondConvId).toBeTruthy();
        expect(secondConvId).not.toBe(firstConvId);
        expect(secondMessageCount.user).toBe(1);
        expect(secondMessageCount.assistant).toBe(1);

        // Go back to first conversation
        await page.goto(`/?conversationId=${firstConvId}`);
        await chatPage.waitForConnection();

        // Wait for messages to load
        await page.waitForTimeout(500);

        // Should only see first conversation's messages
        const restoredCount = await chatPage.getMessageCount();
        expect(restoredCount.user).toBe(1);
        expect(restoredCount.assistant).toBe(1);

        // Content should match original first conversation
        const restoredResponse = await chatPage.getLastAssistantMessage();
        expect(restoredResponse).toBe(firstResponse);
    });

    test('should maintain separate message state per conversation', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // Create first conversation with multiple exchanges
        await chatPage.sendMessage('hello');
        await chatPage.waitForAssistantResponse();
        await chatPage.sendMessage('how are you');
        await chatPage.waitForAssistantResponse();

        const firstConvId = await chatPage.getConversationId();
        const firstConvMessageCount = await chatPage.getMessageCount();

        expect(firstConvMessageCount.user).toBe(2);
        expect(firstConvMessageCount.assistant).toBe(2);

        // Start new conversation
        await page.goto('/');
        await chatPage.waitForConnection();
        await chatPage.sendMessage('new topic');
        await chatPage.waitForAssistantResponse();

        const newConvMessageCount = await chatPage.getMessageCount();
        expect(newConvMessageCount.user).toBe(1);

        // Navigate back to first conversation
        await page.goto(`/?conversationId=${firstConvId}`);
        await chatPage.waitForConnection();
        await page.waitForTimeout(500);

        // Should have original message count
        const restoredCount = await chatPage.getMessageCount();
        expect(restoredCount.user).toBe(firstConvMessageCount.user);
        expect(restoredCount.assistant).toBe(firstConvMessageCount.assistant);
    });

    test('should not receive messages from background tasks in foreground chat', async ({ page }) => {
        const homePage = new HomePage(page);
        await homePage.goto();

        // Start a slow background task
        await homePage.sendBackgroundMessage('analyze my codebase slowly');
        await homePage.waitForTaskCount(1);

        // Now start a foreground conversation
        await homePage.sendMessage('quick hello');

        // Switch to chat page
        const chatPage = new ChatPage(page);
        await chatPage.waitForAssistantResponse();

        const foregroundConvId = await chatPage.getConversationId();

        // Verify we're on the foreground conversation
        const messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(1);
        expect(messageCount.assistant).toBe(1);

        // Wait a bit for background task to potentially send messages
        await page.waitForTimeout(2000);

        // Message count should still be 1 (no messages from background)
        const messageCountAfter = await chatPage.getMessageCount();
        expect(messageCountAfter.user).toBe(1);
        expect(messageCountAfter.assistant).toBe(1);

        // We should still be on the same conversation
        const currentConvId = await chatPage.getConversationId();
        expect(currentConvId).toBe(foregroundConvId);
    });

    test('should preserve thoughts when switching conversations', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // Start a conversation that generates thoughts
        await chatPage.sendMessage('list all files');
        await chatPage.waitForAssistantResponse();

        const firstConvId = await chatPage.getConversationId();

        // Check if thoughts are present
        const hasThoughts = await chatPage.thoughtsSection.isVisible();

        // Start new conversation
        await page.goto('/');
        await chatPage.waitForConnection();
        await chatPage.sendMessage('quick question');
        await chatPage.waitForAssistantResponse();

        // Go back to first conversation
        await page.goto(`/?conversationId=${firstConvId}`);
        await chatPage.waitForConnection();
        await page.waitForTimeout(500);

        // Thoughts state should be preserved
        if (hasThoughts) {
            await expect(chatPage.thoughtsSection).toBeVisible();
        }
    });

    test('should show correct user messages per conversation', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // First conversation with specific message
        const firstMessage = 'unique message for conversation one';
        await chatPage.sendMessage(firstMessage);
        await chatPage.waitForAssistantResponse();
        const firstConvId = await chatPage.getConversationId();

        // Second conversation with different message
        await page.goto('/');
        await chatPage.waitForConnection();
        const secondMessage = 'different message for conversation two';
        await chatPage.sendMessage(secondMessage);
        await chatPage.waitForAssistantResponse();
        const secondConvId = await chatPage.getConversationId();

        // Go back to first conversation
        await page.goto(`/?conversationId=${firstConvId}`);
        await chatPage.waitForConnection();
        await page.waitForTimeout(500);

        // Verify first conversation shows correct user message
        const userMessages = await chatPage.getUserMessages();
        expect(userMessages).toContain(firstMessage);
        expect(userMessages).not.toContain(secondMessage);

        // Go to second conversation
        await page.goto(`/?conversationId=${secondConvId}`);
        await chatPage.waitForConnection();
        await page.waitForTimeout(500);

        // Verify second conversation shows correct user message
        const userMessages2 = await chatPage.getUserMessages();
        expect(userMessages2).toContain(secondMessage);
        expect(userMessages2).not.toContain(firstMessage);
    });

    test('should not render response from running task into new chat after clicking New Chat', async ({
        page,
    }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // Start a slow task (triggers slowPausableScenario with 10 iterations, 1s each)
        await chatPage.sendMessage('do a very slow analysis');

        // Wait for conversation ID to be set in URL (server created the conversation)
        const runningConvId = await chatPage.waitForConversationId();
        expect(runningConvId).toBeTruthy();

        // Wait for processing to start (ensures task is running)
        await chatPage.waitForProcessing();

        // Click "New Chat" while the slow task is still running
        await chatPage.startNewChat();

        // Wait for new chat page to be ready
        await chatPage.waitForConnection();

        // Verify we're on a fresh new chat (no conversation ID in URL yet)
        const newChatConvId = await chatPage.getConversationId();
        expect(newChatConvId).toBeNull();

        // The new chat should have no messages initially
        const initialMessageCount = await chatPage.getMessageCount();
        expect(initialMessageCount.user).toBe(0);
        expect(initialMessageCount.assistant).toBe(0);

        // Wait for the background task to potentially complete and try to render
        // This gives time for the bug to manifest if it exists
        await page.waitForTimeout(5000);

        // After waiting, the new chat should still have no messages
        // (the response from the old task should NOT appear here)
        const finalMessageCount = await chatPage.getMessageCount();
        expect(finalMessageCount.user).toBe(0);
        expect(finalMessageCount.assistant).toBe(0);

        // Verify no thoughts section appeared (from the old task)
        const thoughtsVisible = await chatPage.thoughtsSection.isVisible();
        expect(thoughtsVisible).toBe(false);

        // Now navigate back to the original conversation and verify it completed there
        await page.goto(`/?conversationId=${runningConvId}`);
        await chatPage.waitForConnection();
        await page.waitForTimeout(1000);

        // The original conversation should have the response
        const originalMessageCount = await chatPage.getMessageCount();
        expect(originalMessageCount.user).toBe(1);
        expect(originalMessageCount.assistant).toBe(1);
    });

    test('should not render response from running task into new chat after clicking logo', async ({
        page,
    }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // Start a slow task (triggers slowPausableScenario with 10 iterations, 1s each)
        await chatPage.sendMessage('do a very slow analysis');

        // Wait for conversation ID to be set in URL (server created the conversation)
        const runningConvId = await chatPage.waitForConversationId();

        // Wait for processing to start (ensures task is running)
        await chatPage.waitForProcessing();

        // Click logo while the slow task is still running
        await chatPage.goHome();
        await chatPage.waitForConnection();

        // Should be on home page with no active conversation
        const homeConvId = await chatPage.getConversationId();
        expect(homeConvId).toBeNull();

        // Wait for background task to potentially complete
        await page.waitForTimeout(5000);

        // Home page should remain clean (no messages from old task)
        const messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(0);
        expect(messageCount.assistant).toBe(0);

        // Navigate back to verify original conversation has the response
        await page.goto(`/?conversationId=${runningConvId}`);
        await chatPage.waitForConnection();
        await page.waitForTimeout(1000);

        const originalCount = await chatPage.getMessageCount();
        expect(originalCount.user).toBe(1);
        expect(originalCount.assistant).toBe(1);
    });
});
