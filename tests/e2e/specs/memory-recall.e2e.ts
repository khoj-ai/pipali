/**
 * Memory Recall Tests
 *
 * A memory on disk relevant to the user's message is proactively injected
 * before the research loop and rendered collapsed in the transcript.
 */

import { test, expect } from '@playwright/test';
import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import { ChatPage } from '../helpers/page-objects';

const memoryDir = process.env.TEST_MEMORY_DIR!;
const memoryPath = path.join(memoryDir, 'favorite-editor.md');

test.describe('Memory Recall', () => {
    test.beforeAll(async () => {
        await mkdir(memoryDir, { recursive: true });
        await writeFile(
            memoryPath,
            '---\ndescription: Preferred code editor\ntype: user\nmodified: 2026-08-01T00:00:00.000Z\n---\n\nThey prefer the Helix editor.\n',
        );
    });

    // Remove the memory so later specs run against an empty store again
    test.afterAll(async () => {
        await rm(memoryPath, { force: true });
    });

    test('recalled memory renders collapsed in the transcript', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();

        await chatPage.sendMessage('what code editor do I prefer?');
        await chatPage.waitForAssistantResponse();
        await expect(page.getByText('You prefer the Helix editor.')).toBeVisible();

        // Recall steps render from persisted history
        await page.reload();
        await chatPage.waitForAssistantResponse();

        // Outline level shows only the recall label
        await chatPage.expandThoughts();
        await expect(page.getByText('Recalled 1 memory.')).toBeVisible();
        await expect(page.getByText('They prefer the Helix editor.')).not.toBeVisible();

        // Full level shows the recalled body
        await chatPage.thoughtsToggle.click();
        await expect(page.getByText('They prefer the Helix editor.')).toBeVisible();
    });
});
