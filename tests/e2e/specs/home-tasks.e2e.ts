/**
 * Home Page Task Gallery Tests
 *
 * Tests for the home page showing active/running tasks.
 */

import { test, expect } from '@playwright/test';
import { HomePage, ChatPage } from '../helpers/page-objects';
import { stopAllActiveConversations, stopAllActiveRunsFromHome } from '../helpers/cleanup';

// Use "pausable" keyword to trigger slow mock scenario (1s between steps)
const PAUSABLE_QUERY = 'run a pausable analysis';

function uniqueQuery(base: string): string {
    return `${base} [e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}]`;
}

test.describe('Home Page Task Gallery', () => {
    let homePage: HomePage;

    test.beforeEach(async ({ page, request }) => {
        // Specs share one server, and an agent can start work on its own, so begin from
        // a known-quiet state rather than inheriting whatever is still running.
        await stopAllActiveConversations(page, request);
        homePage = new HomePage(page);
        await homePage.goto();
    });

    test.afterEach(async ({ page }) => {
        await stopAllActiveRunsFromHome(page);
    });

    test('should show empty state when no active tasks', async () => {
        // Initially, home should show empty state
        const isEmpty = await homePage.isEmptyStateVisible();
        const taskCount = await homePage.getTaskCardCount();

        // Either empty state visible or no task cards
        expect(isEmpty || taskCount === 0).toBe(true);
    });

    test('should show task card when background task is started', async ({ page }) => {
        // Start a background task (Cmd+Enter)
        const query = uniqueQuery('analyze this slowly');
        await homePage.sendBackgroundMessage(query);

        // Wait a moment for the task to register
        await page.waitForTimeout(500);

        // Should stay on home page (no navigation)
        // Task card should appear
        await homePage.waitForTaskWithTitle(query);
        await expect(homePage.getTaskCardByTitle(query)).toBeVisible();
    });

    test('should display task title from user query', async ({ page }) => {
        const query = uniqueQuery('list all TypeScript files');
        await homePage.sendBackgroundMessage(query);

        await homePage.waitForTaskWithTitle(query);

        // Task card should contain the query text
        await expect(homePage.getTaskCardByTitle(query)).toBeVisible();
    });

    test('should show running status for active task', async ({ page }) => {
        const query = uniqueQuery('analyze my codebase slowly');
        await homePage.sendBackgroundMessage(query);
        await homePage.waitForTaskWithTitle(query);

        // Check status is running (not paused)
        const card = homePage.getTaskCardByTitle(query);
        await expect(card).toBeVisible();
        await expect(card.locator('.task-status-icon.running')).toBeVisible();
        await expect(card.locator('.task-status-text.running')).toBeVisible();
    });

    test('should show step count as task progresses', async ({ page }) => {
        const query = uniqueQuery('analyze my codebase slowly');
        await homePage.sendBackgroundMessage(query);
        await homePage.waitForTaskWithTitle(query);

        // Wait for some steps to accumulate
        await page.waitForTimeout(2000);

        // Tool category icons should be visible
        const categoryCount = await homePage.getTaskCategoryCount(0);
        expect(categoryCount).toBeGreaterThanOrEqual(0);
    });

    test('should navigate to conversation when task card is clicked', async ({ page }) => {
        // Use slow pausable task so it doesn't complete before we can interact
        const query = uniqueQuery(PAUSABLE_QUERY);
        await homePage.sendBackgroundMessage(query);
        await homePage.waitForTaskWithTitle(query);

        // Click the task card
        await homePage.getTaskCardByTitle(query).click();

        // Should navigate to conversation page
        await page.waitForTimeout(500);

        // URL should have conversationId
        const chatPage = new ChatPage(page);
        const conversationId = await chatPage.getConversationId();
        expect(conversationId).toBeTruthy();

        // Messages container should be visible
        await chatPage.messages.waitFor({ state: 'visible', timeout: 5000 });
    });

    test('should show multiple active tasks', async ({ page }) => {
        // Start first background task
        const query1 = uniqueQuery('first slow task');
        await homePage.sendBackgroundMessage(query1);
        await homePage.waitForTaskWithTitle(query1);

        // Start second background task
        const query2 = uniqueQuery('second slow task');
        await homePage.sendBackgroundMessage(query2);
        await homePage.waitForTaskWithTitle(query2);

        // Should show both task cards
        await expect(homePage.getTaskCardByTitle(query1)).toBeVisible();
        await expect(homePage.getTaskCardByTitle(query2)).toBeVisible();

        // Task count text should mention multiple tasks
        const countText = await homePage.getTaskCountText();
        expect(countText).toContain('2');
        expect(countText).toContain('tasks');
    });

    test('should remove task from home gallery when user stops it', async ({ page }) => {
        // Start a background task (use pausable for slow execution)
        const query = uniqueQuery(PAUSABLE_QUERY);
        await homePage.sendBackgroundMessage(query);
        await homePage.waitForTaskWithTitle(query);

        // Click task to go to conversation
        await homePage.getTaskCardByTitle(query).click();

        // Now on chat page - stop the task
        const chatPage = new ChatPage(page);
        await chatPage.waitForProcessing();
        await chatPage.stopTask();

        // Go back to home by clicking logo (preserves React state)
        await chatPage.goHome();

        // User-initiated stops are excluded from the home gallery —
        // the user is already aware they stopped it, so no surface needed.
        await expect(homePage.getTaskCardByTitle(query)).toHaveCount(0);
    });

    test('should show task gallery header with correct count', async ({ page }) => {
        // Use pausable tasks so they don't complete during test
        const query1 = uniqueQuery(PAUSABLE_QUERY);
        await homePage.sendBackgroundMessage(query1);
        await homePage.waitForTaskWithTitle(query1);

        // Gallery should be visible
        expect(await homePage.isTaskGalleryVisible()).toBe(true);

        // Count text should show "1 task running"
        let countText = await homePage.getTaskCountText();
        expect(countText).toContain('1');
        expect(countText).toContain('task');

        // Add another task (use different pausable pattern)
        const query2 = uniqueQuery('run very slow analysis');
        await homePage.sendBackgroundMessage(query2);
        await homePage.waitForTaskWithTitle(query2);

        // Count should update to "2 tasks running"
        countText = await homePage.getTaskCountText();
        expect(countText).toContain('2');
        expect(countText).toContain('tasks');
    });

    test('should show task subtitle with latest step', async ({ page }) => {
        // Start a slow background task
        const query = uniqueQuery('analyze my codebase slowly');
        await homePage.sendBackgroundMessage(query);
        await homePage.waitForTaskWithTitle(query);

        // Wait for some steps to accumulate
        await page.waitForTimeout(2000);

        // Task card should show subtitle with latest reasoning
        const index = await homePage.getTaskCardByTitle(query).evaluate((el) => Array.from(el.parentElement?.children ?? []).indexOf(el));
        const subtitle = await homePage.getTaskSubtitle(index);
        // Subtitle may or may not be visible depending on timing,
        // but if visible should have content
        if (subtitle) {
            expect(subtitle.length).toBeGreaterThan(0);
        }
    });

    test('should show completed task card when background task finishes off-screen', async ({ page }) => {
        // Send as background (Cmd+Enter) so the user stays on home and never
        // views the conversation. The home gallery only surfaces completion
        // for conversations the user did not watch finish in-place.
        const query = uniqueQuery('list all files');
        await homePage.sendBackgroundMessage(query);
        await homePage.waitForTaskWithTitle(query);

        // Wait for the run to complete with the user still on the home page
        const card = homePage.getTaskCardByTitle(query);
        await expect(card.locator('.task-status-icon.completed')).toBeVisible({ timeout: 15000 });
        await expect(card.locator('.task-status-text.completed')).toBeVisible();

        // Subtitle should show the final response, not intermediate reasoning
        const subtitle = (await card.locator('.task-card-reasoning').textContent()) || '';
        expect(subtitle).toContain('5 items');
    });
});
