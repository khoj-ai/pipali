import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpServerConfig, McpToolInfo, McpToolCallResult, McpClientStatus, McpContentType } from './types';
import { DbMcpOAuthProvider } from './oauth-provider';
import os from 'os';
import path from 'path';
import { createChildLogger } from '../../logger';
import { getBundledRuntimes } from '../../bundled-runtimes';

const log = createChildLogger({ component: 'mcp' });

/**
 * Build the environment for stdio MCP servers.
 *
 * We always enable NODE_USE_SYSTEM_CA for MCP child processes so package
 * downloads and HTTPS requests use the OS trust store on user machines.
 * Per-server env config can still override this default if needed.
 */
export function buildStdioEnvironment(
    defaultEnv: Record<string, string>,
    options: {
        homeDir?: string;
        shellPath?: string;
        configEnv?: Record<string, string> | null;
    } = {}
): Record<string, string> {
    return {
        ...defaultEnv,
        HOME: options.homeDir ?? getHomeDir(),
        NODE_USE_SYSTEM_CA: '1',
        ...(options.shellPath ? { PATH: options.shellPath } : {}),
        ...options.configEnv,
    };
}

/**
 * Split a command line string into parts, respecting quoted strings.
 * E.g., 'foo --bar "hello world"' => ['foo', '--bar', 'hello world']
 */
export function splitCommandLine(input: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuote: string | null = null;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (inQuote) {
            if (char === inQuote) {
                inQuote = null;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            inQuote = char;
        } else if (char === ' ' || char === '\t') {
            if (current) {
                result.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    if (current) {
        result.push(current);
    }

    return result;
}

/**
 * Parse an MCP server path into command and args for stdio transport.
 * Supports commands with arguments, e.g., "chrome-devtools-mcp@latest --autoConnect --channel=beta"
 */
export function parseStdioCommand(path: string): { command: string; args: string[] } {
    path = path.trim();

    // Split path into parts, respecting quoted strings
    const parts = splitCommandLine(path);
    const [firstPart, ...extraArgs] = parts;

    if (!firstPart) {
        return { command: path, args: [] };
    }

    // npm package (starts with @ or has no path separator in the first part)
    // Use 'bun x' instead of 'bunx' since desktop app bundles 'bun' but not 'bunx'
    if (firstPart.startsWith('@') || !firstPart.includes('/')) {
        return { command: 'bun', args: ['x', '-y', firstPart, ...extraArgs] };
    }

    // Python script
    if (firstPart.endsWith('.py')) {
        return { command: 'python', args: [firstPart, ...extraArgs] };
    }

    // JavaScript script
    if (firstPart.endsWith('.js') || firstPart.endsWith('.ts') || firstPart.endsWith('.mjs')) {
        return { command: 'bun', args: ['run', firstPart, ...extraArgs] };
    }

    // Default: treat first part as executable, rest as args
    return { command: firstPart, args: extraArgs };
}

/**
 * Check if a path represents an HTTP transport (vs stdio).
 */
export function isHttpTransport(path: string): boolean {
    return path.startsWith('http://') || path.startsWith('https://');
}

export function isMcpOAuthUnauthorizedError(error: unknown): boolean {
    return error instanceof UnauthorizedError
        || (error instanceof Error && error.name === 'UnauthorizedError');
}

/**
 * Detect a dropped Streamable HTTP session: the server no longer recognizes the
 * `mcp-session-id` we replay (idle eviction, server restart, or a load-balanced
 * instance that never held it). Per the MCP spec a server returns HTTP 404 for a
 * request bearing an unknown/terminated session id; implementations word the body
 * differently, so we also match the common phrasings. The fix is to re-initialize
 * a fresh session and retry, not to reuse the dead id.
 */
export function isMcpSessionExpiredError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    const codes = [(error as { code?: unknown }).code, (error.cause as { code?: unknown } | undefined)?.code];
    if (codes.includes(404)) {
        return true;
    }
    const cause = error.cause instanceof Error ? error.cause.message : '';
    return /no transport found for session|session (?:not found|expired|has expired)|invalid session id/i.test(
        `${error.message} ${cause}`
    );
}

/**
 * Split an npm package spec into its name and selector,
 * e.g. "@scope/pkg@^1.2" into "@scope/pkg" and "^1.2".
 */
function parsePackageSpec(spec: string): { name: string; selector?: string } {
    const at = spec.indexOf('@', 1); // a leading @ opens a scope
    return at === -1 ? { name: spec } : { name: spec.slice(0, at), selector: spec.slice(at + 1) };
}

/**
 * Resolve a `bun x <package>` call to a vendored binary in the server resource
 * node_modules. Returns null if the package isn't vendored, or if the call asks
 * for a version, range or tag other than the vendored version, which is left
 * for `bun x` to resolve.
 */
export async function resolveVendoredBin(
    args: string[],
    serverDir = process.env.PIPALI_SERVER_RESOURCE_DIR
): Promise<{ binPath: string; extraArgs: string[] } | null> {
    // Only handle `bun x -y <package> [args...]` patterns
    if (args[0] !== 'x') return null;

    // Find the package name (skip flags like -y)
    let pkgIndex = 1;
    while (pkgIndex < args.length && args[pkgIndex]!.startsWith('-')) pkgIndex++;
    if (pkgIndex >= args.length) return null;

    const { name: pkgName, selector } = parsePackageSpec(args[pkgIndex]!);
    const extraArgs = args.slice(pkgIndex + 1);

    if (!serverDir) return null;

    // Check if the package is vendored by looking for its package.json
    const pkgJsonPath = path.join(serverDir, 'node_modules', pkgName, 'package.json');
    try {
        const pkgJson = JSON.parse(await Bun.file(pkgJsonPath).text());
        if (selector !== undefined && selector !== pkgJson.version) return null;
        // Resolve the bin entry — use the package name key or the first bin entry
        const bin = pkgJson.bin;
        let binRelPath: string | undefined;
        if (typeof bin === 'string') {
            binRelPath = bin;
        } else if (bin && typeof bin === 'object') {
            binRelPath = bin[pkgName] ?? Object.values(bin)[0] as string;
        }
        if (!binRelPath) return null;

        const binPath = path.join(serverDir, 'node_modules', pkgName, binRelPath);
        return { binPath, extraArgs };
    } catch {
        return null;
    }
}

// Cache the shell PATH to avoid repeated shell invocations
let cachedShellPath: string | null = null;

/** Get the user's home directory reliably (even when HOME env var is empty/unset in desktop apps) */
function getHomeDir(): string {
    if (process.env.HOME && process.env.HOME.length > 0) {
        return process.env.HOME;
    }
    return os.homedir();
}

/**
 * Get the PATH from the user's login shell.
 * Desktop apps launched from Finder don't inherit the full PATH that includes tools like bunx.
 * This queries the login shell to get the complete PATH.
 */
async function getShellPath(): Promise<string | undefined> {
    if (cachedShellPath !== null) {
        return cachedShellPath || undefined;
    }

    if (process.platform === 'win32') {
        try {
            const proc = Bun.spawn({
                cmd: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'echo $env:PATH'],
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
                timeout: 5000,
            });
            if (await proc.exited === 0) {
                const path = (await new Response(proc.stdout).text()).trim();
                if (path) {
                    cachedShellPath = path;
                    return path;
                }
            }
        } catch { /* fall through */ }
        cachedShellPath = '';
        return undefined;
    }

    // macOS/Linux: use login shell to get PATH with user's profile sourced
    // HOME must be set correctly for shell profiles (~/.zshrc, ~/.zprofile) to work
    const home = getHomeDir();
    const userShell = process.env.SHELL || '/bin/zsh';

    try {
        const proc = Bun.spawn({
            cmd: [userShell, '-lc', 'echo $PATH'],
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 5000,
            env: { ...process.env, HOME: home, USER: process.env.USER || os.userInfo().username },
        });

        if (await proc.exited === 0) {
            const path = (await new Response(proc.stdout).text()).trim();
            if (path) {
                cachedShellPath = path;
                log.debug({ path: path.substring(0, 100) + '...' }, 'Resolved shell PATH');
                return path;
            }
        }
    } catch (error) {
        log.warn({ err: error }, 'Failed to get shell PATH');
    }

    cachedShellPath = '';
    return undefined;
}

/**
 * MCP Client for connecting to and interacting with MCP servers.
 * Supports both stdio (local scripts/npm packages) and HTTP (remote servers) transports.
 */
export class McpClient {
    private config: McpServerConfig;
    private options: { oauthInteractive?: boolean; callbackOrigin?: string };
    private client: Client | null = null;
    private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
    private tools: McpToolInfo[] = [];
    private _status: McpClientStatus = 'disconnected';
    private reconnecting: Promise<void> | null = null;

    constructor(config: McpServerConfig, options: { oauthInteractive?: boolean; callbackOrigin?: string } = {}) {
        this.config = config;
        this.options = options;
    }

    get status(): McpClientStatus {
        return this._status;
    }

    get serverName(): string {
        return this.config.name;
    }

    get serverDescription(): string | null {
        return this.config.description ?? null;
    }

    get confirmationMode(): 'always' | 'unsafe_only' | 'never' {
        return this.config.confirmationMode;
    }

    get enabledTools(): string[] | null {
        return this.config.enabledTools ?? null;
    }

    /**
     * Connect to the MCP server.
     * Automatically detects transport type based on the path.
     */
    async connect(): Promise<void> {
        if (this._status === 'connected' || this._status === 'connecting') {
            return;
        }

        this._status = 'connecting';

        try {
            // Create the client
            this.client = new Client(
                { name: 'pipali', version: '1.0.0' },
                { capabilities: {} }
            );

            // Determine transport type and connect
            if (isHttpTransport(this.config.path)) {
                await this.connectHttp();
            } else {
                await this.connectStdio();
            }

            this._status = 'connected';

            // Cache available tools
            await this.refreshTools();
        } catch (error) {
            this._status = 'error';
            throw error;
        }
    }

    /**
     * Connect using stdio transport (for local scripts or npm packages)
     */
    private async connectStdio(): Promise<void> {
        let { command, args } = parseStdioCommand(this.config.path);

        // Use bundled bun if available (desktop app)
        const runtimes = await getBundledRuntimes();
        if (command === 'bun' && runtimes.isBundled) {
            command = runtimes.bun;
            // Resolve vendored npm packages instead of downloading via `bun x`
            const vendoredBin = await resolveVendoredBin(args);
            if (vendoredBin) {
                args = ['run', vendoredBin.binPath, ...vendoredBin.extraArgs];
            }
        }

        // Build environment with user-specified overrides
        // Use shell PATH to ensure tools are found (important for desktop apps)
        const defaultEnv = getDefaultEnvironment();
        const shellPath = await getShellPath();
        const env = buildStdioEnvironment(defaultEnv, {
            homeDir: getHomeDir(),
            shellPath,
            configEnv: this.config.env,
        });

        this.transport = new StdioClientTransport({
            command,
            args,
            env,
            stderr: 'inherit',
        });

        await this.client!.connect(this.transport);
    }

    /**
     * Connect using HTTP transport (for remote servers)
     */
    private async connectHttp(): Promise<void> {
        const url = new URL(this.config.path);
        const authType = this.config.authType ?? (this.config.apiKey ? 'bearer' : 'none');

        if (authType === 'oauth') {
            this.transport = new StreamableHTTPClientTransport(url, {
                authProvider: new DbMcpOAuthProvider(this.config, {
                    interactive: this.options.oauthInteractive,
                    callbackOrigin: this.options.callbackOrigin,
                }),
            });
            await this.client!.connect(this.transport);
            return;
        }

        const requestInit: RequestInit = {};
        if (authType === 'bearer' && this.config.apiKey) {
            requestInit.headers = {
                'Authorization': `Bearer ${this.config.apiKey}`,
            };
        }

        this.transport = new StreamableHTTPClientTransport(url, {
            requestInit,
        });

        await this.client!.connect(this.transport);
    }

    /**
     * Refresh the list of available tools from the server
     */
    private async refreshTools(): Promise<void> {
        if (!this.client) {
            throw new Error('Client not connected');
        }

        const response = await this.client.listTools();
        this.tools = response.tools.map(tool => ({
            originalName: tool.name,
            namespacedName: `${this.config.name}__${tool.name}`,
            serverName: this.config.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema as Record<string, unknown>,
        }));

        // Append synthetic tools that extend this server's capabilities
        this.tools.push(...buildSyntheticTools(this.config.name, this.tools));
    }

    /**
     * Get all tools from this server
     */
    async getTools(): Promise<McpToolInfo[]> {
        if (this._status !== 'connected') {
            await this.connect();
        }
        return this.tools;
    }

    /**
     * Execute a tool by its original (non-namespaced) name.
     * Recovers transparently from a dropped Streamable HTTP session by
     * re-initializing once and retrying. See {@link isMcpSessionExpiredError}.
     */
    async runTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
        if (!this.client) {
            throw new Error('Client not connected');
        }
        return this.runToolAttempt(toolName, args, true);
    }

    private async runToolAttempt(
        toolName: string,
        args: Record<string, unknown>,
        allowReconnect: boolean
    ): Promise<McpToolCallResult> {
        try {
            const result = await this.client!.callTool({
                name: toolName,
                arguments: args,
            });
            return this.processToolResult(result);
        } catch (error) {
            if (isMcpOAuthUnauthorizedError(error)) {
                await this.close();
                return this.authRequiredResult();
            }

            // The server forgot our Streamable HTTP session. Re-initialize a fresh
            // session once (OAuth tokens are persisted, so this is transparent) and
            // retry — reusing the dead session id would just 404 again.
            if (allowReconnect && isHttpTransport(this.config.path) && isMcpSessionExpiredError(error)) {
                log.info({ tool: toolName, server: this.config.name }, 'MCP Streamable HTTP session expired; reconnecting and retrying');
                try {
                    await this.reconnect();
                } catch (reconnectError) {
                    if (isMcpOAuthUnauthorizedError(reconnectError)) {
                        await this.close();
                        return this.authRequiredResult();
                    }
                    // Reconnect failed for another reason — report the original failure.
                    return this.formatToolError(error, toolName);
                }
                return this.runToolAttempt(toolName, args, false);
            }

            return this.formatToolError(error, toolName);
        }
    }

    private processToolResult(result: Awaited<ReturnType<Client['callTool']>>): McpToolCallResult {
        // Process content based on type
        const content: McpContentType[] = [];

        if ('content' in result && Array.isArray(result.content)) {
            for (const item of result.content) {
                if (item.type === 'text') {
                    content.push({ type: 'text', text: item.text });
                } else if (item.type === 'image') {
                    content.push({
                        type: 'image',
                        data: item.data,
                        mimeType: item.mimeType,
                    });
                } else if (item.type === 'audio') {
                    content.push({
                        type: 'audio',
                        data: item.data,
                        mimeType: item.mimeType,
                    });
                }
            }
        }

        const isError = 'isError' in result && result.isError;

        // Extract error message from content if this is an error response
        let errorMessage: string | undefined;
        if (isError && content.length > 0) {
            const textContent = content.filter(item => item.type === 'text');
            if (textContent.length > 0) {
                errorMessage = textContent.map(item => (item as { type: 'text'; text: string }).text).join('\n');
            }
        }

        return {
            success: !isError,
            content,
            error: errorMessage,
        };
    }

    private formatToolError(error: unknown, toolName: string): McpToolCallResult {
        let errorMsg = error instanceof Error ? error.message : String(error);
        // Preserve the cause chain (e.g., puppeteer wraps the real error in a generic message)
        if (error instanceof Error && error.cause) {
            const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
            errorMsg += `\nCause: ${cause}`;
        }
        log.error({ err: error, tool: toolName, server: this.config.name }, 'MCP tool execution failed');
        return {
            success: false,
            content: [],
            error: errorMsg,
        };
    }

    private authRequiredResult(): McpToolCallResult {
        return {
            success: false,
            content: [],
            error: 'OAuth authorization is required. Reconnect this MCP server from the Tools page.',
            authRequired: true,
        };
    }

    /**
     * Tear down the current transport and establish a fresh connection (and
     * Streamable HTTP session). Concurrent callers share a single handshake so
     * parallel tool calls hitting the same expired session don't race.
     */
    private async reconnect(): Promise<void> {
        if (!this.reconnecting) {
            this.reconnecting = (async () => {
                try {
                    if (this.transport) {
                        try {
                            await this.transport.close();
                        } catch {
                            // Transport may already be gone; proceed to reconnect.
                        }
                    }
                    this.client = null;
                    this.transport = null;
                    this._status = 'disconnected';
                    await this.connect();
                } finally {
                    this.reconnecting = null;
                }
            })();
        }
        return this.reconnecting;
    }

    /**
     * Close the connection to the MCP server
     */
    async close(): Promise<void> {
        if (this.transport) {
            await this.transport.close();
            this.transport = null;
        }
        this.client = null;
        this._status = 'disconnected';
        this.tools = [];
    }
}

/**
 * Synthetic tools - virtual tools appended to real MCP server tool lists
 * These extend an MCP server's capabilities without modifying the server itself.
 */
function buildSyntheticTools(serverName: string, tools: McpToolInfo[]): McpToolInfo[] {
    if (serverName === 'chrome-browser') {
        const realSchema = tools.find(t => t.originalName === 'evaluate_script');
        const realProps = (realSchema?.inputSchema?.properties ?? {}) as Record<string, unknown>;

        return [{
            originalName: 'evaluate_script_file',
            namespacedName: `${serverName}__evaluate_script_file`,
            serverName,
            description: 'Evaluate a JavaScript file in the currently selected browser page. Use this instead of evaluate_script to run reusable script files managed by you under ~/.pipali/home/code/browser/.',
            inputSchema: {
                type: 'object',
                properties: {
                    file_path: {
                        type: 'string',
                        description: 'Absolute path to the .js file to evaluate (e.g. ~/.pipali/home/code/browser/draft-email_safe.js). Supports ~ expansion. Files ending in _safe.js or _unsafe.js encode their operation_type in the filename — set operation_type to match the suffix.',
                    },
                    ...(realProps.args ? { args: realProps.args } : {}),
                    ...(realProps.includeSnapshot ? { includeSnapshot: realProps.includeSnapshot } : {}),
                },
                required: ['file_path'],
            },
        }];
    }
    return [];
}
