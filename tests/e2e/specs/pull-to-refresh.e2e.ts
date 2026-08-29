/**
 * Pull to Refresh Tests
 *
 * An installed app on a phone has no browser toolbar to reload from, so the page carries
 * the gesture instead. These drive real touch input through the browser, which is what
 * makes the negative cases meaningful: a pull that should be a scroll has to actually
 * scroll, not merely fail to refresh.
 */

import { test, expect, type Page } from '@playwright/test';
import { AppPage, ChatPage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';

const MARKER = '__pullRefreshMarker';

/** Survives everything except a document load, which is exactly what is being detected. */
async function markDocument(page: Page): Promise<void> {
    await page.evaluate((key) => {
        (window as unknown as Record<string, unknown>)[key] = true;
    }, MARKER);
}

async function documentReloaded(page: Page): Promise<boolean> {
    return !(await page.evaluate((key) => (window as unknown as Record<string, unknown>)[key] === true, MARKER));
}

/** A finger on the screen, left down until it is told to lift. */
async function touchDown(page: Page, x: number, y: number) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });

    return {
        async dragBy(dy: number, steps = 12): Promise<void> {
            for (let step = 1; step <= steps; step++) {
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchMove',
                    touchPoints: [{ x, y: y + (dy * step) / steps }],
                });
            }
        },
        async lift(): Promise<void> {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await cdp.detach();
        },
    };
}

const indicatorOpacity = (page: Page) =>
    page.evaluate((selector) => {
        const el = document.querySelector(selector);
        return el instanceof HTMLElement ? Number(getComputedStyle(el).opacity) : -1;
    }, Selectors.pullRefreshIndicator);

const scrollTop = (page: Page) =>
    page.evaluate((selector) => document.querySelector(selector)?.scrollTop ?? -1, Selectors.mainContent);

test.describe('Pull to refresh', () => {
    // A phone: the gesture is offered to finger-first devices only.
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    // At this width the sidebar is a drawer that would cover the page it is pulled from.
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('pipali-sidebar-open', 'false'));
    });

    test('pulling down from the top of a page reloads the app', async ({ page }) => {
        const app = new AppPage(page);
        await app.goto();

        // The premise of every test here: a finger-first device, where the gesture is offered.
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        await markDocument(page);

        const finger = await touchDown(page, 195, 220);
        await finger.dragBy(200);

        // The indicator has followed the finger out from behind the header.
        expect(await indicatorOpacity(page)).toBeGreaterThan(0.5);

        await finger.lift();

        await page.waitForFunction(
            (key) => (window as unknown as Record<string, unknown>)[key] === undefined,
            MARKER,
            { timeout: 15000 },
        );
        await app.waitForConnection();
    });

    test('a pull that stops short of the trigger leaves the app alone', async ({ page }) => {
        const app = new AppPage(page);
        await app.goto();
        await markDocument(page);

        const finger = await touchDown(page, 195, 220);
        await finger.dragBy(50);
        await finger.lift();

        // Long enough for a reload to have started, and for the indicator to settle back.
        await page.waitForTimeout(1000);
        expect(await documentReloaded(page)).toBe(false);
        expect(await indicatorOpacity(page)).toBe(0);
    });

    test('pulling a scrolled conversation scrolls it instead of refreshing', async ({ page }) => {
        const chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('scroll behavior setup');
        await chatPage.waitForAssistantResponse();
        await chatPage.waitForIdle();

        // Scrolling still belongs to the page: a drag up the screen moves the conversation.
        const scrollUp = await touchDown(page, 195, 500);
        await scrollUp.dragBy(-300);
        await scrollUp.lift();
        await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);

        const startedAt = await scrollTop(page);
        await markDocument(page);

        // Away from the top, the same pull is that scroll run backwards, not a refresh.
        const pull = await touchDown(page, 195, 400);
        await pull.dragBy(200);
        await pull.lift();

        await expect.poll(() => scrollTop(page)).toBeLessThan(startedAt);
        expect(await documentReloaded(page)).toBe(false);
    });

    test('a drag that starts in the composer leaves the app alone', async ({ page }) => {
        const app = new AppPage(page);
        await app.goto();
        await markDocument(page);

        const composer = await app.inputTextarea.boundingBox();
        expect(composer).not.toBeNull();

        const finger = await touchDown(page, composer!.x + composer!.width / 2, composer!.y + composer!.height / 2);
        await finger.dragBy(200);
        await finger.lift();

        await page.waitForTimeout(1000);
        expect(await documentReloaded(page)).toBe(false);
    });
});
