import type { APIRequestContext, Page } from '@playwright/test';
import { HomePage, ChatPage } from './page-objects';
import { Selectors } from './selectors';

/**
 * Stop all currently active runs visible on Home (running or needs_input).
 *
 * E2E tests share a single server process; runs continue even if the page that started them is closed.
 * This helper prevents state leakage (active tasks + confirmation toasts) into later tests.
 */
/**
 * Stop every conversation the server still reports as active.
 *
 * Home's task cards only show what this browser context knows about, which misses runs
 * an agent started on its own. This drives cleanup from the server's own list instead,
 * so delegated work can't leak into the next spec.
 */
export async function stopAllActiveConversations(
    page: Page,
    request: APIRequestContext,
    opts?: { maxPasses?: number },
): Promise<void> {
    const chatPage = new ChatPage(page);
    let quietPasses = 0;

    for (let pass = 0; pass < (opts?.maxPasses ?? 20); pass++) {
        const res = await request.get('/api/conversations');
        if (!res.ok()) return;
        const { conversations } = await res.json() as { conversations: { id: string; isActive?: boolean }[] };
        const active = conversations.filter(c => c.isActive);

        if (active.length === 0) {
            // A completed task can wake its parent, which may start more work, so a single
            // quiet reading isn't enough - wait for it to stay quiet.
            if (++quietPasses >= 2) return;
            await page.waitForTimeout(1500);
            continue;
        }

        quietPasses = 0;
        for (const conversation of active) {
            await chatPage.gotoConversation(conversation.id);
            try {
                await chatPage.stopButton.waitFor({ state: 'visible', timeout: 3000 });
                await chatPage.stopButton.click();
                await chatPage.waitForIdle();
            } catch {
                // Finished on its own between listing and opening.
            }
        }
    }
}

export async function stopAllActiveRunsFromHome(page: Page, opts?: { maxPasses?: number }): Promise<void> {
    const maxPasses = opts?.maxPasses ?? 10;
    const homePage = new HomePage(page);
    const chatPage = new ChatPage(page);

    // Always return to Home before cleanup, but preserve React state if we're already in-app.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await homePage.waitForConnection();

    const activeSelector = `${Selectors.taskCard}.running, ${Selectors.taskCard}.needs-input`;

    for (let pass = 0; pass < maxPasses; pass++) {
        const activeCount = await page.locator(activeSelector).count();
        if (activeCount === 0) return;

        // A run can finish on its own between the count above and the reads below,
        // which flips the card to .completed so this locator no longer matches.
        // That card needs no stopping, so re-check instead of waiting it out.
        const activeCard = page.locator(activeSelector).first();
        const cardTitle = await activeCard
            .locator('.task-card-title')
            .textContent({ timeout: 2000 })
            .then(text => (text || '').trim())
            .catch(() => null);
        if (cardTitle === null) continue;

        // Toasts can overlap task cards; trigger click via DOM to avoid pointer interception flakes.
        try {
            await activeCard.evaluate((el: HTMLElement) => el.click(), undefined, { timeout: 2000 });
        } catch {
            continue;
        }
        await chatPage.waitForConnection();

        // If a confirmation is pending, resolve it so it doesn't leak into later tests.
        try {
            if (await chatPage.confirmationDialog.isVisible()) {
                await chatPage.clickConfirmationButton('no');
                await chatPage.confirmationDialog.waitFor({ state: 'hidden', timeout: 15000 });
                await chatPage.waitForAssistantResponse();
                await chatPage.waitForIdle();
            } else if (cardTitle) {
                const toast = page.locator(Selectors.confirmationToast, { hasText: cardTitle }).first();
                if (await toast.isVisible()) {
                    const noBtn = toast.locator('.toast-actions .toast-btn.danger');
                    await noBtn.evaluate((el: HTMLElement) => el.click());
                    await toast.waitFor({ state: 'hidden', timeout: 15000 });
                    // Let the run proceed to completion if it was blocked.
                    await chatPage.waitForAssistantResponse();
                    await chatPage.waitForIdle();
                }
            }
        } catch {
            // ignore
        }

        // If still processing (non-confirmation long runs), stop to speed up cleanup.
        try {
            if (await chatPage.isProcessing()) {
                await chatPage.stopTask();
                await chatPage.waitForIdle();
            }
        } catch {
            // ignore
        }

        try {
            await chatPage.waitForIdle();
        } catch {
            // ignore
        }

        await chatPage.goHome();
        await homePage.waitForConnection();
    }
}
