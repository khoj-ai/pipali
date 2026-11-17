import { describe, expect, test } from 'bun:test';
import { parsePages } from '../../src/client/components/tool-views/ChromePageView';
import { parseSnapshotTree, parseSnapshotUids, resolveUidLabel } from '../../src/client/utils/snapshotParser';

// Output of chrome-devtools-mcp 1.13.0, which the desktop app bundles
describe('Chrome MCP tool results', () => {
    test('a snapshot keeps text that has no role of its own', () => {
        const snapshot = [
            'uid=1_0 RootWebArea "Example Shop" url="https://example.test/cart"',
            '  uid=1_1 heading "Your cart" level="1"',
            '  uid=1_3 paragraph',
            '    uid=1_4 "Two items, total "',
            '    uid=1_5 "$42.00"',
            '  uid=1_7 button "Check out" focusable',
        ].join('\n');

        const tree = parseSnapshotTree(snapshot).map(node => `${node.role} ${node.label}`);

        expect(tree).toEqual([
            'RootWebArea Example Shop',
            'heading Your cart',
            'paragraph ',
            'StaticText Two items, total ',
            'StaticText $42.00',
            'button Check out',
        ]);
        expect(resolveUidLabel('1_5', parseSnapshotUids(snapshot))).toBe('"$42.00" text');
    });

    test('a page list gives each page its URL, with or without a title', () => {
        const { pages } = parsePages([
            '## Pages',
            '1: Example Shop (https://example.test/cart) [selected]',
            '2: about:blank',
            '3: Foo (bar) - Wiki (https://example.test/wiki/Foo_(bar))',
        ].join('\n'));

        expect(pages).toEqual([
            { id: 1, url: 'https://example.test/cart', selected: true },
            { id: 2, url: 'about:blank', selected: false },
            { id: 3, url: 'https://example.test/wiki/Foo_(bar)', selected: false },
        ]);
    });
});
