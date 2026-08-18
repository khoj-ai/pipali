/**
 * Background Command Tests
 *
 * A shell command marked run_in_background outlives the tool call that started it.
 * The turn ends immediately, the command's output goes to a log file, and the
 * conversation is told when it exits - the same inbox delegated tasks report through.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFile } from 'fs/promises';
import { ChatPage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';
import { stopAllActiveConversations, stopAllActiveRunsFromHome } from '../helpers/cleanup';

type SystemStep = { source: string; message?: string; extra?: { kind?: string } };

/** What the mock LLM was handed, one line per request - see mock-preload. */
type RequestRecord = {
    query: string;
    sessionId?: string;
    runId?: string;
    tail: { type?: string | null; role?: string; text: string };
    systemUpdates: string[];
};

async function historyOf(request: APIRequestContext, conversationId: string): Promise<SystemStep[]> {
    const res = await request.get(`/api/chat/${conversationId}/history`);
    return (await res.json() as { history: SystemStep[] }).history;
}

async function backgroundUpdates(request: APIRequestContext, conversationId: string): Promise<SystemStep[]> {
    return (await historyOf(request, conversationId))
        .filter(s => s.source === 'system' && s.extra?.kind === 'background_command_update');
}

/** Requests from the most recent conversation that answered this prompt. */
async function requestsFor(prompt: string): Promise<RequestRecord[]> {
    const path = process.env.TEST_REQUEST_LOG;
    if (!path) throw new Error('TEST_REQUEST_LOG not set - global-setup may not have run');
    const contents = await readFile(path, 'utf8').catch(() => '');
    const records = contents
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as RequestRecord)
        .filter(record => record.query === prompt);
    // A retried spec answers the same prompt again; only the last attempt is ours.
    const session = records.at(-1)?.sessionId;
    return records.filter(record => record.sessionId === session);
}

/** Run ids in the order they first appear, so an extra one means an extra run. */
function runsIn(records: RequestRecord[]): string[] {
    return [...new Set(records.map(record => record.runId!))];
}

function carriesUpdate(records: RequestRecord[], marker: string): boolean {
    return records.some(record => record.systemUpdates.some(update => update.includes(marker)));
}

test.describe('Background commands', () => {
    test.afterEach(async ({ page, request }) => {
        await stopAllActiveConversations(page, request);
        await stopAllActiveRunsFromHome(page);
    });

    test('the turn ends before the command does, then its exit is reported', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('run something in the background');

        const conversationId = await chatPage.waitForConversationId();

        // Backgrounding does not skip approval - confirmation happens before the spawn.
        await chatPage.waitForConfirmationDialog();
        await chatPage.clickConfirmationButton('yes');

        // The turn does not block on a command that takes seconds.
        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('running in the background', { timeout: 15000 });
        await expect.poll(
            () => chatPage.isProcessing(),
            { timeout: 15000, message: 'expected the turn to end while the command runs' },
        ).toBe(false);

        // The command reports itself when it exits, without the user asking.
        await expect.poll(
            async () => (await backgroundUpdates(request, conversationId)).length,
            { timeout: 30000, message: 'expected the command to report its exit' },
        ).toBeGreaterThan(0);

        const [update] = await backgroundUpdates(request, conversationId);
        expect(update!.message).toContain('[Background command finished]');
        // Output written after the tool call returned still reaches the conversation.
        expect(update!.message).toContain('done-in-background');
    });

    test('stopping a command it started does not make it answer twice', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('start and stop something in the background');

        const conversationId = await chatPage.waitForConversationId();
        await chatPage.waitForConfirmationDialog();
        await chatPage.clickConfirmationButton('yes');

        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('stopped it again', { timeout: 20000 });
        await expect.poll(
            () => chatPage.isProcessing(),
            { timeout: 20000, message: 'expected the turn to end' },
        ).toBe(false);

        const responsesAfterAnswering = await chatPage.getMessageCount();

        // The kill produces an exit event of its own. Reporting it would wake the
        // conversation to announce a stop it had just carried out itself.
        await page.waitForTimeout(6000);
        expect(await chatPage.isProcessing()).toBe(false);
        expect(await chatPage.getMessageCount()).toEqual(responsesAfterAnswering);
        expect(await backgroundUpdates(request, conversationId)).toHaveLength(0);
    });

    test('a command finishing mid-turn is picked up by the turn in flight', async ({ page, request }) => {
        const prompt = 'report the background command while working';
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage(prompt);

        const conversationId = await chatPage.waitForConversationId();
        await chatPage.waitForConfirmationDialog();
        await chatPage.clickConfirmationButton('yes');

        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('while I was still working', { timeout: 30000 });
        await expect.poll(
            () => chatPage.isProcessing(),
            { timeout: 20000, message: 'expected the turn to end' },
        ).toBe(false);

        // The update reached the model within the run that was already going, rather
        // than sitting unread until a run of its own.
        const records = await requestsFor(prompt);
        expect(runsIn(records)).toHaveLength(1);
        expect(carriesUpdate(records, 'mid-run-marker')).toBe(true);

        // So nothing wakes the conversation afterwards to report it a second time.
        await page.waitForTimeout(6000);
        expect(await chatPage.isProcessing()).toBe(false);
        expect(runsIn(await requestsFor(prompt))).toHaveLength(1);
    });

    test('a command finishing mid-answer wakes a turn that ends on the update', async ({ page, request }) => {
        const prompt = 'report the background command after answering';
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage(prompt);

        const conversationId = await chatPage.waitForConversationId();
        await chatPage.waitForConfirmationDialog();
        await chatPage.clickConfirmationButton('yes');

        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('I will report back', { timeout: 30000 });

        // The update landed after the last iteration that could have picked it up, so the
        // conversation is woken - and answers, rather than being refused for resuming on
        // its own last message.
        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('finished while I was answering', { timeout: 40000 });

        const records = await requestsFor(prompt);
        const runs = runsIn(records);
        expect(runs).toHaveLength(2);
        // The woken turn is answering the update, so that is what its request ends on.
        const woken = records.filter(record => record.runId === runs[1]);
        expect(woken[0]!.tail.role).toBe('system');
        expect(woken[0]!.tail.text).toContain('late-marker');

        // The run answered past the update and buried it, so waking it moved the update
        // back out: after the answer that buried it, before the turn woken to report it.
        const steps = await historyOf(request, conversationId);
        const indexOf = (text: string) => steps.findIndex(step => step.message?.includes(text));
        expect(steps.filter(step => step.extra?.kind === 'background_command_update')).toHaveLength(1);
        expect(indexOf('[Background command finished]')).toBeGreaterThan(indexOf('Started it, I will report back'));
        expect(indexOf('[Background command finished]')).toBeLessThan(indexOf('finished while I was answering'));

        // Moved, not re-asked: waking the conversation invents no user message.
        expect(steps.filter(step => step.source === 'user')).toHaveLength(1);
    });
});
