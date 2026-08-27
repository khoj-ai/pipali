/**
 * Conversation List Tests
 *
 * The sidebar's list and its search, read straight from the endpoint that serves them.
 * Each conversation contributes one preview and one search hit, both looked up per
 * conversation rather than by reading every step of every conversation.
 */

import { test, expect, type Page } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

interface ListedConversation {
    id: string;
    title: string;
    preview: string;
    isActive: boolean;
    isAutomation: boolean;
    isPinned: boolean;
    matchSnippet?: string;
}

async function listConversations(page: Page, q?: string): Promise<ListedConversation[]> {
    const response = await page.request.get(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    expect(response.ok()).toBe(true);
    return (await response.json()).conversations;
}

/** Hold a conversation the mock answers immediately, and return its id. */
async function haveConversation(page: Page, message: string): Promise<string> {
    const chatPage = new ChatPage(page);
    await chatPage.goto();
    await say(page, message);

    const conversationId = await page.evaluate(() => new URL(window.location.href).searchParams.get('conversationId'));
    expect(conversationId).toBeTruthy();
    return conversationId!;
}

/** Say something more in the conversation already open. */
async function say(page: Page, message: string): Promise<void> {
    const chatPage = new ChatPage(page);
    await chatPage.inputTextarea.fill(message);
    await chatPage.sendButton.click();
    await chatPage.waitForAssistantResponse();
}

test.describe('Conversation List', () => {
    test('lists a conversation with the first thing the user said as its preview', async ({ page }) => {
        const message = 'quick question about the harbour survey';
        const conversationId = await haveConversation(page, message);

        const conversations = await listConversations(page);
        const listed = conversations.find(c => c.id === conversationId);

        expect(listed).toBeDefined();
        expect(listed!.preview).toBe(message);
        expect(listed!.title).toBeTruthy();
        expect(listed!.isAutomation).toBe(false);
        expect(listed!.isPinned).toBe(false);
        // Newest first, and this one was just spoken to.
        expect(conversations[0]!.id).toBe(conversationId);
    });

    test('search finds a conversation by what was said in it, with a snippet', async ({ page }) => {
        const needle = `zephyranthes${Date.now()}`;
        // Said after the opening message, so the hit is a step the preview never covers.
        const conversationId = await haveConversation(page, 'quick note on the greenhouse');
        await say(page, `quick follow up about ${needle} in the cold frame`);
        await haveConversation(page, 'quick unrelated errand');

        const found = await listConversations(page, needle);

        expect(found.map(c => c.id)).toEqual([conversationId]);
        expect(found[0]!.matchSnippet).toContain(needle);
    });

    test('search finds the assistant side of a conversation too', async ({ page }) => {
        // The mock answers anything "quick" with this, so it is only in agent steps.
        const conversationId = await haveConversation(page, 'quick check on the mooring lines');

        const found = await listConversations(page, 'Quick response completed');

        expect(found.map(c => c.id)).toContain(conversationId);
    });

    test('a match in the title alone needs no snippet', async ({ page }) => {
        const conversationId = await haveConversation(page, 'quick look at the tide tables');
        const [listed] = await listConversations(page);
        const titleWord = listed!.title.split(' ').find(word => word.length > 4);
        expect(titleWord).toBeTruthy();

        const found = await listConversations(page, titleWord!);
        const hit = found.find(c => c.id === conversationId);

        expect(hit).toBeDefined();
        expect(hit!.matchSnippet).toBeUndefined();
    });

    test('search that matches nothing comes back empty', async ({ page }) => {
        await haveConversation(page, 'quick word about the ferry');

        expect(await listConversations(page, `nothing-matches-${Date.now()}`)).toEqual([]);
    });
});
