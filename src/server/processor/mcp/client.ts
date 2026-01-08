import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpToolInfo, McpToolCallResult, McpClientStatus, McpContentType } from './types';

/**
 * MCP Client for connecting to and interacting with MCP servers.
 * Supports both stdio (local scripts/npm packages) and HTTP (remote servers) transports.
 */
export class McpClient {
    private config: McpServerConfig;
    private client: Client | null = null;
    private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
    private tools: McpToolInfo[] = [];
    private _status: McpClientStatus = 'disconnected';

    constructor(config: McpServerConfig) {
        this.config = config;
    }

    get status(): McpClientStatus {
        return this._status;
    }

    get serverName(): string {
        return this.config.name;
    }

    get requiresConfirmation(): boolean {
        return this.config.requiresConfirmation;
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
            if (this.config.path.startsWith('http://') || this.config.path.startsWith('https://')) {
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
        const { command, args } = this.parseStdioCommand();

        // Build environment with user-specified overrides
        const env = {
            ...getDefaultEnvironment(),
            ...this.config.env,
        };

        this.transport = new StdioClientTransport({
            command,
            args,
            env,
            stderr: 'inherit',
        });

        await this.client!.connect(this.transport);
    }

    /**
     * Parse the path into command and args for stdio transport.
     * Supports commands with arguments, e.g., "chrome-devtools-mcp@latest --autoConnect --channel=beta"
     */
    private parseStdioCommand(): { command: string; args: string[] } {
        const path = this.config.path.trim();

        // Split path into parts, respecting quoted strings
        const parts = this.splitCommandLine(path);
        const [firstPart, ...extraArgs] = parts;

        if (!firstPart) {
            return { command: path, args: [] };
        }

        // npm package (starts with @ or has no path separator in the first part)
        if (firstPart.startsWith('@') || !firstPart.includes('/')) {
            return { command: 'npx', args: ['-y', firstPart, ...extraArgs] };
        }

        // Python script
        if (firstPart.endsWith('.py')) {
            return { command: 'python', args: [firstPart, ...extraArgs] };
        }

        // JavaScript script
        if (firstPart.endsWith('.js') || firstPart.endsWith('.mjs')) {
            return { command: 'node', args: [firstPart, ...extraArgs] };
        }

        // TypeScript script (run with bun)
        if (firstPart.endsWith('.ts')) {
            return { command: 'bun', args: ['run', firstPart, ...extraArgs] };
        }

        // Default: treat first part as executable, rest as args
        return { command: firstPart, args: extraArgs };
    }

    /**
     * Split a command line string into parts, respecting quoted strings.
     * E.g., 'foo --bar "hello world"' => ['foo', '--bar', 'hello world']
     */
    private splitCommandLine(input: string): string[] {
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
     * Connect using HTTP transport (for remote servers)
     */
    private async connectHttp(): Promise<void> {
        const url = new URL(this.config.path);

        const requestInit: RequestInit = {};
        if (this.config.apiKey) {
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
     * Execute a tool by its original (non-namespaced) name
     */
    async runTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
        if (!this.client) {
            throw new Error('Client not connected');
        }

        try {
            const result = await this.client.callTool({
                name: toolName,
                arguments: args,
            });

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

            return {
                success: !('isError' in result && result.isError),
                content,
            };
        } catch (error) {
            return {
                success: false,
                content: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
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
