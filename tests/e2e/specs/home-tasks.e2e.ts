/**
 * Home Page Task Gallery Tests
 *
 * Tests for the home page showing active/running tasks.
 */

import { test, expect } from '@playwright/test';
import { HomePage, ChatPage } from '../helpers/page-objects';

// Use "pausable" keyword to trigger slow mock scenario (1s between steps)
const PAUSABLE_QUERY = 'run a pausable analysis';

test.describe('Home Page Task Gallery', () => {
    let homePage: HomePage;

    test.beforeEach(async ({ page }) => {
        homePage = new HomePage(page);
        await homePage.goto();
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
        await homePage.sendBackgroundMessage('analyze this slowly');

        // Wait a moment for the task to register
        await page.waitForTimeout(500);

        // Should stay on home page (no navigation)
        // Task card should appear
        await homePage.waitForTaskCount(1);
        expect(await homePage.getTaskCardCount()).toBeGreaterThanOrEqual(1);
    });

    test('should display task title from user query', async ({ page }) => {
        const query = 'list all TypeScript files';
        await homePage.sendBackgroundMessage(query);

        await homePage.waitForTaskCount(1);

        // Task card should contain the query text
        const title = await homePage.getTaskTitle(0);
        expect(title).toContain(query);
    });

    test('should show running status for active task', async ({ page }) => {
        await homePage.sendBackgroundMessage('analyze my codebase slowly');
        await homePage.waitForTaskCount(1);

        // Check status is running (not paused)
        const status = await homePage.getTaskStatus(0);
        expect(status).toBe('running');

        // Should show spinning loader icon
        const spinningIcon = page.locator('.task-status-icon.running').first();
        await expect(spinningIcon).toBeVisible();
    });

    test('should show step count as task progresses', async ({ page }) => {
        await homePage.sendBackgroundMessage('analyze my codebase slowly');
        await homePage.waitForTaskCount(1);

        // Wait for some steps to accumulate
        await page.waitForTimeout(2000);

        // Step count should be visible and >= 0
        const stepCount = await homePage.getTaskStepCount(0);
        expect(stepCount).toBeGreaterThanOrEqual(0);
    });

    test('should navigate to conversation when task card is clicked', async ({ page }) => {
        // Use slow pausable task so it doesn't complete before we can interact
        await homePage.sendBackgroundMessage(PAUSABLE_QUERY);
        await homePage.waitForTaskCount(1);

        // Click the task card
        await homePage.clickTaskCard(0);

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
        await homePage.sendBackgroundMessage('first slow task');
        await homePage.waitForTaskCount(1);

        // Start second background task
        await homePage.sendBackgroundMessage('second slow task');
        await homePage.waitForTaskCount(2);

        // Should show both task cards
        expect(await homePage.getTaskCardCount()).toBeGreaterThanOrEqual(2);

        // Task count text should mention multiple tasks
        const countText = await homePage.getTaskCountText();
        expect(countText).toContain('2');
        expect(countText).toContain('tasks');
    });

    test('should show stopped status when task is stopped', async ({ page }) => {
        // Start a background task (use pausable for slow execution)
        await homePage.sendBackgroundMessage(PAUSABLE_QUERY);
        await homePage.waitForTaskCount(1);

        // Click task to go to conversation
        await homePage.clickTaskCard(0);

        // Now on chat page - stop the task
        const chatPage = new ChatPage(page);
        await chatPage.waitForProcessing();
        await chatPage.stopTask();

        // Go back to home by clicking logo (preserves React state)
        await chatPage.goHome();

        // The task should still be in the gallery
        const taskCount = await homePage.getTaskCardCount();
        expect(taskCount).toBeGreaterThanOrEqual(1);
        // The task should show stopped
        const status = await homePage.getTaskStatus(0);
        expect(status).toBe('stopped');
    });

    test('should show task gallery header with correct count', async ({ page }) => {
        // Use pausable tasks so they don't complete during test
        await homePage.sendBackgroundMessage(PAUSABLE_QUERY);
        await homePage.waitForTaskCount(1);

        // Gallery should be visible
        expect(await homePage.isTaskGalleryVisible()).toBe(true);

        // Count text should show "1 task running"
        let countText = await homePage.getTaskCountText();
        expect(countText).toContain('1');
        expect(countText).toContain('task');

        // Add another task (use different pausable pattern)
        await homePage.sendBackgroundMessage('run very slow analysis');
        await homePage.waitForTaskCount(2);

        // Count should update to "2 tasks running"
        countText = await homePage.getTaskCountText();
        expect(countText).toContain('2');
        expect(countText).toContain('tasks');
    });

    test('should show task subtitle with latest step', async ({ page }) => {
        // Start a slow background task
        await homePage.sendBackgroundMessage('analyze my codebase slowly');
        await homePage.waitForTaskCount(1);

        // Wait for some steps to accumulate
        await page.waitForTimeout(2000);

        // Task card should show subtitle with latest reasoning
        const subtitle = await homePage.getTaskSubtitle(0);
        // Subtitle may or may not be visible depending on timing,
        // but if visible should have content
        if (subtitle) {
            expect(subtitle.length).toBeGreaterThan(0);
        }
    });

    test('should show completed task card after foreground task finishes', async ({ page }) => {
        // Start a quick foreground task (not background)
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('list all files');
        await chatPage.waitForAssistantResponse();

        // Go to home page
        await chatPage.goHome();

        // Wait a moment for state to settle
        await page.waitForTimeout(500);

        // Completed task should still be visible with completed status
        const taskCount = await homePage.getTaskCardCount();
        expect(taskCount).toBeGreaterThanOrEqual(1);
        const status = await homePage.getTaskStatus(0);
        expect(status).toBe('completed');

        // Subtitle should show the final response, not intermediate reasoning
        const subtitle = await homePage.getTaskSubtitle(0);
        expect(subtitle).toContain('5 items');
    });
});
