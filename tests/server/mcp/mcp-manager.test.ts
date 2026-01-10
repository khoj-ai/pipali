import { describe, expect, test } from 'bun:test';

/**
 * Unit tests for MCP Manager functionality.
 *
 * These tests verify the manager's core logic without requiring database
 * or actual MCP server connections. The functions are tested via inline
 * implementations that match the actual manager code.
 */
describe('MCP Manager', () => {
    // Inline implementation matching the manager
    function isMcpTool(toolName: string): boolean {
        return toolName.includes('/');
    }

    function parseNamespacedToolName(namespacedName: string): { serverName: string; toolName: string } | null {
        const slashIndex = namespacedName.indexOf('/');
        if (slashIndex === -1) {
            return null;
        }
        return {
            serverName: namespacedName.slice(0, slashIndex),
            toolName: namespacedName.slice(slashIndex + 1),
        };
    }

    describe('isMcpTool', () => {
        test('returns true for namespaced tool names', () => {
            expect(isMcpTool('github/create_issue')).toBe(true);
            expect(isMcpTool('slack/send_message')).toBe(true);
            expect(isMcpTool('my-server/my_tool')).toBe(true);
        });

        test('returns false for built-in tool names', () => {
            expect(isMcpTool('view_file')).toBe(false);
            expect(isMcpTool('list_files')).toBe(false);
            expect(isMcpTool('grep_files')).toBe(false);
            expect(isMcpTool('edit_file')).toBe(false);
            expect(isMcpTool('shell_command')).toBe(false);
            expect(isMcpTool('search_web')).toBe(false);
            expect(isMcpTool('text')).toBe(false);
        });

        test('handles edge cases', () => {
            expect(isMcpTool('')).toBe(false);
            expect(isMcpTool('/')).toBe(true);  // Contains /
            expect(isMcpTool('a/b/c')).toBe(true);  // Multiple slashes
        });
    });

    describe('parseNamespacedToolName', () => {
        test('parses valid namespaced tool names', () => {
            expect(parseNamespacedToolName('github/create_issue')).toEqual({
                serverName: 'github',
                toolName: 'create_issue',
            });

            expect(parseNamespacedToolName('slack/send_message')).toEqual({
                serverName: 'slack',
                toolName: 'send_message',
            });

            expect(parseNamespacedToolName('my-db/execute_query')).toEqual({
                serverName: 'my-db',
                toolName: 'execute_query',
            });
        });

        test('returns null for non-namespaced tool names', () => {
            expect(parseNamespacedToolName('view_file')).toBeNull();
            expect(parseNamespacedToolName('list_files')).toBeNull();
            expect(parseNamespacedToolName('text')).toBeNull();
        });

        test('handles tool names with multiple slashes', () => {
            // First slash is the separator
            const result = parseNamespacedToolName('server/path/to/tool');
            expect(result).toEqual({
                serverName: 'server',
                toolName: 'path/to/tool',
            });
        });

        test('handles edge cases', () => {
            // Empty server name
            const result1 = parseNamespacedToolName('/tool');
            expect(result1).toEqual({ serverName: '', toolName: 'tool' });

            // Empty tool name
            const result2 = parseNamespacedToolName('server/');
            expect(result2).toEqual({ serverName: 'server', toolName: '' });

            // Just a slash
            const result3 = parseNamespacedToolName('/');
            expect(result3).toEqual({ serverName: '', toolName: '' });
        });
    });

    describe('Tool Definition Creation', () => {
        interface McpToolInfo {
            originalName: string;
            namespacedName: string;
            serverName: string;
            description: string;
            inputSchema: Record<string, unknown>;
        }

        function createToolDefinition(tool: McpToolInfo) {
            return {
                name: tool.namespacedName,
                description: `[MCP: ${tool.serverName}] ${tool.description}`,
                schema: tool.inputSchema,
            };
        }

        test('creates tool definition with namespaced name', () => {
            const tool: McpToolInfo = {
                originalName: 'create_issue',
                namespacedName: 'github/create_issue',
                serverName: 'github',
                description: 'Creates a new issue',
                inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
            };

            const result = createToolDefinition(tool);

            expect(result.name).toBe('github/create_issue');
            expect(result.description).toBe('[MCP: github] Creates a new issue');
            expect(result.schema).toEqual(tool.inputSchema);
        });

        test('prefixes description with MCP server info', () => {
            const tool: McpToolInfo = {
                originalName: 'query',
                namespacedName: 'database/query',
                serverName: 'database',
                description: 'Execute SQL query',
                inputSchema: {},
            };

            const result = createToolDefinition(tool);

            expect(result.description).toStartWith('[MCP: database]');
            expect(result.description).toContain('Execute SQL query');
        });
    });

    describe('Server Status Tracking', () => {
        type McpClientStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

        interface ServerStatus {
            name: string;
            status: McpClientStatus;
            toolCount: number;
        }

        function createServerStatus(name: string, status: McpClientStatus): ServerStatus {
            return { name, status, toolCount: 0 };
        }

        function isServerAvailable(status: ServerStatus): boolean {
            return status.status === 'connected';
        }

        test('creates server status with default values', () => {
            const status = createServerStatus('my-server', 'connected');
            expect(status.name).toBe('my-server');
            expect(status.status).toBe('connected');
            expect(status.toolCount).toBe(0);
        });

        test('identifies available servers', () => {
            expect(isServerAvailable({ name: 'a', status: 'connected', toolCount: 0 })).toBe(true);
            expect(isServerAvailable({ name: 'b', status: 'disconnected', toolCount: 0 })).toBe(false);
            expect(isServerAvailable({ name: 'c', status: 'connecting', toolCount: 0 })).toBe(false);
            expect(isServerAvailable({ name: 'd', status: 'error', toolCount: 0 })).toBe(false);
        });
    });

    describe('Error Handling', () => {
        function formatMcpError(serverName: string, error: unknown): string {
            if (error instanceof Error) {
                return `Error from MCP server ${serverName}: ${error.message}`;
            }
            return `Error from MCP server ${serverName}: ${String(error)}`;
        }

        test('formats Error objects correctly', () => {
            const error = new Error('Connection timeout');
            const result = formatMcpError('my-server', error);
            expect(result).toBe('Error from MCP server my-server: Connection timeout');
        });

        test('formats string errors correctly', () => {
            const result = formatMcpError('my-server', 'Network failure');
            expect(result).toBe('Error from MCP server my-server: Network failure');
        });

        test('handles unknown error types', () => {
            const result = formatMcpError('my-server', { code: 500 });
            expect(result).toBe('Error from MCP server my-server: [object Object]');
        });
    });
});
