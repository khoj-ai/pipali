import { test, expect, describe } from 'bun:test';
import {
    selectDelegatedModelAlias,
    summarizeToolCall,
} from '../../src/server/processor/actor/delegate_task';

/**
 * inspect_task shows what a delegated task did, so it summarizes each tool call
 * down to one identifying argument. Payload-shaped arguments must never reach it - a file
 * written by the child would otherwise be copied wholesale into the parent's context.
 */
describe('summarizeToolCall', () => {
    test('identifies a write by file path, never its content', () => {
        const summary = summarizeToolCall('write_file', {
            file_path: '/tmp/pipali/report.md',
            content: 'SECRET_PAYLOAD '.repeat(500),
        });

        expect(summary).toBe('write_file(/tmp/pipali/report.md)');
        expect(summary).not.toContain('SECRET_PAYLOAD');
    });

    test('identifies a shell call by justification, never the command body', () => {
        const summary = summarizeToolCall('shell_command', {
            justification: 'Count the TypeScript files',
            command: 'cat <<EOF > /tmp/script.sh\n' + 'echo LONG_SCRIPT_BODY\n'.repeat(200) + 'EOF',
        });

        expect(summary).toBe('shell_command(Count the TypeScript files)');
        expect(summary).not.toContain('LONG_SCRIPT_BODY');
    });

    test('degrades unknown and MCP tools to name only', () => {
        // MCP argument shapes are unbounded and unknowable, so nothing is echoed.
        expect(summarizeToolCall('github__create_issue', {
            title: 'Bug report',
            body: 'HUGE_BODY '.repeat(500),
        })).toBe('github__create_issue');

        expect(summarizeToolCall('some_future_tool', { payload: 'x'.repeat(5000) }))
            .toBe('some_future_tool');
    });

    test('truncates an identifying argument that is itself long', () => {
        const summary = summarizeToolCall('search_web', { query: 'q'.repeat(1000) });

        expect(summary.length).toBeLessThan(300);
        expect(summary).toContain('…');
    });

    test('falls back to the name when the identifying argument is missing or blank', () => {
        expect(summarizeToolCall('grep_files', {})).toBe('grep_files');
        expect(summarizeToolCall('grep_files', { pattern: '   ' })).toBe('grep_files');
    });
});

describe('selectDelegatedModelAlias', () => {
    test('uses the tier explicitly selected by the parent model', () => {
        expect(selectDelegatedModelAlias('lite', 'flagship')).toBe('pipali:lite');
    });

    test('defaults to the current conversation model tier', () => {
        expect(selectDelegatedModelAlias(undefined, 'balanced')).toBe('pipali:balanced');
    });

    test('leaves models without a tier unaliased', () => {
        expect(selectDelegatedModelAlias(undefined, null)).toBeUndefined();
    });
});
