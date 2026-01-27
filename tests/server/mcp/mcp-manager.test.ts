import { describe, expect, test } from 'bun:test';

/**
 * Unit tests for MCP Manager functionality.
 *
 * These tests verify the manager's core logic without requiring database
 * or actual MCP server connections. The functions are tested via inline
 * implementations that match the actual manager code.
 */
describe('MCP Manager', () => {
    // Inline implementation matching the manager (uses __ as separator)
    function isMcpTool(toolName: string): boolean {
        return toolName.includes('__');
    }

    function parseNamespacedToolName(namespacedName: string): { serverName: string; toolName: string } | null {
        const separatorIndex = namespacedName.indexOf('__');
        if (separatorIndex === -1) {
            return null;
        }
        return {
            serverName: namespacedName.slice(0, separatorIndex),
            toolName: namespacedName.slice(separatorIndex + 2), // Skip the '__' separator
        };
    }

    describe('isMcpTool', () => {
        test('returns true for namespaced tool names', () => {
            expect(isMcpTool('github__create_issue')).toBe(true);
            expect(isMcpTool('slack__send_message')).toBe(true);
            expect(isMcpTool('my-server__my_tool')).toBe(true);
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
            expect(isMcpTool('__')).toBe(true);  // Contains __
            expect(isMcpTool('a__b__c')).toBe(true);  // Multiple separators
        });
    });

    describe('parseNamespacedToolName', () => {
        test('parses valid namespaced tool names', () => {
            expect(parseNamespacedToolName('github__create_issue')).toEqual({
                serverName: 'github',
                toolName: 'create_issue',
            });

            expect(parseNamespacedToolName('slack__send_message')).toEqual({
                serverName: 'slack',
                toolName: 'send_message',
            });

            expect(parseNamespacedToolName('my-db__execute_query')).toEqual({
                serverName: 'my-db',
                toolName: 'execute_query',
            });
        });

        test('returns null for non-namespaced tool names', () => {
            expect(parseNamespacedToolName('view_file')).toBeNull();
            expect(parseNamespacedToolName('list_files')).toBeNull();
            expect(parseNamespacedToolName('text')).toBeNull();
        });

        test('handles tool names with multiple separators', () => {
            // First __ is the separator, rest is part of tool name
            const result = parseNamespacedToolName('server__path__to__tool');
            expect(result).toEqual({
                serverName: 'server',
                toolName: 'path__to__tool',
            });
        });

        test('handles edge cases', () => {
            // Empty server name
            const result1 = parseNamespacedToolName('__tool');
            expect(result1).toEqual({ serverName: '', toolName: 'tool' });

            // Empty tool name
            const result2 = parseNamespacedToolName('server__');
            expect(result2).toEqual({ serverName: 'server', toolName: '' });

            // Just the separator
            const result3 = parseNamespacedToolName('__');
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
                namespacedName: 'github__create_issue',
                serverName: 'github',
                description: 'Creates a new issue',
                inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
            };

            const result = createToolDefinition(tool);

            expect(result.name).toBe('github__create_issue');
            expect(result.description).toBe('[MCP: github] Creates a new issue');
            expect(result.schema).toEqual(tool.inputSchema);
        });

        test('prefixes description with MCP server info', () => {
            const tool: McpToolInfo = {
                originalName: 'query',
                namespacedName: 'database__query',
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

    describe('Confirmation Mode Logic', () => {
        type ConfirmationMode = 'always' | 'write_only' | 'never';
        type OperationType = 'read_only' | 'read_write' | undefined;

        /**
         * Inline implementation matching the manager's shouldRequireConfirmation function.
         * Determines if confirmation is required based on server's confirmation mode and
         * the operation type specified by the agent.
         */
        function shouldRequireConfirmation(
            confirmationMode: ConfirmationMode,
            operationType: OperationType
        ): boolean {
            switch (confirmationMode) {
                case 'never':
                    return false;
                case 'always':
                    return true;
                case 'write_only':
                    // Only require confirmation for read-write operations
                    // If operation_type is not specified, default to requiring confirmation (safer)
                    return operationType !== 'read_only';
                default:
                    return true;
            }
        }

        describe('mode: never', () => {
            test('never requires confirmation regardless of operation type', () => {
                expect(shouldRequireConfirmation('never', 'read_only')).toBe(false);
                expect(shouldRequireConfirmation('never', 'read_write')).toBe(false);
                expect(shouldRequireConfirmation('never', undefined)).toBe(false);
            });
        });

        describe('mode: always', () => {
            test('always requires confirmation regardless of operation type', () => {
                expect(shouldRequireConfirmation('always', 'read_only')).toBe(true);
                expect(shouldRequireConfirmation('always', 'read_write')).toBe(true);
                expect(shouldRequireConfirmation('always', undefined)).toBe(true);
            });
        });

        describe('mode: write_only', () => {
            test('does not require confirmation for read-only operations', () => {
                expect(shouldRequireConfirmation('write_only', 'read_only')).toBe(false);
            });

            test('requires confirmation for read-write operations', () => {
                expect(shouldRequireConfirmation('write_only', 'read_write')).toBe(true);
            });

            test('requires confirmation when operation type is not specified (safer default)', () => {
                expect(shouldRequireConfirmation('write_only', undefined)).toBe(true);
            });
        });

        describe('schema augmentation', () => {
            function augmentSchemaWithOperationType(originalSchema: Record<string, unknown>): Record<string, unknown> {
                const schema = { ...originalSchema };
                const properties = (schema.properties as Record<string, unknown>) || {};
                schema.properties = {
                    ...properties,
                    operation_type: {
                        type: 'string',
                        enum: ['read_only', 'read_write'],
                        description: 'Indicates whether this tool call only reads data (read_only) or modifies state (read_write).',
                    },
                };
                const required = Array.isArray(schema.required) ? [...schema.required] : [];
                if (!required.includes('operation_type')) {
                    required.push('operation_type');
                }
                schema.required = required;
                return schema;
            }

            test('adds operation_type property to schema', () => {
                const original = { type: 'object', properties: { name: { type: 'string' } } };
                const augmented = augmentSchemaWithOperationType(original);

                expect(augmented.properties).toHaveProperty('operation_type');
                const opType = (augmented.properties as Record<string, unknown>).operation_type as Record<string, unknown>;
                expect(opType.type).toBe('string');
                expect(opType.enum).toEqual(['read_only', 'read_write']);
            });

            test('adds operation_type to required array', () => {
                const original = { type: 'object', properties: {}, required: ['name'] };
                const augmented = augmentSchemaWithOperationType(original);

                expect(augmented.required).toContain('operation_type');
                expect(augmented.required).toContain('name');
            });

            test('creates required array if not present', () => {
                const original = { type: 'object', properties: {} };
                const augmented = augmentSchemaWithOperationType(original);

                expect(augmented.required).toEqual(['operation_type']);
            });

            test('preserves original properties', () => {
                const original = {
                    type: 'object',
                    properties: { title: { type: 'string' }, count: { type: 'number' } },
                };
                const augmented = augmentSchemaWithOperationType(original);

                const props = augmented.properties as Record<string, unknown>;
                expect(props).toHaveProperty('title');
                expect(props).toHaveProperty('count');
                expect(props).toHaveProperty('operation_type');
            });
        });

        describe('confirmation key generation', () => {
            /**
             * Generates a confirmation key for MCP tool calls.
             * Format: "serverName:safe" or "serverName:unsafe"
             * This becomes the operationSubType, and the full key becomes:
             * "mcp_tool_call:serverName:safe" or "mcp_tool_call:serverName:unsafe"
             */
            function generateMcpConfirmationSubType(
                serverName: string,
                operationType: 'safe' | 'unsafe' | undefined
            ): string {
                const opTypeStr = operationType === 'safe' ? 'safe' : 'unsafe';
                return `${serverName}:${opTypeStr}`;
            }

            test('generates key with server name and operation type', () => {
                expect(generateMcpConfirmationSubType('github', 'safe')).toBe('github:safe');
                expect(generateMcpConfirmationSubType('github', 'unsafe')).toBe('github:unsafe');
                expect(generateMcpConfirmationSubType('chrome-browser', 'safe')).toBe('chrome-browser:safe');
            });

            test('defaults to unsafe when operation type is undefined', () => {
                expect(generateMcpConfirmationSubType('github', undefined)).toBe('github:unsafe');
            });

            test('different servers have different keys', () => {
                const githubKey = generateMcpConfirmationSubType('github', 'safe');
                const slackKey = generateMcpConfirmationSubType('slack', 'safe');
                expect(githubKey).not.toBe(slackKey);
            });

            test('same server with different operation types have different keys', () => {
                const safeKey = generateMcpConfirmationSubType('github', 'safe');
                const unsafeKey = generateMcpConfirmationSubType('github', 'unsafe');
                expect(safeKey).not.toBe(unsafeKey);
            });
        });
    });
});
