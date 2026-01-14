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

// Ensure unit tests never touch the persistent repo DB
try {
    const baseDir = '/tmp/pipali';
    const { mkdirSync } = await import('node:fs');
    mkdirSync(baseDir, { recursive: true });
    process.env.POSTGRES_DB ||= `${baseDir}/pipali-unit-${process.pid}-${Date.now()}`;
} catch {
    // If /tmp isn't available, fall back to cwd
    process.env.POSTGRES_DB ||= `${process.cwd()}/.pipali-unit-test.db`;
}

process.env.PIPALI_TEST_MODE ||= 'true';

// Stub DB imports so PGlite/WASM never boots during unit tests
const dbModule = import.meta.resolve('../src/server/db');
const dbSchemaModule = import.meta.resolve('../src/server/db/schema');

mock.module(dbSchemaModule, () => {
    return {
        // Basic tables
        User: { $inferSelect: {} },
        AiModelApi: { $inferSelect: {} },
        ChatModel: { $inferSelect: {} },
        UserChatModel: { $inferSelect: {} },
        Conversation: { $inferSelect: {} },
        PlatformAuth: { $inferSelect: {} },
        McpServer: { $inferSelect: {} },
        Automation: { $inferSelect: {} },
        AutomationExecution: { $inferSelect: {} },
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
                    from() {
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
    };
});

// Import E2E mock-preload to set up globalThis.__pipaliMockLLM
await import('./e2e/mock-preload');

console.log('[UnitPreload] ✅ DB mocked, LLM mock initialized for unit tests');
