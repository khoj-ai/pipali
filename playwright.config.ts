import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test server configuration
const TEST_PORT = 6465; // Different from dev port 6464
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

export default defineConfig({
    testDir: './tests/e2e/specs',

    // Keep Playwright tests out of `bun test` (Bun auto-runs `*.spec.*`).
    testMatch: '**/*.e2e.ts',

    // Run tests sequentially (tests share server state)
    fullyParallel: false,

    // Fail fast for CI
    forbidOnly: !!process.env.CI,

    // Retry failed tests
    retries: process.env.CI ? 2 : 0,

    // Single worker since tests share a server
    workers: 1,

    // Reporter
    reporter: process.env.CI ? 'github' : 'html',

    // Global setup for server lifecycle
    globalSetup: resolve(__dirname, './tests/e2e/global-setup.ts'),
    globalTeardown: resolve(__dirname, './tests/e2e/global-teardown.ts'),

    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',

        // Timeouts
        actionTimeout: 10000,
        navigationTimeout: 15000,
    },

    // Increase test timeout for E2E tests with mock delays
    timeout: 60000,

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
