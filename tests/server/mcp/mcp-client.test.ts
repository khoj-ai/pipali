import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpClient, parseStdioCommand, splitCommandLine, isHttpTransport, resolveVendoredBin } from '../../../src/server/processor/mcp/client';

const httpOAuthServer = {
    id: 7,
    name: 'oauth-server',
    description: null,
    transportType: 'http' as const,
    path: 'https://mcp.example.com/mcp',
    apiKey: null,
    authType: 'oauth' as const,
    oauthStatus: 'connected' as const,
    oauthClientId: null,
    oauthClientSecret: null,
    oauthScopes: null,
    env: null,
    confirmationMode: 'always' as const,
    enabled: true,
    lastConnectedAt: null,
    lastError: null,
    enabledTools: null,
    createdAt: new Date(),
    updatedAt: new Date(),
};

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

    describe('resolveVendoredBin', () => {
        let serverDir: string;

        beforeAll(async () => {
            serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipali-vendored-'));
            for (const name of ['chrome-devtools-mcp', '@scope/server']) {
                const dir = path.join(serverDir, 'node_modules', name);
                await fs.mkdir(dir, { recursive: true });
                await Bun.write(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', bin: { [name]: './bin.js' } }));
            }
        });

        afterAll(() => fs.rm(serverDir, { recursive: true, force: true }));

        const cases: Array<{ spec: string; vendored: string | null; desc: string }> = [
            { spec: 'chrome-devtools-mcp', vendored: 'chrome-devtools-mcp', desc: 'no selector' },
            { spec: 'chrome-devtools-mcp@1.2.3', vendored: 'chrome-devtools-mcp', desc: 'the vendored version' },
            { spec: '@scope/server', vendored: '@scope/server', desc: 'scoped, no selector' },
            { spec: 'chrome-devtools-mcp@latest', vendored: null, desc: 'a tag' },
            { spec: 'chrome-devtools-mcp@1.2.4', vendored: null, desc: 'another version' },
            { spec: 'chrome-devtools-mcp@^1.0.0', vendored: null, desc: 'a range the vendored version satisfies' },
            { spec: '@scope/server@latest', vendored: null, desc: 'scoped, a tag' },
        ];

        for (const { spec, vendored, desc } of cases) {
            test(`${desc}: ${spec} -> ${vendored ? 'vendored' : 'bun x'}`, async () => {
                const result = await resolveVendoredBin(['x', '-y', spec, '--autoConnect'], serverDir);
                expect(result).toEqual(vendored ? {
                    binPath: path.join(serverDir, 'node_modules', vendored, 'bin.js'),
                    extraArgs: ['--autoConnect'],
                } : null);
            });
        }
    });

    describe('stdio server stderr', () => {
        const fixture = fileURLToPath(new URL('../../fixtures/mcp-stderr-server.ts', import.meta.url));
        const stderrServer = (mode: string) => new McpClient({
            ...httpOAuthServer,
            name: 'stderr-server',
            transportType: 'stdio',
            authType: 'none',
            path: `"${process.execPath}" "${fixture}" ${mode}`,
        });

        test('reports what a server wrote to stderr before it exited while starting', async () => {
            const client = stderrServer('refuse');

            await expect(client.connect()).rejects.toThrow(/Connection closed\nServer output:\nerror: EXAMPLE_API_KEY is not set/);
        });

        test('reports what a server wrote to stderr before it exited during a tool call', async () => {
            const client = stderrServer('serve');
            await client.connect();

            const result = await client.runTool('crash', {});
            await client.close();

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/Connection closed\nServer output:\nfatal: out of memory/);
        });
    });

    describe('runTool', () => {
        test('flags UnauthorizedError tool calls as auth-required', async () => {
            const client = new McpClient(httpOAuthServer);

            (client as any).client = {
                async callTool() {
                    const error = new Error('Unauthorized');
                    error.name = 'UnauthorizedError';
                    throw error;
                },
            };

            const result = await client.runTool('list_items', {});

            expect(result.success).toBe(false);
            expect(result.authRequired).toBe(true);
            expect(result.error).toContain('OAuth authorization is required');
        });

        // These exercise the real reconnect()/retry logic in McpClient. Only the
        // network seam — connect(), which would open a real socket — is stubbed;
        // the teardown, single-retry, and concurrent-reconnect coalescing all run.
        const sessionError = () => Object.assign(
            new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":{"code":-32000,"message":"No transport found for sessionId"}}'),
            { code: 404 }
        );

        test('reconnects and retries once on an expired Streamable HTTP session', async () => {
            const client = new McpClient(httpOAuthServer);
            let calls = 0;

            // Server forgets the session: first call 404s. A real reconnect()
            // re-initializes (here, our connect() stub swaps in a healthy session).
            (client as any).client = {
                async callTool() {
                    calls++;
                    throw sessionError();
                },
            };
            let connects = 0;
            (client as any).connect = async () => {
                connects++;
                (client as any)._status = 'connected';
                (client as any).client = {
                    async callTool() {
                        calls++;
                        return { content: [{ type: 'text', text: 'ok' }] };
                    },
                };
            };

            const result = await client.runTool('list_items', {});

            expect(connects).toBe(1);   // real reconnect() ran exactly one connect
            expect(calls).toBe(2);      // failed once, retried once after reconnect
            expect(result.success).toBe(true);
            expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
        });

        test('does not loop when the session error persists after reconnect', async () => {
            const client = new McpClient(httpOAuthServer);
            let calls = 0;

            // Every call keeps 404-ing even after reconnect (connect re-establishes
            // a session that's still broken). Must retry once, then give up.
            const failingClient = {
                async callTool() {
                    calls++;
                    throw sessionError();
                },
            };
            let connects = 0;
            (client as any).client = failingClient;
            (client as any).connect = async () => {
                connects++;
                (client as any)._status = 'connected';
                (client as any).client = failingClient; // real connect() always sets this.client
            };

            const result = await client.runTool('list_items', {});

            expect(connects).toBe(1); // reconnect attempted exactly once, no loop
            expect(calls).toBe(2);    // original attempt + single retry
            expect(result.success).toBe(false);
            expect(result.error).toContain('No transport found for sessionId');
        });

        test('coalesces concurrent reconnects into a single handshake', async () => {
            const client = new McpClient(httpOAuthServer);
            let healthy = false;

            const sessionClient = {
                async callTool() {
                    if (!healthy) throw sessionError();
                    return { content: [{ type: 'text', text: 'ok' }] };
                },
            };
            let connects = 0;
            (client as any).client = sessionClient;
            (client as any).connect = async () => {
                connects++;
                // Yield so the second in-flight call reaches reconnect() while this
                // handshake is still pending — exercising the coalescing guard.
                await Promise.resolve();
                healthy = true;
                (client as any)._status = 'connected';
                (client as any).client = sessionClient; // real connect() always sets this.client
            };

            const [a, b] = await Promise.all([
                client.runTool('list_items', {}),
                client.runTool('list_items', {}),
            ]);

            expect(connects).toBe(1); // both expired calls shared one reconnect
            expect(a.success).toBe(true);
            expect(b.success).toBe(true);
        });

        test('leaves non-session errors untouched (no reconnect)', async () => {
            const client = new McpClient(httpOAuthServer);
            let connects = 0;
            (client as any).connect = async () => { connects++; };
            (client as any).client = {
                async callTool() {
                    throw new Error('Tool blew up for an unrelated reason');
                },
            };

            const result = await client.runTool('list_items', {});

            expect(connects).toBe(0); // a generic failure must not trigger reconnect
            expect(result.success).toBe(false);
            expect(result.error).toContain('Tool blew up for an unrelated reason');
        });
    });
});
