/**
 * Delegation Tests
 *
 * Pipali can hand a bounded task to a separate conversation that works on it in the
 * background. The task is a normal conversation marked with a parent, and its result
 * comes back to the parent as a system message.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';
import { stopAllActiveConversations, stopAllActiveRunsFromHome } from '../helpers/cleanup';

type ConversationRow = {
    id: string;
    title: string;
    parentConversationId?: string | null;
    isActive?: boolean;
};

async function listConversations(request: APIRequestContext): Promise<ConversationRow[]> {
    const res = await request.get('/api/conversations');
    return (await res.json()).conversations as ConversationRow[];
}

async function childrenOf(request: APIRequestContext, parentId: string): Promise<ConversationRow[]> {
    const all = await listConversations(request);
    return all.filter(c => c.parentConversationId === parentId);
}

async function countTaskUpdates(request: APIRequestContext, conversationId: string): Promise<number> {
    const res = await request.get(`/api/chat/${conversationId}/history`);
    const { history } = await res.json() as {
        history: Array<{ source: string; extra?: { kind?: string } }>;
    };
    return history.filter(s => s.source === 'system' && s.extra?.kind === 'delegated_task_update').length;
}

/** Final responses, one per completed run - so an extra one means an extra run. */
async function countAgentResponses(request: APIRequestContext, conversationId: string): Promise<number> {
    const res = await request.get(`/api/chat/${conversationId}/history`);
    const { history } = await res.json() as {
        history: Array<{ source: string; message?: string; tool_calls?: unknown[] }>;
    };
    return history.filter(s => s.source === 'agent' && !!s.message && !s.tool_calls?.length).length;
}

/** Send a query from a fresh chat and return that conversation's id. */
async function delegateFrom(chatPage: ChatPage, query: string): Promise<string> {
    await chatPage.goto();
    await chatPage.sendMessage(query);
    return await chatPage.waitForConversationId();
}

test.describe('Delegation', () => {
    test.afterEach(async ({ page, request }) => {
        // Delegated work runs in conversations this context never opened, so clean up
        // from the server's active list rather than only Home's task cards.
        await stopAllActiveConversations(page, request);
        await stopAllActiveRunsFromHome(page);
    });

    test('delegating creates a child conversation linked to its parent', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        const parentId = await delegateFrom(chatPage, 'delegate a task');

        // The parent answers immediately rather than blocking on the task.
        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('background', { timeout: 15000 });

        await expect.poll(
            async () => (await childrenOf(request, parentId)).length,
            { timeout: 15000, message: 'expected a delegated child conversation' },
        ).toBeGreaterThan(0);

        const children = await childrenOf(request, parentId);
        expect(children[0]!.title).toBe('Delegated task');
    });

    test('a delegated task stays out of the sidebar, and its step opens it', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        // Delegate from a settled conversation: creating one refreshes the sidebar on its
        // own, which would hide whether the delegated task ever announces itself.
        await chatPage.sendMessage('hello there');
        await chatPage.waitForAssistantResponse();

        await chatPage.sendMessage('delegate a slow task');

        // The task belongs to the conversation that started it, not to the sidebar's own list
        await expect(
            page.locator(`${Selectors.conversationItem} .conversation-title`)
                .filter({ hasText: /^Slow delegated task$/ }),
        ).toHaveCount(0);

        // The collapsed preview drops tool results, and the task's id comes from one, so
        // the way in is the expanded trajectory - where step detail lives generally
        await page.locator('.thoughts-toggle').first().click();

        const delegateStep = page.locator('.thought-args-button').filter({ hasText: 'Slow delegated task' });
        await expect(delegateStep).toBeVisible({ timeout: 15000 });

        await delegateStep.click();
        await expect(page.locator(`${Selectors.conversationItem}.active .conversation-title`))
            .toHaveText('Slow delegated task', { timeout: 15000 });

        // Going back leaves the task for the conversation that started it
        await page.goBack();
        await expect(page.locator(`${Selectors.conversationItem}.active .conversation-title`))
            .not.toHaveText('Slow delegated task', { timeout: 15000 });
    });

    test('the delegated result comes back to the parent as a system step', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        const parentId = await delegateFrom(chatPage, 'delegate a task');

        await expect.poll(
            () => countTaskUpdates(request, parentId),
            { timeout: 30000, message: 'expected a delegated task update on the parent' },
        ).toBeGreaterThan(0);

        const { history } = await (await request.get(`/api/chat/${parentId}/history`)).json();
        const update = history.find((s: { source: string; extra?: { kind?: string } }) =>
            s.source === 'system' && s.extra?.kind === 'delegated_task_update');

        // The child's final response is passed through whole - it is the point of the task.
        expect(update.message).toContain('[Delegated task completed]');
        expect(update.message).toContain('This is a mock response for testing.');
    });

    test('unattended delegation chains are bounded', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        const parentId = await delegateFrom(chatPage, 'delegate a task');

        // Each completion wakes the parent, and this mock re-delegates every time it
        // wakes. The auto-start depth guard is what stops that from running away.
        await page.waitForTimeout(15000);

        const children = await childrenOf(request, parentId);
        expect(children.length).toBeGreaterThan(0);
        expect(children.length).toBeLessThanOrEqual(5);
    });

    test('a foreground task holds the turn in a single call, then answers', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        // run_in_background: false - delegate and wait are one tool call, not two.
        const parentId = await delegateFrom(chatPage, 'delegate and wait');

        // The turn stays open across the delegated work rather than ending early and
        // filling the gap with unrelated steps.
        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('waited for it', { timeout: 30000 });

        // Exactly one task was started - waiting is not polling.
        expect((await childrenOf(request, parentId)).length).toBe(1);

        // The result came back through the call, so no separate wake-up update was
        // appended for the same task.
        expect(await countTaskUpdates(request, parentId)).toBe(0);
    });

    test('several background tasks can be waited on together', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        const parentId = await delegateFrom(chatPage, 'delegate two and wait');

        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('Both parallel tasks finished', { timeout: 40000 });

        // Both ran as children of the same parent, concurrently rather than in sequence.
        expect((await childrenOf(request, parentId)).length).toBe(2);
        expect(await countTaskUpdates(request, parentId)).toBe(0);
    });

    test('a user message releases the agent from waiting', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        await delegateFrom(chatPage, 'delegate and wait');

        // Interrupt while it is blocked on the delegated task.
        await expect.poll(async () => {
            const all = await listConversations(request);
            return all.some(c => c.title === 'Awaited task' && c.isActive);
        }, { timeout: 20000, message: 'expected the awaited task to be running' }).toBe(true);

        await chatPage.sendMessage('actually, never mind');

        // The interruption is answered rather than sitting behind the wait timeout.
        await expect(page.locator(Selectors.userMessage, { hasText: 'actually, never mind' }))
            .toBeVisible({ timeout: 15000 });
        await expect.poll(
            () => chatPage.isProcessing(),
            { timeout: 30000, message: 'expected the parent to finish the interrupting turn' },
        ).toBe(false);
    });

    test('stopping a conversation also stops its running delegated tasks', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        // This scenario delegates long-running work and holds its own response open,
        // so both the parent and the child are in flight when we press stop.
        const parentId = await delegateFrom(chatPage, 'delegate a slow task');

        await expect.poll(
            async () => (await childrenOf(request, parentId)).length,
            { timeout: 15000, message: 'expected a delegated child conversation' },
        ).toBeGreaterThan(0);

        const [child] = await childrenOf(request, parentId);
        await expect.poll(async () => {
            const all = await listConversations(request);
            return all.find(c => c.id === child!.id)?.isActive ?? false;
        }, { timeout: 15000, message: 'expected the delegated task to be running' }).toBe(true);

        await chatPage.stopTask();

        // Stopping is the user's only handle on work Pipali started on its own.
        await expect.poll(async () => {
            const all = await listConversations(request);
            return all.find(c => c.id === child!.id)?.isActive ?? false;
        }, { timeout: 15000, message: 'expected the delegated task to stop with its parent' }).toBe(false);

        // It stays readable afterwards.
        const all = await listConversations(request);
        expect(all.some(c => c.id === child!.id)).toBe(true);
    });

    test('stopping a task it started does not make it answer twice', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        const parentId = await delegateFrom(chatPage, 'delegate and stop');

        await expect(page.locator(Selectors.assistantMessage).last())
            .toContainText('stopped it again', { timeout: 30000 });
        await expect.poll(
            () => chatPage.isProcessing(),
            { timeout: 20000, message: 'expected the turn to end' },
        ).toBe(false);

        const responsesAfterAnswering = await countAgentResponses(request, parentId);

        // The stopped task reports that it did not finish, which is what was asked for.
        // Relaying it would wake the conversation to announce its own decision.
        await page.waitForTimeout(6000);
        expect(await chatPage.isProcessing()).toBe(false);
        expect(await countAgentResponses(request, parentId)).toBe(responsesAfterAnswering);
        expect(await countTaskUpdates(request, parentId)).toBe(0);
    });

    test('a stopped conversation stays stopped when its tasks report back', async ({ page, request }) => {
        const chatPage = new ChatPage(page);
        const parentId = await delegateFrom(chatPage, 'delegate a slow task');

        await expect.poll(
            async () => (await childrenOf(request, parentId)).length,
            { timeout: 15000, message: 'expected a delegated child conversation' },
        ).toBeGreaterThan(0);

        await chatPage.stopTask();
        const responsesAtStop = await countAgentResponses(request, parentId);

        // The cascade makes every child report that it did not finish. Relaying that would
        // restart the conversation to narrate the stop the user just asked for.
        await page.waitForTimeout(6000);
        expect(await chatPage.isProcessing()).toBe(false);
        expect(await countAgentResponses(request, parentId)).toBe(responsesAtStop);

        // Stopping holds only until the user is back: this turn answers, and then a
        // delegated result wakes the chat again on its own.
        await chatPage.sendMessage('delegate a task');
        await expect.poll(
            () => countAgentResponses(request, parentId),
            { timeout: 40000, message: 'expected a delegated result to wake the chat again' },
        ).toBeGreaterThan(responsesAtStop + 1);
    });
});
