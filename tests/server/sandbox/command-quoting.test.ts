/**
 * Integration test for how wrapCommandWithSandbox quotes a command.
 *
 * The wrapped command reaches a non-interactive bash, which keeps a backslash
 * before ! inside double quotes, so every ! must arrive as written.
 *
 * Requires: SANDBOX_INTEGRATION_TESTS=true, run outside any existing sandbox.
 */

import { test, expect, describe, afterEach } from 'bun:test';
import os from 'os';
import {
    wrapCommandWithSandbox,
    initializeSandboxWithConfig,
    shutdownSandbox,
} from '../../../src/server/sandbox';
import { getDefaultConfig } from '../../../src/server/sandbox/config';

describe('Sandbox command quoting', () => {
    const isSupported = process.platform === 'darwin' || process.platform === 'linux';
    const runIntegrationTests = process.env.SANDBOX_INTEGRATION_TESTS === 'true';
    const testFn = isSupported && runIntegrationTests ? test : test.skip;

    const config = {
        ...getDefaultConfig(),
        allowedWritePaths: ['/tmp', '/private/tmp', `${os.homedir()}/.pipali`],
    };

    afterEach(async () => {
        await shutdownSandbox();
    });

    testFn('Python heredoc with != runs correctly through wrapCommandWithSandbox', async () => {
        await initializeSandboxWithConfig(config);

        // Single quotes beside a ! are the shape that once got it escaped to \!
        const cmd = `python3 - <<'PY'
data = {'key': 'value'}
for k, v in data.items():
    if k != 'missing':
        print(f'{k}={v}')
PY`;
        const wrappedCmd = await wrapCommandWithSandbox(cmd);

        const proc = Bun.spawn(['bash', '-c', wrappedCmd], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        expect(stderr).not.toContain('SyntaxError');
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('key=value');
    });
});
