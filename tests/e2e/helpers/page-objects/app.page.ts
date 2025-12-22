/**
 * Base App Page Object
 *
 * Common functionality for all page interactions.
 */

import type { Page, Locator } from '@playwright/test';
import { Selectors } from '../selectors';

export class AppPage {
    readonly page: Page;

    // Main layout
    readonly mainContent: Locator;
    readonly sidebar: Locator;

    // Input controls
    readonly inputTextarea: Locator;
    readonly sendButton: Locator;
    readonly pauseButton: Locator;
    readonly playButton: Locator;
    readonly inputHint: Locator;

    constructor(page: Page) {
        this.page = page;

        // Layout
        this.mainContent = page.locator(Selectors.mainContent);
        this.sidebar = page.locator(Selectors.sidebar);

        // Input controls
        this.inputTextarea = page.locator(Selectors.inputTextarea);
        this.sendButton = page.locator(Selectors.sendButton);
        this.pauseButton = page.locator(Selectors.pauseButton);
        this.playButton = page.locator(Selectors.playButton);
        this.inputHint = page.locator(Selectors.inputHint);
    }

    /**
     * Navigate to the home page
     */
    async goto(): Promise<void> {
        await this.page.goto('/');
        await this.waitForConnection();
    }

    /**
     * Navigate to a specific conversation
     */
    async gotoConversation(conversationId: string): Promise<void> {
        await this.page.goto(`/?conversationId=${conversationId}`);
        await this.waitForConnection();
    }

    /**
     * Wait for WebSocket connection to be established
     */
    async waitForConnection(): Promise<void> {
        // Wait for textarea to be enabled (indicates WebSocket connected)
        await this.inputTextarea.waitFor({ state: 'visible', timeout: 10000 });
        await this.page.waitForFunction(
            (selector) => {
                const textarea = document.querySelector(selector) as HTMLTextAreaElement;
                return textarea && !textarea.disabled;
            },
            Selectors.inputTextarea,
            { timeout: 10000 }
        );
    }

    /**
     * Send a message (foreground task)
     */
    async sendMessage(text: string): Promise<void> {
        await this.inputTextarea.fill(text);
        await this.sendButton.click();
    }

    /**
     * Send a message as a background task (Cmd+Enter)
     */
    async sendBackgroundMessage(text: string): Promise<void> {
        await this.inputTextarea.fill(text);
        // Use Meta+Enter for Mac, Control+Enter for other platforms
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await this.page.keyboard.press(`${modifier}+Enter`);
    }

    /**
     * Pause the current task
     * Waits for UI to stabilize before clicking to ensure React event handlers are attached
     */
    async pauseTask(): Promise<void> {
        // Wait for at least one tool call to appear (UI stabilization)
        try {
            await this.page.waitForSelector('.thought-item', { timeout: 5000 });
        } catch {
            // Might already have tool calls, continue
        }
        await this.page.waitForTimeout(300); // Extra stabilization

        // Wait for button and click
        await this.pauseButton.waitFor({ state: 'visible' });
        await this.pauseButton.click();
    }

    /**
     * Resume the current task
     */
    async resumeTask(): Promise<void> {
        await this.playButton.click();
    }

    /**
     * Press Escape to pause
     */
    async pressEscape(): Promise<void> {
        await this.page.keyboard.press('Escape');
    }

    /**
     * Check if currently processing (pause button visible)
     */
    async isProcessing(): Promise<boolean> {
        return await this.pauseButton.isVisible();
    }

    /**
     * Check if currently paused (play button visible)
     */
    async isPaused(): Promise<boolean> {
        return await this.playButton.isVisible();
    }

    /**
     * Wait for processing to start
     */
    async waitForProcessing(): Promise<void> {
        await this.pauseButton.waitFor({ state: 'visible', timeout: 10000 });
    }

    /**
     * Wait for processing to complete (no pause or play button)
     */
    async waitForIdle(): Promise<void> {
        await this.page.waitForFunction(
            ([pauseSel, playSel]: [string, string]) => {
                return (
                    !document.querySelector(pauseSel) && !document.querySelector(playSel)
                );
            },
            [Selectors.pauseButton, Selectors.playButton] as [string, string],
            { timeout: 60000 }
        );
    }

    /**
     * Start a new chat
     */
    async startNewChat(): Promise<void> {
        await this.page.locator(Selectors.newChatButton).click();
    }

    /**
     * Navigate to home page by clicking the logo (preserves React state)
     */
    async goHome(): Promise<void> {
        await this.page.locator(Selectors.logo).click();
    }

    /**
     * Get current URL parameters
     */
    async getUrlParams(): Promise<URLSearchParams> {
        const url = new URL(this.page.url());
        return url.searchParams;
    }

    /**
     * Get current conversation ID from URL
     */
    async getConversationId(): Promise<string | null> {
        const params = await this.getUrlParams();
        return params.get('conversationId');
    }
}
