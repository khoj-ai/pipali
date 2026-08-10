/**
 * Unit Test Preload Script
 *
 * Preloaded for `bun test` via `bunfig.toml`.
 * Goal: keep unit tests hermetic by avoiding real DB/LLM initialization.
 *
 * Uses Bun's mock.module() to stub out DB at import time,
 * and imports the E2E mock-preload for LLM mocking via globalThis.
 */

import { mock } from 'bun:test';

type UnitDbAdapter = {
    select?: (table: unknown, condition?: unknown) => unknown;
    insert?: (table: unknown, values: unknown) => unknown;
    update?: (table: unknown, values: unknown, condition?: unknown) => unknown;
    delete?: (table: unknown, condition?: unknown) => unknown;
};

declare global {
    // Unit tests can install a per-test adapter for code paths that should
    // exercise DB persistence without opening the real PGlite database.
    // eslint-disable-next-line no-var
    var __pipaliUnitDb: UnitDbAdapter | undefined;
}

function getUnitDb(): UnitDbAdapter | undefined {
    return globalThis.__pipaliUnitDb;
}

// Ensure unit tests never touch the persistent repo DB or the developer's real memories
try {
    const baseDir = '/tmp/pipali';
    const { mkdirSync } = await import('node:fs');
    mkdirSync(baseDir, { recursive: true });
    process.env.POSTGRES_DB ||= `${baseDir}/pipali-unit-${process.pid}-${Date.now()}`;
    process.env.PIPALI_MEMORY_DIR ||= `${baseDir}/pipali-unit-${process.pid}-memory`;
} catch {
    // If /tmp isn't available, fall back to cwd
    process.env.POSTGRES_DB ||= `${process.cwd()}/.pipali-unit-test.db`;
    process.env.PIPALI_MEMORY_DIR ||= `${process.cwd()}/.pipali-unit-test-memory`;
}

process.env.PIPALI_TEST_MODE ||= 'true';

// Stub DB imports so PGlite/WASM never boots during unit tests
const dbModule = import.meta.resolve('../src/server/db');
const dbSchemaModule = import.meta.resolve('../src/server/db/schema');

mock.module(dbSchemaModule, () => {
    return {
        // Basic tables
        User: { $inferSelect: {} },
        MemorySettings: {
            id: 'id',
            userId: 'userId',
            memoriesEnabled: 'memoriesEnabled',
            $inferSelect: {},
        },
        AiModelApi: { $inferSelect: {} },
        ChatModel: { $inferSelect: {} },
        UserChatModel: { $inferSelect: {} },
        Conversation: {
            id: 'id',
            userId: 'userId',
            title: 'title',
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
            chatModelId: 'chatModelId',
            automationId: 'automationId',
            isPinned: 'isPinned',
            $inferSelect: {},
        },
        ConversationStep: {
            conversationId: 'conversationId',
            stepId: 'stepId',
            source: 'source',
            messagePreview: 'messagePreview',
            step: 'step',
            $inferSelect: {},
        },
        PlatformAuth: { $inferSelect: {} },
        McpServer: {
            __tableName: 'mcp_server',
            id: 'mcp_server.id',
            name: 'mcp_server.name',
            enabled: 'mcp_server.enabled',
            $inferSelect: {},
        },
        McpOAuthState: {
            __tableName: 'mcp_oauth_state',
            serverId: 'mcp_oauth_state.server_id',
            $inferSelect: {},
        },
        Automation: { $inferSelect: {} },
        AutomationExecution: { $inferSelect: {} },
        PendingConfirmation: {
            id: 'id',
            executionId: 'executionId',
            request: 'request',
            status: 'status',
            expiresAt: 'expiresAt',
            $inferSelect: {},
        },
        // Sandbox settings table with column references
        SandboxSettings: {
            id: 'id',
            userId: 'userId',
            enabled: 'enabled',
            allowedWritePaths: 'allowedWritePaths',
            deniedWritePaths: 'deniedWritePaths',
            deniedReadPaths: 'deniedReadPaths',
            allowedDomains: 'allowedDomains',
            allowLocalBinding: 'allowLocalBinding',
            $inferSelect: {},
        },
        // Web search/scraper tables with column references for queries
        WebSearchProvider: {
            enabled: 'enabled',
            priority: 'priority',
            type: 'type',
            apiKey: 'apiKey',
            apiBaseUrl: 'apiBaseUrl',
            name: 'name',
            $inferSelect: {},
        },
        WebScraper: {
            enabled: 'enabled',
            priority: 'priority',
            type: 'type',
            apiKey: 'apiKey',
            apiBaseUrl: 'apiBaseUrl',
            name: 'name',
            $inferSelect: {},
        },
    };
});

mock.module(dbModule, () => {
    return {
        db: {
            select() {
                return {
                    from(table: unknown) {
                        return {
                            where(condition: unknown) {
                                const adapter = getUnitDb();
                                if (adapter?.select) {
                                    return adapter.select(table, condition);
                                }
                                throw new Error('DB disabled in unit tests');
                            },
                        };
                    },
                };
            },
            insert(table: unknown) {
                return {
                    values(values: unknown) {
                        const adapter = getUnitDb();
                        if (adapter?.insert) {
                            return adapter.insert(table, values);
                        }
                        throw new Error('DB disabled in unit tests');
                    },
                };
            },
            update(table: unknown) {
                return {
                    set(values: unknown) {
                        return {
                            where(condition: unknown) {
                                const adapter = getUnitDb();
                                if (adapter?.update) {
                                    return adapter.update(table, values, condition);
                                }
                                throw new Error('DB disabled in unit tests');
                            },
                        };
                    },
                };
            },
            delete(table: unknown) {
                return {
                    where(condition: unknown) {
                        const adapter = getUnitDb();
                        if (adapter?.delete) {
                            return adapter.delete(table, condition);
                        }
                        throw new Error('DB disabled in unit tests');
                    },
                };
            },
        },
        client: {
            async close() {
                // no-op
            },
        },
        async closeDatabase() {
            // no-op
        },
        async getDefaultChatModel() {
            return undefined;
        },
        async getChatModelById() {
            return undefined;
        },
    };
});

// Import E2E mock-preload to set up globalThis.__pipaliMockLLM
await import('./e2e/mock-preload');

console.log('[UnitPreload] ✅ DB mocked, LLM mock initialized for unit tests');
