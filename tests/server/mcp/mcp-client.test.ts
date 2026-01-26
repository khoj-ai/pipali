import { describe, expect, test } from 'bun:test';
import { parseStdioCommand, splitCommandLine, isHttpTransport } from '../../../src/server/processor/mcp/client';

describe('MCP Client', () => {
    describe('splitCommandLine', () => {
        const cases = [
            { input: 'foo bar baz', expected: ['foo', 'bar', 'baz'], desc: 'simple space-separated' },
            { input: 'foo --bar "hello world"', expected: ['foo', '--bar', 'hello world'], desc: 'double quotes' },
            { input: "foo --bar 'hello world'", expected: ['foo', '--bar', 'hello world'], desc: 'single quotes' },
            { input: '"first arg" "second arg"', expected: ['first arg', 'second arg'], desc: 'multiple quoted' },
            { input: 'foo\tbar\tbaz', expected: ['foo', 'bar', 'baz'], desc: 'tabs as separators' },
            { input: 'foo    bar', expected: ['foo', 'bar'], desc: 'multiple spaces' },
            { input: '', expected: [], desc: 'empty input' },
            { input: '   ', expected: [], desc: 'only spaces' },
        ];

        for (const { input, expected, desc } of cases) {
            test(desc, () => expect(splitCommandLine(input)).toEqual(expected));
        }
    });

    describe('isHttpTransport', () => {
        const httpPaths = ['http://localhost:8080', 'https://api.example.com/mcp'];
        const stdioPaths = ['@modelcontextprotocol/server-github', '/path/to/server.py', 'my-mcp-package'];

        for (const path of httpPaths) {
            test(`${path} -> true`, () => expect(isHttpTransport(path)).toBe(true));
        }
        for (const path of stdioPaths) {
            test(`${path} -> false`, () => expect(isHttpTransport(path)).toBe(false));
        }
    });

    describe('parseStdioCommand', () => {
        const cases: Array<{ path: string; command: string; args: string[]; desc: string }> = [
            // NPM packages -> bun x (not bunx, since desktop app bundles bun but not bunx)
            { path: '@modelcontextprotocol/server-github', command: 'bun', args: ['x', '-y', '@modelcontextprotocol/server-github'], desc: 'scoped npm package' },
            { path: 'mcp-server-sqlite', command: 'bun', args: ['x', '-y', 'mcp-server-sqlite'], desc: 'simple npm package' },
            { path: '@example/mcp-server@1.0.0', command: 'bun', args: ['x', '-y', '@example/mcp-server@1.0.0'], desc: 'npm with version' },
            { path: 'chrome-devtools-mcp@latest --autoConnect', command: 'bun', args: ['x', '-y', 'chrome-devtools-mcp@latest', '--autoConnect'], desc: 'npm with args' },
            { path: '  mcp-server-sqlite  ', command: 'bun', args: ['x', '-y', 'mcp-server-sqlite'], desc: 'trims whitespace' },

            // Python -> python
            { path: '/path/to/server.py', command: 'python', args: ['/path/to/server.py'], desc: 'python absolute' },
            { path: './scripts/mcp-server.py', command: 'python', args: ['./scripts/mcp-server.py'], desc: 'python relative' },

            // JS/TS/MJS -> bun run
            { path: '/path/to/server.js', command: 'bun', args: ['run', '/path/to/server.js'], desc: '.js file' },
            { path: '/path/to/server.mjs', command: 'bun', args: ['run', '/path/to/server.mjs'], desc: '.mjs file' },
            { path: '/path/to/server.ts', command: 'bun', args: ['run', '/path/to/server.ts'], desc: '.ts file' },
            { path: './server.ts --debug', command: 'bun', args: ['run', './server.ts', '--debug'], desc: 'script with args' },

            // Executables -> direct
            { path: '/usr/local/bin/mcp-server', command: '/usr/local/bin/mcp-server', args: [], desc: 'executable absolute' },
            { path: './bin/mcp-server', command: './bin/mcp-server', args: [], desc: 'executable relative' },
            { path: '/usr/local/bin/mcp-server --port 3000', command: '/usr/local/bin/mcp-server', args: ['--port', '3000'], desc: 'executable with args' },
        ];

        for (const { path, command, args, desc } of cases) {
            test(desc, () => {
                const result = parseStdioCommand(path);
                expect(result.command).toBe(command);
                expect(result.args).toEqual(args);
            });
        }
    });
});
