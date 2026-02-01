/**
 * Home Page Object
 *
 * Extends AppPage with home page specific functionality.
 */

import type { Page, Locator } from '@playwright/test';
import { AppPage } from './app.page';
import { Selectors } from '../selectors';

export class HomePage extends AppPage {
    // Home page elements
    readonly emptyState: Locator;
    readonly taskGallery: Locator;
    readonly taskCount: Locator;
    readonly taskCards: Locator;

    constructor(page: Page) {
        super(page);

        this.emptyState = page.locator(Selectors.homeEmpty);
        this.taskGallery = page.locator(Selectors.taskGallery);
        this.taskCount = page.locator(Selectors.taskCount);
        this.taskCards = page.locator(Selectors.taskCard);
    }

    /**
     * Get the number of task cards currently displayed
     */
    async getTaskCardCount(): Promise<number> {
        return await this.taskCards.count();
    }

    /**
     * Get a task card by its index
     */
    getTaskCard(index: number): Locator {
        return this.taskCards.nth(index);
    }

    /**
     * Get a task card by title text
     */
    getTaskCardByTitle(title: string): Locator {
        return this.page.locator(Selectors.taskCard, { hasText: title });
    }

    /**
     * Click a task card by index
     */
    async clickTaskCard(index: number): Promise<void> {
        await this.getTaskCard(index).click();
    }

    /**
     * Get the status of a task card (running or stopped)
     */
    async getTaskStatus(index: number): Promise<'running' | 'stopped' | 'completed'> {
        const card = this.getTaskCard(index);
        if (await card.locator(Selectors.taskStatusIconCompleted).isVisible()) return 'completed';
        if (await card.locator(Selectors.taskStatusIconStopped).isVisible()) return 'stopped';
        return 'running';
    }

    /**
     * Get the step count from a task card
     */
    async getTaskStepCount(index: number): Promise<number> {
        const card = this.getTaskCard(index);
        const stepCountEl = card.locator(Selectors.taskStepCount);

        if (!(await stepCountEl.isVisible())) {
            return 0;
        }

        const text = await stepCountEl.textContent();
        if (!text) return 0;

        const match = text.match(/(\d+)/);
        return match && match[1] ? parseInt(match[1], 10) : 0;
    }

    /**
     * Get the title of a task card
     */
    async getTaskTitle(index: number): Promise<string> {
        const card = this.getTaskCard(index);
        return (await card.locator(Selectors.taskCardTitle).textContent()) || '';
    }

    /**
     * Wait for a specific number of task cards to appear
     */
    async waitForTaskCount(count: number): Promise<void> {
        await this.page.waitForFunction(
            ([selector, expectedCount]) => {
                const cards = document.querySelectorAll(selector as string);
                return cards.length >= (expectedCount as number);
            },
            [Selectors.taskCard, count] as const,
            { timeout: 15000 }
        );
    }

    /**
     * Wait for a task card with specific title to appear
     */
    async waitForTaskWithTitle(title: string): Promise<void> {
        await this.getTaskCardByTitle(title).waitFor({ state: 'visible', timeout: 15000 });
    }

    /**
     * Check if the empty state is displayed
     */
    async isEmptyStateVisible(): Promise<boolean> {
        return await this.emptyState.isVisible();
    }

    /**
     * Check if the task gallery is displayed
     */
    async isTaskGalleryVisible(): Promise<boolean> {
        return await this.taskGallery.isVisible();
    }

    /**
     * Get the task count text (e.g., "2 tasks running")
     */
    async getTaskCountText(): Promise<string> {
        return (await this.taskCount.textContent()) || '';
    }

    /**
     * Get the task subtitle (latest reasoning) from a task card
     */
    async getTaskSubtitle(index: number): Promise<string> {
        const card = this.getTaskCard(index);
        const reasoning = card.locator(Selectors.taskCardReasoning);
        if (!(await reasoning.isVisible())) {
            return '';
        }
        return (await reasoning.textContent()) || '';
    }

    /**
     * Wait for all tasks to complete (no task cards visible)
     */
    async waitForNoActiveTasks(): Promise<void> {
        await this.page.waitForFunction(
            (selector) => {
                const cards = document.querySelectorAll(selector);
                return cards.length === 0;
            },
            Selectors.taskCard,
            { timeout: 60000 }
        );
    }

    /**
     * Check if any task cards are visible
     */
    async hasActiveTasks(): Promise<boolean> {
        return (await this.getTaskCardCount()) > 0;
    }

    /**
     * Wait for a task to have a specific status
     */
    async waitForTaskStatus(
        index: number,
        status: 'running' | 'stopped'
    ): Promise<void> {
        const expectedSelector =
            status === 'stopped'
                ? Selectors.taskStatusIconStopped
                : Selectors.taskStatusIconSpinning;

        await this.page.waitForFunction(
            ([cardSelector, statusSelector, idx]) => {
                const cards = document.querySelectorAll(cardSelector as string);
                const card = cards[idx as number];
                if (!card) return false;
                return card.querySelector(statusSelector as string) !== null;
            },
            [Selectors.taskCard, expectedSelector, index] as const,
            { timeout: 10000 }
        );
    }
}
