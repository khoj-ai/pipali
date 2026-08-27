import { test, expect, describe } from 'bun:test';
import { isShellFindCommand, extractFindPath } from '../../src/server/processor/director/index';

describe('isShellFindCommand', () => {
    test('detects find as standalone command or after chain operators', () => {
        expect(isShellFindCommand('find . -name "*.ts"')).toBe(true);
        expect(isShellFindCommand('cd /tmp && find . -type f')).toBe(true);
        expect(isShellFindCommand('echo test | find . -name "*.ts"')).toBe(true);
        expect(isShellFindCommand('cd /tmp; find . -name "*.log"')).toBe(true);
    });

    test('does not match find as substring in other words or quoted strings', () => {
        expect(isShellFindCommand('findutils --version')).toBe(false);
        expect(isShellFindCommand('grep -r "find" .')).toBe(false);
        expect(isShellFindCommand('mdfind -name test')).toBe(false);
    });

    test('ignores heredoc bodies, which are interpreter payloads not shell syntax', () => {
        expect(isShellFindCommand("python3 << 'EOF'\n# parse the payload; find target_query\nEOF")).toBe(false);
        expect(isShellFindCommand('cat <<EOF\nrun this; find ~ -name "*.md"\nEOF')).toBe(false);
        // A real find still wins when it precedes the heredoc
        expect(isShellFindCommand("find ~ -type f && python3 << 'EOF'\npass\nEOF")).toBe(true);
    });
});

describe('extractFindPath', () => {
    test('extracts path from simple find commands', () => {
        expect(extractFindPath('find ~ -name "*.ts"')).toBe('~');
        expect(extractFindPath('find ~/Documents -type f')).toBe('~/Documents');
        expect(extractFindPath('find /tmp -name "*.log"')).toBe('/tmp');
        expect(extractFindPath('find . -name "*.ts"')).toBe('.');
    });

    test('extracts path from chained find commands', () => {
        expect(extractFindPath('cd /tmp && find ~/Code -type f')).toBe('~/Code');
    });

    test('returns undefined when find has no path (only options)', () => {
        expect(extractFindPath('find -name "*.ts"')).toBeUndefined();
    });

    test('returns undefined for non-find commands', () => {
        expect(extractFindPath('ls -la')).toBeUndefined();
    });

    test('returns undefined for find-like text inside a heredoc body', () => {
        expect(extractFindPath("python3 << 'EOF'\n# parse the payload; find target_query\nEOF")).toBeUndefined();
    });
});
