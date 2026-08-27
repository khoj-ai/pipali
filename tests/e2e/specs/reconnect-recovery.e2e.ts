/**
 * Reconnect Recovery Tests
 *
 * Backgrounding the app on a phone drops its socket while the run keeps going server-side. The
 * event bus replays nothing once that run has finished, so catching up is the client's job:
 * reconnecting alone must re-read persisted history, with no reload or conversation switch.
 */

import { test, expect, type Page } from '@playwright/test';
import { ChatPage } from '../helpers/page-objects';

type SocketControls = { __dropSocket: () => void; __restoreSocket: () => void };

/**
 * Take the page's link to the server down and put it back up.
 *
 * Offline emulation leaves an established socket alone, so drop it from the page instead. While
 * down, each reconnect attempt is aborted mid-handshake, which is what a phone off the tailnet
 * sees: the client keeps retrying and keeps failing.
 */
async function installSocketControls(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const NativeWebSocket = window.WebSocket;
        const sockets: WebSocket[] = [];
        let down = false;

        window.WebSocket = class extends NativeWebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                sockets.push(this);
                if (down) this.close();
            }
        };

        Object.assign(window, {
            __dropSocket: () => { down = true; for (const socket of sockets) socket.close(); },
            __restoreSocket: () => { down = false; },
        });
    });
}

test('a run that finished while the socket was down appears on reconnect', async ({ page, request }) => {
    const chatPage = new ChatPage(page);
    await installSocketControls(page);
    await chatPage.goto();
    await chatPage.startNewChat();
    await chatPage.waitForConnection();

    // The pausable scenario takes ~10s, so the run outlives the disconnect below
    await chatPage.sendMessage(`run a pausable analysis [e2e-${Date.now()}]`);
    await chatPage.waitForProcessing();
    await chatPage.waitForThoughts();
    const conversationId = await chatPage.waitForConversationId();

    await page.evaluate(() => (window as unknown as SocketControls).__dropSocket());
    await expect(chatPage.inputTextarea).toBeDisabled();

    // Let the run finish with nobody listening
    await expect.poll(async () => {
        const conversations = await request.get('/api/conversations').then(res => res.json());
        return conversations.conversations.find((conv: { id: string }) => conv.id === conversationId)?.isActive;
    }, { timeout: 30000 }).toBe(false);
    expect(await chatPage.getLastAssistantMessage()).not.toContain('Slow analysis completed successfully.');

    await page.evaluate(() => (window as unknown as SocketControls).__restoreSocket());
    await chatPage.waitForConnection();

    // No reload and no conversation switch: reconnecting alone has to surface the finished run
    await chatPage.waitForAssistantResponse();
    expect(await chatPage.getLastAssistantMessage()).toContain('Slow analysis completed successfully.');
});
