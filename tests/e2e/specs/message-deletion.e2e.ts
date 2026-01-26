/**
 * Message Deletion E2E Test
 *
 * Tests the behavior of deleting messages in a conversation:
 * - Deleting a user message also removes the following assistant message
 * - Deleting an assistant message only removes that message
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';

test.describe('Message Deletion', () => {
    test('deleting user message removes it and following assistant message', async ({ page, context }) => {
        const chatPage = new ChatPage(page);

        // Clear any persisted state
        await context.clearCookies();

        // Navigate to new chat
        await page.goto('/');
        await chatPage.waitForConnection();

        // Send three messages with responses
        await chatPage.sendMessage('first question');
        await chatPage.waitForAssistantResponse();

        await chatPage.sendMessage('second question');
        await chatPage.waitForAssistantResponse();

        await chatPage.sendMessage('third question');
        await chatPage.waitForAssistantResponse();

        // Verify we have 3 user messages and 3 assistant messages
        let messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(3);
        expect(messageCount.assistant).toBe(3);

        // Delete the second user message (middle one)
        await chatPage.deleteUserMessage(1);

        // Wait for UI to update - wait until user message count changes to 2
        await page.waitForFunction(
            (selector: string) => {
                const messages = document.querySelectorAll(selector);
                return messages.length === 2;
            },
            Selectors.userMessage,
            { timeout: 5000 }
        );

        // Verify the second user+assistant pair was removed
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(2);
        expect(messageCount.assistant).toBe(2);

        // Verify the remaining messages are the first and third exchanges
        const userMessages = await chatPage.getUserMessages();
        expect(userMessages).toHaveLength(2);
        expect(userMessages[0]).toBe('first question');
        expect(userMessages[1]).toBe('third question');
    });

    test('deleting assistant or decoupled user message only removes that message', async ({ page, context }) => {
        const chatPage = new ChatPage(page);

        // Clear any persisted state
        await context.clearCookies();

        // Navigate to new chat
        await page.goto('/');
        await chatPage.waitForConnection();

        // Send two messages with responses
        await chatPage.sendMessage('first question');
        await chatPage.waitForAssistantResponse();

        await chatPage.sendMessage('second question');
        await chatPage.waitForAssistantResponse();

        // Verify we have 2 user messages and 2 assistant messages
        let messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(2);
        expect(messageCount.assistant).toBe(2);

        // Delete the first assistant message
        await chatPage.deleteAssistantMessage(0);

        // Wait for UI to update - wait until assistant message count changes to 1
        await page.waitForFunction(
            (selector: string) => {
                const messages = document.querySelectorAll(selector);
                return messages.length === 1;
            },
            Selectors.assistantMessage,
            { timeout: 5000 }
        );

        // Verify only the first assistant message was removed (user messages unchanged)
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(2);
        expect(messageCount.assistant).toBe(1);

        // Verify both user messages are still there
        const userMessages = await chatPage.getUserMessages();
        expect(userMessages).toHaveLength(2);
        expect(userMessages[0]).toBe('first question');
        expect(userMessages[1]).toBe('second question');

        // Now delete the second user message (with no assistant message following it)
        await chatPage.deleteUserMessage(1);

        // Wait for UI to update - wait until user message count changes to 1
        await page.waitForFunction(
            (selector: string) => {
                const messages = document.querySelectorAll(selector);
                return messages.length === 1;
            },
            Selectors.userMessage,
            { timeout: 5000 }
        );

        // Verify the second user message and its (already deleted) assistant message are gone
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(1);
        expect(messageCount.assistant).toBe(0);
        
        const remainingUserMessages = await chatPage.getUserMessages();
        expect(remainingUserMessages).toHaveLength(1);
        expect(remainingUserMessages[0]).toBe('first question');
    });
});
