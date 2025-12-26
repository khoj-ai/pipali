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
    const baseDir = '/tmp/panini';
    const { mkdirSync } = await import('node:fs');
    mkdirSync(baseDir, { recursive: true });
    process.env.POSTGRES_DB ||= `${baseDir}/panini-unit-${process.pid}-${Date.now()}`;
} catch {
    // If /tmp isn't available, fall back to cwd
    process.env.POSTGRES_DB ||= `${process.cwd()}/.panini-unit-test.db`;
}

process.env.PANINI_TEST_MODE ||= 'true';

// Stub DB imports so PGlite/WASM never boots during unit tests
const dbModule = import.meta.resolve('../src/server/db');
const dbSchemaModule = import.meta.resolve('../src/server/db/schema');

mock.module(dbSchemaModule, () => {
    return {
        User: { $inferSelect: {} },
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

// Import E2E mock-preload to set up globalThis.__paniniMockLLM
await import('./e2e/mock-preload');

console.log('[UnitPreload] ✅ DB mocked, LLM mock initialized for unit tests');
