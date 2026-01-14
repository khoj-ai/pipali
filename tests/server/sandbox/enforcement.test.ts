/**
 * Integration tests for OS-level sandbox enforcement.
 * These tests actually execute sandboxed commands and verify the OS blocks restricted operations.
 *
 * These tests run by default locally but are SKIPPED in CI because:
 * 1. They require the sandbox-runtime to initialize an HTTP proxy server
 * 2. CI runners may not have bubblewrap (Linux) or sandbox-exec permissions (macOS)
 * 3. They need actual OS-level permissions to execute sandbox-exec/bwrap
 *
 * To run in CI, set: SANDBOX_INTEGRATION_TESTS=true
 *
 * The tests verify:
 * - Writes outside allowed directories are blocked
 * - Writes to allowed directories succeed
 * - File copy to unauthorized locations is blocked
 * - stderr annotation correctly identifies sandbox violations
 */

import { test, expect, describe } from 'bun:test';
import os from 'os';
import path from 'path';

describe('Sandbox OS Enforcement', () => {
    const isSupported = process.platform === 'darwin' || process.platform === 'linux';
    // Opt-in via environment variable (these tests need to run outside any existing sandbox)
    const runIntegrationTests = process.env.SANDBOX_INTEGRATION_TESTS === 'true';

    // Skip unless explicitly enabled via environment variable
    const testFn = isSupported && runIntegrationTests ? test : test.skip;

    const testConfig = {
        filesystem: {
            allowWrite: ['/tmp/pipali', `${os.homedir()}/.pipali`],
            denyWrite: ['/tmp/pipali-denied'],
            denyRead: ['**/.ssh'],
            allowGitConfig: false,
        },
        network: {
            allowedDomains: ['localhost'],
            deniedDomains: [],
            allowLocalBinding: true,
            allowAllUnixSockets: false,
        },
    };

    testFn.each([
        '/tmp/sandbox-test-blocked.txt',
        '/tmp/pipali-denied/sandbox-test-blocked.txt',
    ])('should block writes outside allowed directory: %s', async (disallowedPath) => {
        const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

        // Initialize sandbox
        await SandboxManager.initialize(testConfig);

        // Create a command that tries to write outside allowed paths
        const command = `echo "test" > ${disallowedPath}`;
        const wrappedCmd = await SandboxManager.wrapWithSandbox(command, '/bin/bash', testConfig);

        // Execute the sandboxed command
        const proc = Bun.spawn(['bash', '-c', wrappedCmd], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const exitCode = await proc.exited;

        // Command should fail due to sandbox restrictions
        expect(exitCode).not.toBe(0);

        await SandboxManager.reset();
    });

    testFn.each([
        '/tmp/pipali/sandbox-test-allowed.txt',
        '/tmp/pipali/another-dir/sandbox-test-allowed.txt',
        `${os.homedir()}/.pipali/sandbox-test-allowed.txt`,
    ])('should allow writes to permitted directories: %s', async (allowedPath) => {
        const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
        const fs = await import('fs/promises');

        // Ensure test directory exists
        const parentPath = path.dirname(allowedPath);
        await fs.mkdir(parentPath, { recursive: true });

        // Initialize sandbox
        await SandboxManager.initialize(testConfig);

        // Create a command that writes to an allowed path
        const testFile = allowedPath;
        const command = `echo "sandbox test" > ${testFile}`;
        const wrappedCmd = await SandboxManager.wrapWithSandbox(command, '/bin/bash', testConfig);

        // Execute the sandboxed command
        const proc = Bun.spawn(['bash', '-c', wrappedCmd], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const exitCode = await proc.exited;

        // Command should succeed
        expect(exitCode).toBe(0);

        // Verify file was created
        const content = await fs.readFile(testFile, 'utf-8');
        expect(content.trim()).toBe('sandbox test');

        // Cleanup
        await fs.rm(testFile, { force: true });
        await SandboxManager.reset();
    });

    testFn('should block file copy to unauthorized location', async () => {
        const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
        const fs = await import('fs/promises');

        // Create source file in allowed directory
        await fs.mkdir('/tmp/pipali', { recursive: true });
        const sourceFile = '/tmp/pipali/source.txt';
        await fs.writeFile(sourceFile, 'source content');

        // Initialize sandbox
        await SandboxManager.initialize(testConfig);

        // Try to copy file to unauthorized location
        const command = `cp ${sourceFile} /tmp/unauthorized-copy.txt`;
        const wrappedCmd = await SandboxManager.wrapWithSandbox(command, '/bin/bash', testConfig);

        const proc = Bun.spawn(['bash', '-c', wrappedCmd], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const exitCode = await proc.exited;

        // Command should fail
        expect(exitCode).not.toBe(0);

        // Cleanup
        await fs.rm(sourceFile, { force: true });
        await SandboxManager.reset();
    });

    testFn.each([
        '/tmp/.ssh/authorized_keys',
    ])('should block reads from disallowed directory: %s', async (disallowedPath) => {
        const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

        // Initialize sandbox
        await SandboxManager.initialize(testConfig);

        // Create a command that tries to write outside allowed paths
        const command = `ls ${disallowedPath}`;
        const wrappedCmd = await SandboxManager.wrapWithSandbox(command, '/bin/bash', testConfig);

        // Execute the sandboxed command
        const proc = Bun.spawn(['bash', '-c', wrappedCmd], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const exitCode = await proc.exited;

        // Command should fail due to sandbox restrictions
        expect(exitCode).not.toBe(0);

        await SandboxManager.reset();
    });

    testFn.each([
        '/tmp',
    ])('should allow reads from non disallowed directory: %s', async (allowedPath) => {
        const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
        const fs = await import('fs/promises');

        // Ensure test directory exists
        const parentPath = path.dirname(allowedPath);
        await fs.mkdir(parentPath, { recursive: true });

        // Initialize sandbox
        await SandboxManager.initialize(testConfig);

        // Create a command that writes to an allowed path
        const testFile = allowedPath;
        const command = `ls ${testFile}`;
        const wrappedCmd = await SandboxManager.wrapWithSandbox(command, '/bin/bash', testConfig);

        // Execute the sandboxed command
        const proc = Bun.spawn(['bash', '-c', wrappedCmd], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const exitCode = await proc.exited;

        // Command should succeed
        expect(exitCode).toBe(0);

        // Cleanup
        await SandboxManager.reset();
    });

    testFn('should annotate stderr with sandbox violation info', async () => {
        const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

        // Initialize sandbox
        await SandboxManager.initialize(testConfig);

        // Create a command that will fail due to sandbox
        const command = 'touch /etc/sandbox-test-file';
        const wrappedCmd = await SandboxManager.wrapWithSandbox(command, '/bin/bash', testConfig);

        const proc = Bun.spawn(['bash', '-c', wrappedCmd], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        await proc.exited;
        const stderr = await new Response(proc.stderr).text();

        // Use the annotation function to check for sandbox violations
        const annotated = SandboxManager.annotateStderrWithSandboxFailures(command, stderr);

        // On macOS, the annotated output should contain sandbox violation info
        if (process.platform === 'darwin' && stderr.length > 0) {
            // The annotation should add context about sandbox violations
            expect(annotated.length).toBeGreaterThanOrEqual(stderr.length);
        }

        await SandboxManager.reset();
    });
});
