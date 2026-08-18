/**
 * Global Setup for E2E Tests
 *
 * Starts the test server before all tests run.
 */

import type { FullConfig } from '@playwright/test';
import { TestServer, setGlobalTestServer } from './fixtures/test-server';

const TEST_PORT = 6466;

async function globalSetup(config: FullConfig): Promise<void> {
    console.log('\n[E2E Setup] Starting test server...');

    const server = new TestServer({
        port: TEST_PORT,
        host: '127.0.0.1',
    });

    await server.start();

    // Store server instance for teardown
    setGlobalTestServer(server);

    // Export skills directory for tests to use
    // This is set as environment variable so tests can access it
    process.env.TEST_SKILLS_DIR = server.getSkillsDir();
    process.env.TEST_REQUEST_LOG = server.getRequestLogPath();

    console.log('[E2E Setup] Test server ready\n');
}

export default globalSetup;
