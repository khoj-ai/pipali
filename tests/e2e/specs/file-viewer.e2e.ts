/**
 * File Viewer Tests
 *
 * A file Pipali writes opens beside the chat from its link. HTML renders in a frame that
 * runs nothing; source renders highlighted with a line gutter.
 */

import { test, expect } from '@playwright/test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { ChatPage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';
import { FILE_VIEWER_DIR } from '../fixtures/mock-llm';

// A 3 MB markdown export. Through react-markdown this takes well over the switch timeout below,
// so a viewer that renders it, or renders it once more while switching away, fails the test.
const EXPORT_LINE = '* TODO [#A] Call the bank :finance: see [[https://example.com][the site]] for *this* one\n';
const EXPORT_TEXT = EXPORT_LINE.repeat(Math.ceil(3 * 1024 * 1024 / EXPORT_LINE.length));

test.describe('File viewer', () => {
    let chatPage: ChatPage;

    test.beforeAll(async () => {
        await mkdir(FILE_VIEWER_DIR, { recursive: true });
        await writeFile(`${FILE_VIEWER_DIR}/export.md`, EXPORT_TEXT);
    });

    test.beforeEach(async ({ page }) => {
        chatPage = new ChatPage(page);
        await chatPage.goto();
        await chatPage.sendMessage('open the viewer report');
        await chatPage.waitForAssistantResponse();
    });

    test.afterAll(async () => {
        await rm(`${FILE_VIEWER_DIR}/report.html`, { force: true });
        await rm(`${FILE_VIEWER_DIR}/summarize.ts`, { force: true });
        await rm(`${FILE_VIEWER_DIR}/notes.md`, { force: true });
        await rm(`${FILE_VIEWER_DIR}/export.md`, { force: true });
        await rm(FILE_VIEWER_DIR, { recursive: true, force: true });
    });

    test('shows a generated HTML report beside the chat without running it', async ({ page }) => {
        await page.locator(`${Selectors.assistantMessage} a[href$="report.html"]`).first().click();

        const viewer = page.locator(Selectors.fileViewer);
        await expect(viewer).toBeVisible();
        await expect(viewer.locator(Selectors.fileViewerName)).toHaveText('report.html');
        await expect(viewer.locator(Selectors.fileViewerFrame)).toHaveAttribute('sandbox', 'allow-same-origin');

        const document = page.frameLocator(Selectors.fileViewerFrame);
        await expect(document.locator('#viewer-heading')).toHaveText('Quarterly report');
        // The document's own script would have stamped the body had it run
        await expect(document.locator('body')).not.toHaveAttribute('data-ran', 'yes');

        // The chat stays alongside the document
        await expect(page.locator(Selectors.mainContent)).toBeVisible();
        await expect(page.locator(Selectors.inputTextarea)).toBeVisible();

        await viewer.locator(Selectors.fileViewerClose).click();
        await expect(viewer).toBeHidden();
    });

    test('shows a generated source file highlighted with a line gutter', async ({ page }) => {
        await page.locator(`${Selectors.assistantMessage} a[href$="summarize.ts"]`).first().click();

        const viewer = page.locator(Selectors.fileViewer);
        await expect(viewer.locator(Selectors.fileViewerName)).toHaveText('summarize.ts');
        await expect(viewer.locator(`${Selectors.fileViewerSource} .hljs-keyword`).first()).toBeVisible();
        await expect(viewer.locator(Selectors.fileViewerGutter)).toHaveText(/^1\s+2\s+3$/);
    });

    test('shows markdown frontmatter as yaml rather than a heading', async ({ page }) => {
        await page.locator(`${Selectors.assistantMessage} a[href$="notes.md"]`).first().click();

        const viewer = page.locator(Selectors.fileViewer);
        await expect(viewer.locator(`${Selectors.fileViewerFrontmatter} .hljs-attr`).first()).toHaveText('title:');
        await expect(viewer.locator(`${Selectors.fileViewerMarkdown} h1`)).toHaveText('Agenda');
        await expect(viewer.locator(`${Selectors.fileViewerMarkdown} h2`)).toHaveCount(0);
    });

    test('shows a large markdown file as plain text and switches away from it promptly', async ({ page }) => {
        await page.locator(`${Selectors.assistantMessage} a[href$="export.md"]`).first().click();

        const viewer = page.locator(Selectors.fileViewer);
        await expect(viewer.locator(Selectors.fileViewerName)).toHaveText('export.md');
        await expect(viewer.locator(Selectors.fileViewerGutter)).toBeVisible({ timeout: 10000 });
        await expect(viewer.locator(Selectors.fileViewerMarkdown)).toHaveCount(0);

        await page.locator(`${Selectors.assistantMessage} a[href$="report.html"]`).first().click();
        await expect(page.frameLocator(Selectors.fileViewerFrame).locator('#viewer-heading')).toHaveText('Quarterly report', { timeout: 5000 });
    });
});
