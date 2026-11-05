/**
 * Message Edit Tests
 *
 * Editing a sent message rewinds the conversation to just before it and asks again.
 * The rewrite takes the original's place and gets the only answer, even when the
 * original was still being answered.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import { ChatPage } from '../helpers/page-objects';

type HistoryStep = { source: string; message?: string; extra?: { kind?: string } };

async function getHistory(request: APIRequestContext, conversationId: string): Promise<HistoryStep[]> {
    const res = await request.get(`/api/chat/${conversationId}/history`);
    const { history } = await res.json() as { history: HistoryStep[] };
    return history;
}

test.describe('Message Edit', () => {
    let chatPage: ChatPage;

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
    });

    test('editing a message the model is still thinking about replaces it', async ({ request }) => {
        await chatPage.sendMessage('think it over slowly');
        const convId = await chatPage.waitForConversationId();
        await chatPage.waitForProcessing();

        await chatPage.editUserMessage(0, 'you good');
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        expect(await chatPage.getUserMessages()).toEqual(['you good']);
        await expect(chatPage.assistantMessages).toHaveCount(1);
        expect(await chatPage.getLastAssistantMessage()).toContain('great');

        const history = await getHistory(request, convId);
        expect(history.filter(s => s.source === 'user').map(s => s.message)).toEqual(['you good']);
        expect(history.map(s => s.message)).not.toContain('Here is what I thought over.');
    });

    test.describe('with a memory to recall', () => {
        // The file name the mock recall selectors pick
        const memoryPath = path.join(process.env.TEST_MEMORY_DIR!, 'favorite-editor.md');

        test.beforeAll(async () => {
            await mkdir(path.dirname(memoryPath), { recursive: true });
            await writeFile(memoryPath, '---\ndescription: Preferred code editor\ntype: user\n---\n\nThey prefer the Helix editor.\n');
        });

        test.afterAll(async () => {
            await rm(memoryPath, { force: true });
        });

        test('editing a message during recall leaves nothing of its turn behind', async ({ request }) => {
            await chatPage.sendMessage('recall it slowly');
            const convId = await chatPage.waitForConversationId();

            // The stopped turn records its recall when the call returns, while the
            // rewrite is still thinking
            await chatPage.editUserMessage(0, 'think it over slowly');
            await chatPage.waitForAssistantResponse();
            await chatPage.waitForIdle();

            const history = await getHistory(request, convId);
            expect(history.filter(s => s.source === 'user').map(s => s.message)).toEqual(['think it over slowly']);
            expect(history.filter(s => s.extra?.kind === 'memory_recall')).toHaveLength(1);
            expect(history.at(-1)?.message).toBe('Here is what I thought over.');
        });
    });
});
