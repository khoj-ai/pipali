import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
    augmentSchemaWithOperationType,
    createMcpToolDefinition,
    getMcpConfirmationSubType,
    closeMcpClients,
    handleFailedMcpToolResult,
    isMcpTool,
    isWakeGap,
    mcpAttemptLogLevel,
    mcpRetryDelay,
    parseNamespacedToolName,
    reconnectFailedMcpServers,
    resetMcpRetryBackoff,
    shouldRequireConfirmation,
} from '../../../src/server/processor/mcp/manager';
import type { McpToolInfo } from '../../../src/server/processor/mcp/types';

function tableName(table: unknown): string | undefined {
    return (table as { __tableName?: string }).__tableName;
}

describe('MCP Manager', () => {
    describe('isMcpTool', () => {
        test('identifies namespaced MCP tool names', () => {
            expect(isMcpTool('github__create_issue')).toBe(true);
            expect(isMcpTool('my-server__my_tool')).toBe(true);
            expect(isMcpTool('view_file')).toBe(false);
            expect(isMcpTool('')).toBe(false);
        });
    });

    describe('parseNamespacedToolName', () => {
        test('parses a namespaced MCP tool name at the first separator', () => {
            expect(parseNamespacedToolName('server__path__to__tool')).toEqual({
                serverName: 'server',
                toolName: 'path__to__tool',
            });
        });

        test('returns null for non-MCP tool names', () => {
            expect(parseNamespacedToolName('view_file')).toBeNull();
        });
    });

    describe('createMcpToolDefinition', () => {
        test('prefixes the description and augments the schema used by the director', () => {
            const tool: McpToolInfo = {
                originalName: 'create_issue',
                namespacedName: 'github__create_issue',
                serverName: 'github',
                description: 'Creates a new issue',
                inputSchema: {
                    type: 'object',
                    properties: { title: { type: 'string' } },
                    required: ['title'],
                },
            };

            const definition = createMcpToolDefinition(tool);
            const properties = definition.schema.properties as Record<string, unknown>;
            const operationType = properties.operation_type as Record<string, unknown>;

            expect(definition.name).toBe('github__create_issue');
            expect(definition.description).toBe('[MCP: github] Creates a new issue');
            expect(properties).toHaveProperty('title');
            expect(operationType.enum).toEqual(['safe', 'unsafe']);
            expect(definition.schema.required).toEqual(['title', 'operation_type']);
        });
    });

    describe('augmentSchemaWithOperationType', () => {
        test('adds operation_type while preserving existing properties and required fields', () => {
            const augmented = augmentSchemaWithOperationType({
                type: 'object',
                properties: { title: { type: 'string' }, count: { type: 'number' } },
                required: ['title'],
            });

            const properties = augmented.properties as Record<string, unknown>;
            const operationType = properties.operation_type as Record<string, unknown>;

            expect(properties).toHaveProperty('title');
            expect(properties).toHaveProperty('count');
            expect(operationType.type).toBe('string');
            expect(operationType.enum).toEqual(['safe', 'unsafe']);
            expect(augmented.required).toEqual(['title', 'operation_type']);
        });

        test('creates required when the original schema has none', () => {
            const augmented = augmentSchemaWithOperationType({ type: 'object', properties: {} });

            expect(augmented.required).toEqual(['operation_type']);
        });
    });

    describe('shouldRequireConfirmation', () => {
        test('applies the server confirmation mode to the operation type', () => {
            expect(shouldRequireConfirmation('never', 'unsafe')).toBe(false);
            expect(shouldRequireConfirmation('always', 'safe')).toBe(true);
            expect(shouldRequireConfirmation('unsafe_only', 'safe')).toBe(false);
            expect(shouldRequireConfirmation('unsafe_only', 'unsafe')).toBe(true);
            expect(shouldRequireConfirmation('unsafe_only', undefined)).toBe(true);
        });
    });

    describe('getMcpConfirmationSubType', () => {
        test('builds per-server confirmation subtypes and defaults unknown operations to unsafe', () => {
            expect(getMcpConfirmationSubType('github', 'safe')).toBe('github:safe');
            expect(getMcpConfirmationSubType('github', 'unsafe')).toBe('github:unsafe');
            expect(getMcpConfirmationSubType('github', undefined)).toBe('github:unsafe');
        });
    });

    describe('handleFailedMcpToolResult', () => {
        const updates: Record<string, any>[] = [];

        beforeEach(() => {
            updates.length = 0;
            globalThis.__pipaliUnitDb = {
                update(table, values) {
                    if (tableName(table) === 'mcp_server') {
                        updates.push(values as Record<string, any>);
                    }
                },
            };
        });

        afterEach(() => {
            globalThis.__pipaliUnitDb = undefined;
        });

        test('marks the server auth_required for auth-required tool failures', async () => {
            const message = await handleFailedMcpToolResult('oauth-server', 'oauth-server__list_items', {
                success: false,
                content: [],
                error: 'Reauthorization required',
                authRequired: true,
            });

            expect(updates).toHaveLength(1);
            expect(updates[0]).toMatchObject({
                oauthStatus: 'auth_required',
                lastError: 'Reauthorization required',
            });
            expect(updates[0]!.updatedAt).toBeInstanceOf(Date);
            expect(message).toBe('Error executing MCP tool oauth-server__list_items: Reauthorization required');
        });

        test('does not update OAuth state for ordinary tool failures', async () => {
            const message = await handleFailedMcpToolResult('oauth-server', 'oauth-server__list_items', {
                success: false,
                content: [],
                error: 'Tool failed',
            });

            expect(updates).toHaveLength(0);
            expect(message).toBe('Error executing MCP tool oauth-server__list_items: Tool failed');
        });

        test('preserves Chrome setup guidance for remote debugging failures', async () => {
            const message = await handleFailedMcpToolResult('chrome-browser', 'chrome-browser__list_pages', {
                success: false,
                content: [],
                error: 'Open chrome://inspect/#remote-debugging first',
            });

            expect(message).toContain('Allow remote debugging');
        });
    });

    /**
     * A connect failure leaves the server out of the active client registry, so
     * every later tool snapshot reports the user's tools as absent. Before the
     * sweep the only ways back were the Tools page's Reload button and editing
     * the server, so one transient network failure at startup cost the user
     * their MCP tools until they noticed and reconnected by hand.
     */
    describe('reconnectFailedMcpServers', () => {
        /** A server whose command does not exist, so connecting fails immediately */
        const unreachable = {
            id: 1,
            name: 'posthog',
            description: null,
            transportType: 'stdio' as const,
            path: 'pipali-nonexistent-binary-for-tests',
            apiKey: null,
            authType: 'none' as const,
            oauthStatus: 'not_connected' as const,
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

        let attempts: Record<string, any>[];

        beforeEach(async () => {
            await closeMcpClients(); // also clears the retry schedule between tests
            attempts = [];
            globalThis.__pipaliUnitDb = {
                select: () => [unreachable],
                // Only a connection attempt writes lastError, so this counts attempts
                update(table, values) {
                    const set = values as Record<string, any>;
                    if (tableName(table) === 'mcp_server' && 'lastError' in set) {
                        attempts.push(set);
                    }
                },
            };
        });

        afterEach(() => {
            globalThis.__pipaliUnitDb = undefined;
        });

        test('re-attempts a server that failed to connect, with no user action', async () => {
            const t0 = 1_000_000;

            expect(await reconnectFailedMcpServers(t0)).toEqual([]);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.lastError).toBeTruthy();

            // Due again once the first backoff has elapsed
            await reconnectFailedMcpServers(t0 + mcpRetryDelay(0));
            expect(attempts).toHaveLength(2);
        });

        test('waits out the backoff instead of hammering a server that is down', async () => {
            const t0 = 1_000_000;
            await reconnectFailedMcpServers(t0);
            expect(attempts).toHaveLength(1);

            await reconnectFailedMcpServers(t0 + mcpRetryDelay(0) - 1);
            expect(attempts).toHaveLength(1);
        });

        test('backs off further with each successive failure', async () => {
            let now = 1_000_000;
            await reconnectFailedMcpServers(now);

            now += mcpRetryDelay(0);
            await reconnectFailedMcpServers(now);
            expect(attempts).toHaveLength(2);

            // The second delay is longer, so the first one elapsing is not enough
            await reconnectFailedMcpServers(now + mcpRetryDelay(0));
            expect(attempts).toHaveLength(2);

            await reconnectFailedMcpServers(now + mcpRetryDelay(1));
            expect(attempts).toHaveLength(3);
        });

        /**
         * Backoff assumes the delay was spent trying. Time the machine spent
         * asleep was not, so a lid opened after hours must not leave the user
         * waiting out a rung that accrued while nothing ran.
         */
        test('a wake makes a server waiting out its backoff due immediately', async () => {
            const t0 = 1_000_000;
            await reconnectFailedMcpServers(t0);
            expect(attempts).toHaveLength(1);

            // Still inside the first rung, so an ordinary tick does nothing
            await reconnectFailedMcpServers(t0 + 1);
            expect(attempts).toHaveLength(1);

            resetMcpRetryBackoff();

            await reconnectFailedMcpServers(t0 + 2);
            expect(attempts).toHaveLength(2);
        });

        test('a wake starts the backoff ladder over rather than resuming it', async () => {
            const t0 = 1_000_000;
            await reconnectFailedMcpServers(t0);
            const t1 = t0 + mcpRetryDelay(0);
            await reconnectFailedMcpServers(t1);
            expect(attempts).toHaveLength(2); // now on the second, longer rung

            resetMcpRetryBackoff();
            await reconnectFailedMcpServers(t1 + 1);
            expect(attempts).toHaveLength(3);

            // Back on the first rung: had the ladder resumed, this would be too early
            await reconnectFailedMcpServers(t1 + 1 + mcpRetryDelay(0));
            expect(attempts).toHaveLength(4);
        });

        // Connecting closes any existing client first, so overlapping attempts
        // would tear down the handshake the other one is waiting on
        test('does not start a second attempt while one is in flight', async () => {
            const t0 = 1_000_000;

            await Promise.all([reconnectFailedMcpServers(t0), reconnectFailedMcpServers(t0)]);

            expect(attempts).toHaveLength(1);
        });

        test('leaves disabled servers alone', async () => {
            globalThis.__pipaliUnitDb = {
                // The query filters on enabled, so a disabled server never comes back
                select: () => [],
                update: () => {},
            };

            expect(await reconnectFailedMcpServers(1_000_000)).toEqual([]);
            expect(attempts).toHaveLength(0);
        });
    });

    describe('mcpRetryDelay', () => {
        test('lengthens with each attempt and then holds', () => {
            expect(mcpRetryDelay(0)).toBeLessThan(mcpRetryDelay(1));
            expect(mcpRetryDelay(1)).toBeLessThan(mcpRetryDelay(2));
            // Keeps retrying at the longest delay rather than giving up
            expect(mcpRetryDelay(99)).toBe(mcpRetryDelay(3));
        });
    });

    describe('isWakeGap', () => {
        test('tolerates scheduler jitter but reads missed ticks as a wake', () => {
            expect(isWakeGap(15_000 * 2, 15_000)).toBe(false);
            expect(isWakeGap(8 * 60 * 60 * 1000, 15_000)).toBe(true);
        });
    });

    /**
     * A server down all day is retried every sweep tick. Logging each attempt
     * would write hundreds of identical lines, so only state changes speak up.
     */
    describe('mcpAttemptLogLevel', () => {
        const failing = { attempts: 3, dueAt: 1_000 };
        const parked = { attempts: 1, dueAt: Number.POSITIVE_INFINITY };

        test('reports the first failure, then goes quiet while it stays down', () => {
            expect(mcpAttemptLogLevel('retryable')).toBe('error');
            expect(mcpAttemptLogLevel('retryable', failing)).toBe('debug');
        });

        test('reports coming back', () => {
            expect(mcpAttemptLogLevel('connected')).toBe('info');
            expect(mcpAttemptLogLevel('connected', failing)).toBe('info');
        });

        test('reports the decision to stop retrying once', () => {
            expect(mcpAttemptLogLevel('unauthorized', failing)).toBe('error');
            expect(mcpAttemptLogLevel('unauthorized', parked)).toBe('debug');
            expect(mcpAttemptLogLevel('auth_pending')).toBe('info');
            expect(mcpAttemptLogLevel('auth_pending', parked)).toBe('debug');
        });
    });
});
