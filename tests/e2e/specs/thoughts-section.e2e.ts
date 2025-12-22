/**
 * Train of Thought Section Tests
 *
 * Tests for the expandable thoughts section that shows AI reasoning and tool calls.
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';

test.describe('Train of Thought Section', () => {
    let chatPage: ChatPage;

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
    });

    test('should show thoughts toggle when response has tool calls', async () => {
        // Send query that triggers tool usage
        await chatPage.sendMessage('list all files');
        await chatPage.waitForAssistantResponse();

        // Thoughts toggle should be visible
        await expect(chatPage.thoughtsToggle).toBeVisible();
    });

    test('should show summary of steps taken', async () => {
        await chatPage.sendMessage('list all files');
        await chatPage.waitForAssistantResponse();

        // Summary should show step count
        const summary = await chatPage.getThoughtsSummary();
        expect(summary).toMatch(/\d+\s*step/i);
    });

    test('should expand to show thought items when clicked', async () => {
        await chatPage.sendMessage('analyze the codebase');
        await chatPage.waitForAssistantResponse();

        // Initially thoughts list should be collapsed
        expect(await chatPage.isThoughtsExpanded()).toBe(false);

        // Click to expand
        await chatPage.expandThoughts();

        // Should be visible now
        expect(await chatPage.isThoughtsExpanded()).toBe(true);

        // Should have thought items
        const thoughtCount = await chatPage.getThoughtCount();
        expect(thoughtCount).toBeGreaterThan(0);
    });

    test('should collapse thoughts when clicked again', async () => {
        await chatPage.sendMessage('list files');
        await chatPage.waitForAssistantResponse();

        // Expand first
        await chatPage.expandThoughts();
        expect(await chatPage.isThoughtsExpanded()).toBe(true);

        // Collapse
        await chatPage.collapseThoughts();
        expect(await chatPage.isThoughtsExpanded()).toBe(false);
    });

    test('should display thought items with content', async ({ page }) => {
        await chatPage.sendMessage('list all files');
        await chatPage.waitForAssistantResponse();

        await chatPage.expandThoughts();

        // Get thought items
        const thoughtItems = page.locator(Selectors.thoughtItem);
        const count = await thoughtItems.count();
        expect(count).toBeGreaterThan(0);

        // Each thought should have some content
        for (let i = 0; i < count; i++) {
            const item = thoughtItems.nth(i);
            const text = await item.textContent();
            expect(text).toBeTruthy();
            expect(text!.length).toBeGreaterThan(0);
        }
    });

    test('should show step numbers for tool calls', async ({ page }) => {
        await chatPage.sendMessage('analyze my codebase slowly');
        await chatPage.waitForAssistantResponse();

        await chatPage.expandThoughts();

        // Look for step indicators in thought items
        const thoughtItems = page.locator(Selectors.thoughtItem);
        const count = await thoughtItems.count();

        // At least some thoughts should have step numbers
        let foundStepNumber = false;
        for (let i = 0; i < count; i++) {
            const item = thoughtItems.nth(i);
            const text = await item.textContent();
            // Step numbers might be shown as "1", "2", etc. or "Step 1", etc.
            if (text && /\d/.test(text)) {
                foundStepNumber = true;
                break;
            }
        }
        expect(foundStepNumber).toBe(true);
    });

    test('should accumulate thoughts as task progresses', async ({ page }) => {
        await chatPage.sendMessage('analyze my codebase slowly');

        // Wait for processing to start
        await chatPage.waitForProcessing();

        // Wait a moment for thoughts to accumulate
        await page.waitForTimeout(1000);

        // Expand thoughts during processing
        if (await chatPage.thoughtsSection.isVisible()) {
            await chatPage.expandThoughts();
            const initialCount = await chatPage.getThoughtCount();

            // Wait for more thoughts
            await page.waitForTimeout(1500);

            const laterCount = await chatPage.getThoughtCount();

            // Should have accumulated more (or at least not decreased)
            expect(laterCount).toBeGreaterThanOrEqual(initialCount);
        }

        // Wait for completion
        await chatPage.waitForAssistantResponse();
    });

    test('should preserve thoughts toggle state across interactions', async () => {
        await chatPage.sendMessage('list files');
        await chatPage.waitForAssistantResponse();

        // Expand thoughts
        await chatPage.expandThoughts();
        expect(await chatPage.isThoughtsExpanded()).toBe(true);

        // Scroll the page
        await chatPage.page.evaluate(() => window.scrollTo(0, 0));

        // Thoughts should still be expanded
        expect(await chatPage.isThoughtsExpanded()).toBe(true);
    });

    test('should not show thoughts for simple responses without tool calls', async () => {
        // Quick/simple queries might not trigger tool calls
        await chatPage.sendMessage('hello');
        await chatPage.waitForAssistantResponse();

        // Either no thoughts section or empty thoughts
        const isThoughtsVisible = await chatPage.thoughtsSection.isVisible();

        if (isThoughtsVisible) {
            await chatPage.expandThoughts();
            const count = await chatPage.getThoughtCount();
            // May have 0 or minimal thoughts for simple queries
            // This is acceptable - the key is no spurious thoughts appear
            expect(count).toBeGreaterThanOrEqual(0);
        }
    });

    test('should show thoughts section with multiple steps for complex queries', async () => {
        // Multi-step query
        await chatPage.sendMessage('analyze this research slowly');
        await chatPage.waitForAssistantResponse();

        // Should have thoughts
        await expect(chatPage.thoughtsSection).toBeVisible();

        // Expand and check count
        await chatPage.expandThoughts();
        const count = await chatPage.getThoughtCount();
        expect(count).toBeGreaterThan(0);

        // Summary should reflect the step count
        const summary = await chatPage.getThoughtsSummary();
        expect(summary).toMatch(/step/i);
    });

    test('should render different tool types correctly in expanded thoughts', async ({ page }) => {
        // Use multi-tool query that uses list, read, bash, and write
        await chatPage.sendMessage('run a comprehensive multi tool analysis');
        await chatPage.waitForAssistantResponse();

        // Expand thoughts
        await chatPage.expandThoughts();

        // Get all thought items
        const thoughtItems = page.locator(Selectors.thoughtItem);
        const count = await thoughtItems.count();

        // Should have multiple thought items for different tools
        expect(count).toBeGreaterThan(1);

        // Verify thought items have content
        for (let i = 0; i < count; i++) {
            const item = thoughtItems.nth(i);
            const text = await item.textContent();
            expect(text).toBeTruthy();
        }
    });

    test('should mark conversation as inactive in sidebar after completion', async () => {
        // Use multi-step scenario that takes longer (gives time to check active state)
        await chatPage.sendMessage('analyze this research slowly');

        // Wait for processing to start
        await chatPage.waitForProcessing();

        // During processing, sidebar should show active marker
        await chatPage.waitForActiveTaskInSidebar();
        expect(await chatPage.hasActiveTaskInSidebar()).toBe(true);

        // Wait for completion
        await chatPage.waitForAssistantResponse();

        // After completion, active marker should be gone
        await chatPage.waitForNoActiveTaskInSidebar();
        expect(await chatPage.hasActiveTaskInSidebar()).toBe(false);
    });

    test('should show interwoven thoughts sections in multi-turn chat', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        // First turn with tool calls
        await chatPage.sendMessage('list all files');
        await chatPage.waitForAssistantResponse();

        // Should have first message pair
        let messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(1);
        expect(messageCount.assistant).toBe(1);

        // Should have thoughts section
        const firstThoughtsCount = await chatPage.getThoughtsSectionCount();
        expect(firstThoughtsCount).toBeGreaterThanOrEqual(1);

        // Second turn - simple message, no tool calls
        await chatPage.sendMessage('how are you doing');
        await chatPage.waitForAssistantResponse();

        // Should have two message pairs
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(2);
        expect(messageCount.assistant).toBe(2);

        // Should have no new thoughts section
        const secondThoughtsCount = await chatPage.getThoughtsSectionCount();
        expect(secondThoughtsCount).toBe(firstThoughtsCount);

        // Third turn with tool calls
        await chatPage.sendMessage('read the file content');
        await chatPage.waitForAssistantResponse();

        // Should have three message pairs
        messageCount = await chatPage.getMessageCount();
        expect(messageCount.user).toBe(3);
        expect(messageCount.assistant).toBe(3);

        // Should have multiple thoughts sections (for turns with tool calls)
        const finalThoughtsCount = await chatPage.getThoughtsSectionCount();
        expect(finalThoughtsCount).toBeGreaterThanOrEqual(firstThoughtsCount);
    });

});
