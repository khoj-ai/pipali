/**
 * What the composer and a live run redraw. Render work on either path used to grow with
 * the whole conversation, which short test conversations on fast machines never feel, so
 * these assert on the components React rendered rather than on timings.
 */

import { test, expect, type Page } from '@playwright/test';
import { ChatPage, HomePage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';
import { readRenders, resetRenders, trackRenders } from '../helpers/react-renders';

/**
 * The mock model streams nothing, so a spec plays the server's part for one run. Events
 * published through this reach the page on its chat socket, addressed to the conversation
 * the server last spoke about.
 */
async function scriptRun(page: Page, runId: string): Promise<(type: string, data?: object) => void> {
    let publish: (event: object) => void = () => { throw new Error('No conversation to publish to yet'); };
    await page.routeWebSocket(/\/ws\/chat/, socket => {
        const server = socket.connectToServer();
        socket.onMessage(message => server.send(message));
        server.onMessage(message => {
            socket.send(message);
            const { conversationId } = JSON.parse(String(message));
            if (conversationId) publish = event => socket.send(JSON.stringify({ conversationId, runId, ...event }));
        });
    });
    return (type, data) => publish({ type, data });
}

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

    test('a live run redraws only the rows it changes', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('list the project files');
        await chatPage.waitForAssistantResponse();

        await chatPage.sendMessage('run a pausable analysis');
        await page.waitForFunction(
            ({ selector, rows }) => document.querySelectorAll(selector).length >= rows,
            { selector: Selectors.thoughtItem, rows: 8 },
            { timeout: 20000 },
        );

        // Steps land in bursts, so wait on rows arriving after the reset, not on a total
        await resetRenders(page);
        const rowsAtReset = await chatPage.thoughtItems.count();
        await page.waitForFunction(
            ({ selector, rows }) => document.querySelectorAll(selector).length >= rows,
            { selector: Selectors.thoughtItem, rows: rowsAtReset + 2 },
            { timeout: 20000 },
        );

        const { counts, messageIds, thoughtIds } = await readRenders(page);
        expect(counts.ThoughtItem).toBeGreaterThan(0);
        // The whole update landed on the run's own message...
        expect(new Set(messageIds).size).toBe(1);
        // ...and left the steps that had already finished alone.
        expect(thoughtIds).not.toContain('tc-slow-1');
        expect(thoughtIds).not.toContain('tc-slow-2');

        await chatPage.stopTask();
    });

    for (const [view, level] of [['expanded', '2'], ['collapsed', '0']] as const) {
        test(`streamed deltas redraw only the row being written, ${view}`, async ({ page }) => {
            await page.addInitScript(level => localStorage.setItem('thoughts-expand-level', level), level);
            const runId = 'scripted-run';
            const publish = await scriptRun(page, runId);
            const chatPage = new ChatPage(page);
            await chatPage.goto();
            await chatPage.sendMessage('list the project files');
            await chatPage.waitForAssistantResponse();

            // A finished step with what a delta could churn: a thought shown as two rows, and
            // a snapshot, whose lookup reaches every row
            publish('run_started');
            publish('step_start', {
                thought: '**Reading the page**\nIt has a form.\n**Planning the click**\nSubmit comes next.',
                toolCalls: [{ function_name: 'chrome-browser__take_snapshot', arguments: {}, tool_call_id: 'tc-snapshot' }],
            });
            publish('step_end', {
                toolResults: [{ source_call_id: 'tc-snapshot', content: 'uid=1_0 RootWebArea "Checkout"\n  uid=1_1 button "Submit"' }],
            });
            await expect(chatPage.thoughtItems.filter({ hasText: /snapshot/i })).toBeVisible();

            await resetRenders(page);
            for (const delta of ['Submit is ', 'the button ', 'to press. ', 'Checking it ', 'is enabled.']) {
                publish('reasoning_delta', { delta });
            }
            // Collapsed, the reasoning is not on screen to wait for
            await expect.poll(async () => (await readRenders(page)).counts.ThoughtsSection).toBeGreaterThan(0);

            const { messageIds, thoughtIds } = await readRenders(page);
            expect(new Set(messageIds)).toEqual(new Set([runId]));
            expect(thoughtIds.filter(id => id !== `reasoning-stream-${runId}`)).toEqual([]);
        });
    }

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
