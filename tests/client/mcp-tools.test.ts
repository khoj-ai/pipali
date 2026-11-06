import { test, expect, describe } from 'bun:test';
import { countEnabledTools, isToolEnabled, selectOnly, toggleTool } from '../../src/client/utils/mcp-tools';

const tools = ['read', 'write', 'delete'];
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('MCP tool enablement', () => {
    test('an empty whitelist enables every tool', () => {
        const all = new Set<string>();
        expect(tools.every(t => isToolEnabled(all, t))).toBe(true);
        expect(countEnabledTools(all, tools)).toBe(3);
    });

    test('disabling one tool from the all-enabled state keeps the others enabled', () => {
        const next = toggleTool(new Set(), tools, 'delete');
        expect(sorted(next)).toEqual(['read', 'write']);
        expect(isToolEnabled(next, 'delete')).toBe(false);
    });

    test('re-enabling the last disabled tool returns to the empty whitelist', () => {
        const down = toggleTool(new Set(), tools, 'delete');
        expect(toggleTool(down, tools, 'delete').size).toBe(0);
    });

    test('enabling one tool in a partial whitelist adds only that tool', () => {
        const next = toggleTool(new Set(['read']), tools, 'write');
        expect(sorted(next)).toEqual(['read', 'write']);
    });

    test('the last enabled tool cannot be disabled', () => {
        expect(sorted(toggleTool(new Set(['read']), tools, 'read'))).toEqual(['read']);
        expect(toggleTool(new Set(), ['read'], 'read').size).toBe(0);
    });

    test('selecting one tool narrows from all enabled, and further tools are added by toggling', () => {
        const only = selectOnly(tools, 'read');
        expect(sorted(only)).toEqual(['read']);
        expect(isToolEnabled(only, 'write')).toBe(false);

        const two = toggleTool(only, tools, 'write');
        expect(sorted(two)).toEqual(['read', 'write']);
        expect(toggleTool(two, tools, 'delete').size).toBe(0);
    });

    test('the tool left by selecting only it cannot be disabled', () => {
        const only = selectOnly(tools, 'delete');
        expect(sorted(toggleTool(only, tools, 'delete'))).toEqual(['delete']);
    });

    test('selecting the only tool of a server returns the empty whitelist', () => {
        expect(selectOnly(['read'], 'read').size).toBe(0);
    });

    test('tools missing from the server are dropped from a toggled whitelist and not counted', () => {
        const stale = new Set(['read', 'removed-upstream']);
        expect(countEnabledTools(stale, tools)).toBe(1);
        expect(sorted(toggleTool(stale, tools, 'write'))).toEqual(['read', 'write']);
    });
});
