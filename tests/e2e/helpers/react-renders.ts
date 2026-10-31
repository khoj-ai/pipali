/**
 * Records which components React rendered, read from its own commits through the hook
 * React DevTools uses. Render counts are deterministic where timings are not, so a spec
 * can assert what an interaction redraws however fast the machine running it is.
 */

import type { Page } from '@playwright/test';

export interface Renders {
    counts: Record<string, number>;
    messageIds: string[];
    thoughtIds: string[];
}

export async function trackRenders(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const log: Renders = { counts: {}, messageIds: [], thoughtIds: [] };
        (window as any).__renders = log;

        // The bundler suffixes a function named after the memo() binding holding it, so
        // `const ThoughtItem = memo(function ThoughtItem...)` arrives as ThoughtItem2
        const nameOf = (fiber: any): string | undefined => {
            const type = fiber.type;
            const name: string | undefined = typeof type === 'function'
                ? type.displayName || type.name
                : type?.render?.name ?? type?.type?.name;
            return name?.replace(/\d+$/, '');
        };

        const record = (fiber: any) => {
            const name = nameOf(fiber);
            if (!name) return;
            log.counts[name] = (log.counts[name] ?? 0) + 1;
            if (name === 'MessageItem') log.messageIds.push(fiber.memoizedProps.message.stableId);
            if (name === 'ThoughtItem') log.thoughtIds.push(fiber.memoizedProps.thought.id);
        };

        // React leaves a fiber's flags stale when it skips the subtree, so only descend
        // where the children were rebuilt. PerformedWork (1) marks a fiber that rendered.
        const visit = (fiber: any) => {
            for (let child = fiber.child; child; child = child.sibling) {
                const previous = child.alternate;
                if (!previous || child.flags & 1) record(child);
                if (!previous || child.child !== previous.child) visit(child);
            }
        };

        (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true,
            inject: () => 1,
            checkDCE: () => {},
            onCommitFiberRoot: (_id: number, root: any) => visit(root.current),
            onCommitFiberUnmount: () => {},
            onPostCommitFiberRoot: () => {},
        };
    });
}

export async function resetRenders(page: Page): Promise<void> {
    await page.evaluate(() => {
        const log = (window as any).__renders as Renders;
        log.counts = {};
        log.messageIds = [];
        log.thoughtIds = [];
    });
}

export async function readRenders(page: Page): Promise<Renders> {
    return page.evaluate(() => (window as any).__renders as Renders);
}
