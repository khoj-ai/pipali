/**
 * The sandbox runtime records what it refuses, such as a domain off the allowlist, under
 * the run that tried it. A later command must not be told of an earlier one's refusals.
 *
 * Requires: SANDBOX_INTEGRATION_TESTS=true, run outside any existing sandbox.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { getDefaultConfig } from '../../../src/server/sandbox/config';
import { initializeSandboxWithConfig, isSandboxActive, shutdownSandbox } from '../../../src/server/sandbox';
import { shellCommand } from '../../../src/server/processor/actor/shell_command';

describe('Sandbox violations', () => {
    const isSupported = process.platform === 'darwin' || process.platform === 'linux';
    const runIntegrationTests = process.env.SANDBOX_INTEGRATION_TESTS === 'true';
    const testFn = isSupported && runIntegrationTests ? test : test.skip;

    // The runtime tells commands apart by their first 100 characters
    const sharedPrefix = `: ${'x'.repeat(100)};`;

    async function runSandboxed(command: string): Promise<string> {
        const result = await shellCommand({ justification: 'test', command, operation_type: 'read-only', execution_mode: 'sandbox' });
        return String(result.compiled);
    }

    beforeAll(async () => {
        if (isSupported && runIntegrationTests) await initializeSandboxWithConfig(getDefaultConfig());
    });

    afterAll(async () => {
        await shutdownSandbox();
    });

    testFn('reports a refused domain to the run that tried it alone', async () => {
        expect(isSandboxActive()).toBe(true);

        const refused = await runSandboxed(`${sharedPrefix} curl -sS --max-time 10 https://example.com`);
        expect(refused).toContain('<sandbox_violations>');
        expect(refused).toContain('example.com');
        // A refused domain is not a refused write
        expect(refused).not.toContain('[Sandbox violation');

        const later = await runSandboxed(`${sharedPrefix} echo later >&2`);
        expect(later).toContain('later');
        expect(later).not.toContain('<sandbox_violations>');
        expect(later).not.toContain('[Sandbox violation');
    });
});
