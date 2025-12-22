/**
 * Global Teardown for E2E Tests
 *
 * Stops the test server after all tests complete.
 */

import type { FullConfig } from '@playwright/test';
import { getGlobalTestServer, setGlobalTestServer } from './fixtures/test-server';

async function globalTeardown(config: FullConfig): Promise<void> {
    console.log('\n[E2E Teardown] Stopping test server...');

    const server = getGlobalTestServer();
    if (server) {
        await server.stop();
        setGlobalTestServer(null);
    }

    console.log('[E2E Teardown] Complete\n');
}

export default globalTeardown;
