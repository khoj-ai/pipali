/**
 * What the composer redraws. Render work on this path used to grow with the whole
 * conversation, which short test conversations on fast machines never feel, so these
 * assert on the components React rendered rather than on timings.
 */

import { test, expect, type Page } from '@playwright/test';
import { ChatPage, HomePage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';
import { readRenders, resetRenders, trackRenders } from '../helpers/react-renders';

/** A request from startup or a finished run that lands mid-typing redraws App. */
const settle = (page: Page) => page.waitForLoadState('networkidle');

test.describe('Render isolation', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('thoughts-expand-level', '2'));
        await trackRenders(page);
    });

    test('typing redraws the composer and nothing above it', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('list the project files');
        await chatPage.waitForAssistantResponse();
        await expect(chatPage.thoughtItems.first()).toBeVisible();
        await settle(page);

        const text = 'hello world';
        await resetRenders(page);
        await page.locator(Selectors.inputTextarea).pressSequentially(text);
        await expect(page.locator(Selectors.inputTextarea)).toHaveValue(text);

        const { counts } = await readRenders(page);
        expect(counts.InputArea).toBe(text.length);
        for (const component of ['App', 'Sidebar', 'MessageList', 'MessageItem', 'ThoughtItem', 'ChatMarkdown']) {
            expect(counts[component], `${component} rendered`).toBeUndefined();
        }
    });

    test('the home page follows the draft emptying and filling, not each keystroke', async ({ page }) => {
        const homePage = new HomePage(page);
        await homePage.goto();
        await expect(homePage.emptyState).toBeVisible();
        await settle(page);
        const textarea = page.locator(Selectors.inputTextarea);

        await resetRenders(page);
        await textarea.pressSequentially('abc');
        const typed = (await readRenders(page)).counts;
        expect(typed.EmptyHomeState).toBe(1);
        expect(typed.App).toBeUndefined();

        await resetRenders(page);
        await textarea.fill('');
        expect((await readRenders(page)).counts.EmptyHomeState).toBe(1);
    });

    test('a forked message lands back in the composer', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        const text = 'a question worth rewording';
        await chatPage.sendMessage(text);
        await chatPage.waitForAssistantResponse();

        await chatPage.userMessages.first().hover();
        await page.locator(Selectors.messageActionFork).click();

        await expect(page.locator(Selectors.inputTextarea)).toHaveValue(text);
    });
});
