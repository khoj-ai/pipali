/**
 * Pause/Resume Task Tests
 *
 * Tests for pausing and resuming tasks during execution.
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

test.describe('Pause/Resume Task', () => {
    let chatPage: ChatPage;

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
    });

    // Use "pausable" keyword to trigger slow mock scenario (1s between steps)
    const PAUSABLE_QUERY = 'run a pausable analysis';

    test('should show pause button during active processing', async () => {
        // Send a query that triggers multi-step processing
        await chatPage.sendMessage(PAUSABLE_QUERY);

        // Wait for processing to start
        await chatPage.waitForProcessing();

        // Verify pause button is visible
        expect(await chatPage.pauseButton.isVisible()).toBe(true);
        expect(await chatPage.playButton.isVisible()).toBe(false);
    });

    test('should pause task when pause button is clicked', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();

        // Click pause (pauseTask handles UI stabilization internally)
        await chatPage.pauseTask();

        // Verify play button appears (paused state)
        await chatPage.playButton.waitFor({ state: 'visible', timeout: 5000 });
        expect(await chatPage.playButton.isVisible()).toBe(true);
        expect(await chatPage.pauseButton.isVisible()).toBe(false);

        // Verify input hint changes to indicate paused state
        const hint = await chatPage.inputHint.textContent();
        expect(hint?.toLowerCase()).toContain('paused');
    });

    test('should pause task when Escape is pressed', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();

        // Wait for UI to stabilize (at least one tool call)
        try {
            await chatPage.page.waitForSelector('.thought-item', { timeout: 5000 });
        } catch {
            // Continue if already has tool calls
        }
        await chatPage.page.waitForTimeout(300);

        // Press Escape to pause
        await chatPage.pressEscape();

        // Verify paused state
        await chatPage.playButton.waitFor({ state: 'visible', timeout: 5000 });
        expect(await chatPage.isPaused()).toBe(true);
    });

    test('should resume task when play button is clicked', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();
        await chatPage.pauseTask();

        // Wait for paused state
        await chatPage.playButton.waitFor({ state: 'visible' });

        // Resume
        await chatPage.resumeTask();

        // Verify processing resumes (pause button visible again or task completes)
        // The task might complete before we can check, so we check for either state
        await chatPage.page.waitForFunction(
            ([pauseSel, playSel]: [string, string]) => {
                const pauseBtn = document.querySelector(pauseSel);
                const playBtn = document.querySelector(playSel);
                // Either processing (pause visible) or completed (neither visible)
                return pauseBtn !== null || (pauseBtn === null && playBtn === null);
            },
            ['.action-button.pause', '.action-button.play'] as [string, string],
            { timeout: 10000 }
        );
    });

    test('should resume task with additional message', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();
        await chatPage.pauseTask();
        await chatPage.playButton.waitFor({ state: 'visible' });

        // Type a message while paused and send
        await chatPage.inputTextarea.fill('focus on the tests folder');
        await chatPage.sendButton.click();

        // Should resume - wait for processing or completion
        await chatPage.page.waitForFunction(
            (pauseSel) => {
                const pauseBtn = document.querySelector(pauseSel);
                // Either processing resumed or completed
                return pauseBtn !== null || document.querySelector('.message-content') !== null;
            },
            '.action-button.pause',
            { timeout: 15000 }
        );
    });

    test('should show send button instead of pause when input has text', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();

        // Wait for UI to stabilize (at least one tool call)
        try {
            await chatPage.page.waitForSelector('.thought-item', { timeout: 5000 });
        } catch {
            // Continue if already has tool calls
        }
        await chatPage.page.waitForTimeout(300);

        // Initially pause button should be visible
        await chatPage.pauseButton.waitFor({ state: 'visible', timeout: 3000 });
        expect(await chatPage.pauseButton.isVisible()).toBe(true);

        // Type some text
        await chatPage.inputTextarea.fill('additional query');

        // Now send button should be visible instead of pause
        await chatPage.sendButton.waitFor({ state: 'visible', timeout: 3000 });
        expect(await chatPage.sendButton.isVisible()).toBe(true);

        // Clear the input
        await chatPage.inputTextarea.fill('');

        // Pause button should be back
        await chatPage.pauseButton.waitFor({ state: 'visible', timeout: 3000 });
    });

    test('should show play button when paused with no input', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();
        await chatPage.pauseTask();

        // Verify play button is visible when input is empty
        await chatPage.playButton.waitFor({ state: 'visible' });
        expect(await chatPage.playButton.isVisible()).toBe(true);
    });

    test('should show send button when paused with input text', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();
        await chatPage.pauseTask();
        await chatPage.playButton.waitFor({ state: 'visible' });

        // Type some text while paused
        await chatPage.inputTextarea.fill('resume with this message');

        // Send button should appear
        await chatPage.sendButton.waitFor({ state: 'visible', timeout: 3000 });
        expect(await chatPage.sendButton.isVisible()).toBe(true);
    });

    test('should show active marker on sidebar conversation during processing', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();

        // Sidebar should show active task marker
        await chatPage.waitForActiveTaskInSidebar();
        expect(await chatPage.hasActiveTaskInSidebar()).toBe(true);
    });

    test('should show latest reasoning as conversation subtitle in sidebar', async () => {
        await chatPage.sendMessage(PAUSABLE_QUERY);
        await chatPage.waitForProcessing();

        // Wait for active task marker first
        await chatPage.waitForActiveTaskInSidebar();

        // Wait for some thoughts to accumulate
        await chatPage.page.waitForTimeout(2000);

        // Sidebar should show subtitle with latest reasoning
        const subtitle = await chatPage.getConversationSubtitleFromSidebar();
        // Subtitle should contain some text (the latest reasoning step)
        expect(subtitle.length).toBeGreaterThan(0);
    });
});
