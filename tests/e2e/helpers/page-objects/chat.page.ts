/**
 * Chat Page Object
 *
 * Extends AppPage with chat/conversation specific functionality.
 */

import type { Page, Locator } from '@playwright/test';
import { AppPage } from './app.page';
import { Selectors } from '../selectors';

export class ChatPage extends AppPage {
    // Message elements
    readonly messages: Locator;
    readonly userMessages: Locator;
    readonly assistantMessages: Locator;

    // Thoughts elements
    readonly thoughtsSection: Locator;
    readonly thoughtsToggle: Locator;
    readonly thoughtsSummary: Locator;
    readonly thoughtsList: Locator;
    readonly thoughtItems: Locator;

    // Confirmation elements
    readonly confirmationDialog: Locator;
    readonly confirmationTitle: Locator;
    readonly confirmationBtnPrimary: Locator;
    readonly confirmationBtnSecondary: Locator;
    readonly confirmationBtnDanger: Locator;

    // Sidebar elements
    readonly conversationItems: Locator;
    readonly conversationItemActive: Locator;
    readonly conversationItemWithActiveTask: Locator;

    constructor(page: Page) {
        super(page);

        // Messages
        this.messages = page.locator(Selectors.messages);
        this.userMessages = page.locator(Selectors.userMessage);
        this.assistantMessages = page.locator(Selectors.assistantMessage);

        // Thoughts
        this.thoughtsSection = page.locator(Selectors.thoughtsSection);
        this.thoughtsToggle = page.locator(Selectors.thoughtsToggle);
        this.thoughtsSummary = page.locator(Selectors.thoughtsSummary);
        this.thoughtsList = page.locator(Selectors.thoughtsList);
        this.thoughtItems = page.locator(Selectors.thoughtItem);

        // Confirmation
        this.confirmationDialog = page.locator(Selectors.confirmationDialog);
        this.confirmationTitle = page.locator(Selectors.confirmationTitle);
        this.confirmationBtnPrimary = page.locator(Selectors.confirmationBtnPrimary);
        this.confirmationBtnSecondary = page.locator(Selectors.confirmationBtnSecondary);
        this.confirmationBtnDanger = page.locator(Selectors.confirmationBtnDanger);

        // Sidebar
        this.conversationItems = page.locator(Selectors.conversationItem);
        this.conversationItemActive = page.locator(Selectors.conversationItemActive);
        this.conversationItemWithActiveTask = page.locator(Selectors.conversationItemWithActiveTask);
    }

    /**
     * Get count of user and assistant messages
     */
    async getMessageCount(): Promise<{ user: number; assistant: number }> {
        return {
            user: await this.userMessages.count(),
            assistant: await this.assistantMessages.count(),
        };
    }

    /**
     * Get the last assistant message content
     */
    async getLastAssistantMessage(): Promise<string> {
        const count = await this.assistantMessages.count();
        if (count === 0) return '';

        const lastMessage = this.assistantMessages.nth(count - 1);
        const content = lastMessage.locator(Selectors.messageContent);

        if (await content.isVisible()) {
            return (await content.textContent()) || '';
        }
        return '';
    }

    /**
     * Wait for an assistant response to complete
     */
    async waitForAssistantResponse(): Promise<void> {
        // Wait for at least one assistant message with content
        await this.page.waitForFunction(
            (selectors: { assistant: string; content: string }) => {
                const messages = document.querySelectorAll(selectors.assistant);
                if (messages.length === 0) return false;

                const lastMessage = messages[messages.length - 1];
                if (!lastMessage) return false;
                const content = lastMessage.querySelector(selectors.content);
                return content && content.textContent && content.textContent.trim().length > 0;
            },
            {
                assistant: Selectors.assistantMessage,
                content: Selectors.messageContent,
            },
            { timeout: 60000 }
        );
    }

    /**
     * Wait for conversation history to load (at least one user message)
     */
    async waitForConversationHistory(): Promise<void> {
        await this.page.waitForFunction(
            (selector: string) => {
                const messages = document.querySelectorAll(selector);
                return messages.length > 0;
            },
            Selectors.userMessage,
            { timeout: 15000 }
        );
    }

    /**
     * Check if thoughts section is expanded
     */
    async isThoughtsExpanded(): Promise<boolean> {
        return await this.thoughtsList.isVisible();
    }

    /**
     * Expand the thoughts section
     */
    async expandThoughts(): Promise<void> {
        if (!(await this.isThoughtsExpanded())) {
            await this.thoughtsToggle.click();
            await this.thoughtsList.waitFor({ state: 'visible', timeout: 5000 });
        }
    }

    /**
     * Collapse the thoughts section
     */
    async collapseThoughts(): Promise<void> {
        if (await this.isThoughtsExpanded()) {
            await this.thoughtsToggle.click();
            await this.thoughtsList.waitFor({ state: 'hidden', timeout: 5000 });
        }
    }

    /**
     * Get the count of thought items
     */
    async getThoughtCount(): Promise<number> {
        // Expand if not expanded to count all thoughts
        const wasExpanded = await this.isThoughtsExpanded();
        if (!wasExpanded) {
            await this.expandThoughts();
        }

        const count = await this.thoughtItems.count();

        // Restore original state
        if (!wasExpanded) {
            await this.collapseThoughts();
        }

        return count;
    }

    /**
     * Get the thoughts summary text (e.g., "3 steps taken")
     */
    async getThoughtsSummary(): Promise<string> {
        if (!(await this.thoughtsToggle.isVisible())) {
            return '';
        }
        return (await this.thoughtsSummary.textContent()) || '';
    }

    /**
     * Wait for thoughts section to be visible
     */
    async waitForThoughts(): Promise<void> {
        await this.thoughtsSection.waitFor({ state: 'visible', timeout: 15000 });
    }

    /**
     * Wait for a specific number of thoughts
     */
    async waitForThoughtCount(count: number): Promise<void> {
        await this.expandThoughts();
        await this.page.waitForFunction(
            ([selector, expected]) => {
                const items = document.querySelectorAll(selector as string);
                return items.length >= (expected as number);
            },
            [Selectors.thoughtItem, count] as const,
            { timeout: 30000 }
        );
    }

    /**
     * Check if a message with specific content exists
     */
    async hasMessageWithContent(content: string): Promise<boolean> {
        const messageContents = this.page.locator(Selectors.messageContent);
        const count = await messageContents.count();

        for (let i = 0; i < count; i++) {
            const text = await messageContents.nth(i).textContent();
            if (text?.includes(content)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Get all user message contents
     */
    async getUserMessages(): Promise<string[]> {
        const messages: string[] = [];
        const count = await this.userMessages.count();

        for (let i = 0; i < count; i++) {
            const content = this.userMessages.nth(i).locator(Selectors.messageContent);
            const text = await content.textContent();
            if (text) messages.push(text);
        }

        return messages;
    }

    /**
     * Check if input is empty
     */
    async isInputEmpty(): Promise<boolean> {
        const value = await this.inputTextarea.inputValue();
        return value.trim() === '';
    }

    /**
     * Check if input is focused
     */
    async isInputFocused(): Promise<boolean> {
        return await this.inputTextarea.evaluate((el) => document.activeElement === el);
    }

    /**
     * Wait for confirmation dialog to appear
     */
    async waitForConfirmationDialog(): Promise<void> {
        await this.confirmationDialog.waitFor({ state: 'visible', timeout: 15000 });
    }

    /**
     * Get confirmation dialog title
     */
    async getConfirmationDialogTitle(): Promise<string> {
        await this.waitForConfirmationDialog();
        return (await this.confirmationTitle.textContent()) || '';
    }

    /**
     * Click a confirmation button by option
     */
    async clickConfirmationButton(
        option: 'yes' | 'yes_dont_ask' | 'no'
    ): Promise<void> {
        await this.waitForConfirmationDialog();

        switch (option) {
            case 'yes':
                await this.confirmationBtnPrimary.click();
                break;
            case 'yes_dont_ask':
                await this.confirmationBtnSecondary.click();
                break;
            case 'no':
                await this.confirmationBtnDanger.click();
                break;
        }
    }

    /**
     * Check if there is an active task marker in sidebar
     */
    async hasActiveTaskInSidebar(): Promise<boolean> {
        return await this.conversationItemWithActiveTask.isVisible();
    }

    /**
     * Get conversation subtitle from sidebar (latest reasoning)
     */
    async getConversationSubtitleFromSidebar(): Promise<string> {
        const subtitle = this.page.locator(Selectors.conversationSubtitle).first();
        if (!(await subtitle.isVisible())) {
            return '';
        }
        return (await subtitle.textContent()) || '';
    }

    /**
     * Wait for active task marker to appear in sidebar
     */
    async waitForActiveTaskInSidebar(): Promise<void> {
        await this.conversationItemWithActiveTask.waitFor({
            state: 'visible',
            timeout: 10000,
        });
    }

    /**
     * Wait for active task marker to disappear from sidebar (task complete)
     */
    async waitForNoActiveTaskInSidebar(): Promise<void> {
        await this.conversationItemWithActiveTask.waitFor({
            state: 'hidden',
            timeout: 60000,
        });
    }

    /**
     * Get the count of thoughts sections (for multi-turn conversations)
     */
    async getThoughtsSectionCount(): Promise<number> {
        return await this.thoughtsSection.count();
    }
}
