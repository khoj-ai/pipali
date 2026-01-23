/**
 * Base App Page Object
 *
 * Common functionality for all page interactions.
 */

import type { Page, Locator } from '@playwright/test';
import { Selectors } from '../selectors';

export class AppPage {
    readonly page: Page;
    private readonly consoleBuffer: string[] = [];
    private readonly pageErrorBuffer: string[] = [];

    // Main layout
    readonly mainContent: Locator;
    readonly sidebar: Locator;

    // Input controls
    readonly inputTextarea: Locator;
    readonly sendButton: Locator;
    readonly stopButton: Locator;
    readonly inputHint: Locator;

    constructor(page: Page) {
        this.page = page;

        this.page.on('console', (msg) => {
            const entry = `[console.${msg.type()}] ${msg.text()}`;
            this.consoleBuffer.push(entry);
            if (this.consoleBuffer.length > 50) this.consoleBuffer.shift();
        });

        this.page.on('pageerror', (err) => {
            const entry = `[pageerror] ${err.message}`;
            this.pageErrorBuffer.push(entry);
            if (this.pageErrorBuffer.length > 20) this.pageErrorBuffer.shift();
        });

        // Layout
        this.mainContent = page.locator(Selectors.mainContent);
        this.sidebar = page.locator(Selectors.sidebar);

        // Input controls
        this.inputTextarea = page.locator(Selectors.inputTextarea);
        this.sendButton = page.locator(Selectors.sendButton);
        this.stopButton = page.locator(Selectors.stopButton);
        this.inputHint = page.locator(Selectors.inputHint);
    }

    /**
     * Navigate to the home page
     */
    async goto(): Promise<void> {
        await this.page.goto('/', { waitUntil: 'domcontentloaded' });
        await this.waitForConnection();
    }

    /**
     * Navigate to a specific conversation
     */
    async gotoConversation(conversationId: string): Promise<void> {
        await this.page.goto(`/?conversationId=${conversationId}`, { waitUntil: 'domcontentloaded' });
        await this.waitForConnection();
    }

    /**
     * Wait for WebSocket connection to be established
     */
    async waitForConnection(): Promise<void> {
        const timeoutMs = 30000;
        const loginPage = this.page.locator('.login-page');

        // Ensure the HTML document is there before we wait for app DOM.
        await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });

        await this.page.waitForSelector('.app-wrapper, .login-page', { timeout: timeoutMs });

        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (await loginPage.isVisible()) {
                throw new Error('App showed login page (expected anonymous mode for E2E tests).');
            }

            if (await this.inputTextarea.isVisible()) {
                const enabled = await this.page.evaluate((selector) => {
                    const textarea = document.querySelector(selector);
                    return textarea instanceof HTMLTextAreaElement && !textarea.disabled;
                }, Selectors.inputTextarea);
                if (enabled) return;
            }

            await this.page.waitForTimeout(100);
        }

        const debug = [
            `url=${this.page.url()}`,
            ...this.pageErrorBuffer.slice(-5),
            ...this.consoleBuffer.slice(-10),
        ].join('\n');

        throw new Error(`Timed out waiting for WebSocket connection after ${timeoutMs}ms\n${debug}`);
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
     * Stop the current task
     * Waits for UI to stabilize before clicking to ensure React event handlers are attached
     */
    async stopTask(): Promise<void> {
        // Wait for at least one tool call to appear (UI stabilization)
        try {
            await this.page.waitForSelector('.thought-item', { timeout: 5000 });
        } catch {
            // Might already have tool calls, continue
        }
        await this.page.waitForTimeout(300); // Extra stabilization

        // Wait for button and click
        await this.stopButton.waitFor({ state: 'visible' });
        await this.stopButton.click();
    }

    /**
     * Press Escape to stop
     */
    async pressEscape(): Promise<void> {
        await this.page.keyboard.press('Escape');
    }

    /**
     * Check if currently processing (stop button visible)
     */
    async isProcessing(): Promise<boolean> {
        return await this.stopButton.isVisible();
    }

    /**
     * Check if currently stopped (input hint)
     */
    async isStopped(): Promise<boolean> {
        const hint = (await this.inputHint.textContent()) || '';
        return hint.toLowerCase().includes('stopped');
    }

    /**
     * Wait for processing to start
     */
    async waitForProcessing(): Promise<void> {
        await this.stopButton.waitFor({ state: 'visible', timeout: 10000 });
    }

    /**
     * Wait for processing to complete (no stop button)
     */
    async waitForIdle(): Promise<void> {
        await this.page.waitForFunction(
            (stopSel: string) => {
                return !document.querySelector(stopSel);
            },
            Selectors.stopButton,
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

    /**
     * Wait for conversation ID to appear in URL
     * This happens when the server creates a new conversation and sends conversation_created
     */
    async waitForConversationId(timeout: number = 10000): Promise<string> {
        await this.page.waitForFunction(
            () => {
                const params = new URLSearchParams(window.location.search);
                return params.get('conversationId') !== null;
            },
            {},
            { timeout }
        );
        const params = await this.getUrlParams();
        return params.get('conversationId')!;
    }
}
