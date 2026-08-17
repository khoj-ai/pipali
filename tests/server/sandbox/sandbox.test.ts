/**
 * Sandbox Module Unit Tests
 *
 * Tests for the sandbox configuration, path validation, and runtime behavior.
 */

import { test, expect, describe } from 'bun:test';
import os from 'os';
import path from 'path';
import {
    getDefaultConfig,
    buildRuntimeConfig,
    DEFAULT_ALLOWED_WRITE_PATHS,
    DEFAULT_DENIED_READ_PATHS,
    DEFAULT_ALLOWED_DOMAINS,
    type SandboxConfig,
} from '../../../src/server/sandbox/config';
import {
    getSandboxEnvOverrides,
    isPathDeniedForRead,
    resolveHostTimezone,
    SANDBOX_TEMP_DIR,
} from '../../../src/server/sandbox';
import { expandPath, expandPaths } from '../../../src/server/utils';

describe('Sandbox Config', () => {
    describe('getDefaultConfig', () => {
        test('should return valid default configuration', () => {
            const config = getDefaultConfig();

            expect(config.enabled).toBe(true);
            // allowedWritePaths may include platform-specific paths (e.g., macOS user temp dir)
            for (const p of DEFAULT_ALLOWED_WRITE_PATHS) {
                expect(config.allowedWritePaths).toContain(p);
            }
            expect(config.deniedReadPaths).toEqual(DEFAULT_DENIED_READ_PATHS);
            expect(config.allowedDomains).toEqual(DEFAULT_ALLOWED_DOMAINS);
            expect(config.allowLocalBinding).toBe(true);
        });

        test('should have /tmp, /private/tmp, and ~/.pipali as default allowed write paths', () => {
            const config = getDefaultConfig();

            expect(config.allowedWritePaths).toContain('/tmp');
            expect(config.allowedWritePaths).toContain('/private/tmp');
            expect(config.allowedWritePaths).toContain('~/.pipali');
            // On macOS, should also include the user's temp dir (/private/var/folders/.../T/)
            // to allow tools like Python's xcrun to write cache files
            // Note: Uses /private/var because /var is a symlink and sandbox-exec needs real paths
            if (process.platform === 'darwin') {
                const hasMacTempDir = config.allowedWritePaths.some(p => p.startsWith('/private/var/folders/'));
                expect(hasMacTempDir).toBe(true);
            }
        });

        test('should have sensitive paths in denied read paths', () => {
            const config = getDefaultConfig();

            // Uses **/ prefix for matching directories anywhere
            expect(config.deniedReadPaths).toContain('**/.ssh');
            expect(config.deniedReadPaths).toContain('**/.aws');
            expect(config.deniedReadPaths).toContain('.env');
            expect(config.deniedReadPaths).toContain('/etc');
        });

        test('should have valid network domains (not wildcard *)', () => {
            const config = getDefaultConfig();

            // Should NOT contain just '*' which sandbox-runtime rejects
            expect(config.allowedDomains).not.toContain('*');

            // Should contain specific domains
            expect(config.allowedDomains).toContain('github.com');
            expect(config.allowedDomains).toContain('npmjs.org');
            expect(config.allowedDomains).toContain('localhost');
        });
    });

    describe('expandPath', () => {
        test('should expand ~ to home directory', () => {
            const expanded = expandPath('~/.pipali');
            expect(expanded).toBe(path.join(os.homedir(), '.pipali'));
        });

        test('should expand standalone ~', () => {
            const expanded = expandPath('~');
            expect(expanded).toBe(os.homedir());
        });

        test('should not modify absolute paths', () => {
            const expanded = expandPath('/tmp/pipali');
            expect(expanded).toBe('/tmp/pipali');
        });

        test('should not modify relative paths without ~', () => {
            const expanded = expandPath('.env');
            expect(expanded).toBe('.env');
        });
    });

    describe('expandPaths', () => {
        test('should expand array of paths', () => {
            const paths = ['~/.pipali', '/tmp/pipali', '~/.ssh'];
            const expanded = expandPaths(paths);

            expect(expanded).toEqual([
                path.join(os.homedir(), '.pipali'),
                '/tmp/pipali',
                path.join(os.homedir(), '.ssh'),
            ]);
        });

        test('should handle empty array', () => {
            const expanded = expandPaths([]);
            expect(expanded).toEqual([]);
        });
    });

    describe('buildRuntimeConfig', () => {
        test('should build valid SandboxRuntimeConfig', () => {
            const config: SandboxConfig = {
                enabled: true,
                allowedWritePaths: ['/tmp', '~/.pipali'],
                deniedWritePaths: ['~/.ssh'],
                deniedReadPaths: ['~/.aws', '.env'],
                allowedDomains: ['github.com'],
                allowLocalBinding: true,
            };

            const runtimeConfig = buildRuntimeConfig(config);

            // Filesystem config
            expect(runtimeConfig.filesystem.allowWrite).toContain('/tmp');
            expect(runtimeConfig.filesystem.allowWrite).toContain(path.join(os.homedir(), '.pipali'));
            expect(runtimeConfig.filesystem.denyWrite).toContain(path.join(os.homedir(), '.ssh'));
            expect(runtimeConfig.filesystem.denyRead).toContain(path.join(os.homedir(), '.aws'));
            expect(runtimeConfig.filesystem.denyRead).toContain('.env');
            expect(runtimeConfig.filesystem.allowGitConfig).toBe(true);

            // Network config
            expect(runtimeConfig.network.allowedDomains).toContain('github.com');
            expect(runtimeConfig.network.deniedDomains).toEqual([]);
            expect(runtimeConfig.network.allowLocalBinding).toBe(true);
            expect(runtimeConfig.network.allowAllUnixSockets).toBe(true);
        });

        test('should expand all tilde paths in config', () => {
            const config: SandboxConfig = {
                enabled: true,
                allowedWritePaths: ['~/.pipali'],
                deniedWritePaths: ['~/.ssh', '~/.gnupg'],
                deniedReadPaths: ['~/.aws'],
                allowedDomains: [],
                allowLocalBinding: false,
            };

            const runtimeConfig = buildRuntimeConfig(config);
            const homeDir = os.homedir();

            // All paths should be expanded
            expect(runtimeConfig.filesystem.allowWrite[0]).toBe(path.join(homeDir, '.pipali'));
            expect(runtimeConfig.filesystem.denyWrite[0]).toBe(path.join(homeDir, '.ssh'));
            expect(runtimeConfig.filesystem.denyWrite[1]).toBe(path.join(homeDir, '.gnupg'));
            expect(runtimeConfig.filesystem.denyRead[0]).toBe(path.join(homeDir, '.aws'));
        });
    });

    describe('isPathDeniedForRead', () => {
        test('should scope the /etc/ssl carve-out to that directory alone', () => {
            expect(isPathDeniedForRead('/etc/ssl/cert.pem')).toBe(false);
            expect(isPathDeniedForRead('/private/etc/ssl/openssl.cnf')).toBe(false);
            // Neighbours and prefix look-alikes stay denied
            expect(isPathDeniedForRead('/etc/sslkeys/private.key')).toBe(true);
            expect(isPathDeniedForRead('/private/etc/sudoers')).toBe(true);
        });
    });

    describe('getSandboxEnvOverrides', () => {
        test('should return environment variables for tool caches', () => {
            const env = getSandboxEnvOverrides();

            // Should set TMPDIR to sandbox temp directory
            expect(env.TMPDIR).toBe(SANDBOX_TEMP_DIR);

            // Should skip system git config (blocked by /etc deny rule)
            expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');

            // Should redirect uv/pip caches to /tmp/pipali
            expect(env.UV_CACHE_DIR).toContain(SANDBOX_TEMP_DIR);
            expect(env.PIP_CACHE_DIR).toContain(SANDBOX_TEMP_DIR);

            // Should redirect npm/bun caches
            expect(env.npm_config_cache).toContain(SANDBOX_TEMP_DIR);
            expect(env.BUN_INSTALL_CACHE_DIR).toContain(SANDBOX_TEMP_DIR);
        });

        test('should preserve an explicitly set TZ instead of replacing it with the host zone', () => {
            const original = process.env.TZ;
            const originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            process.env.TZ = 'Asia/Kolkata';
            try {
                // Forwarded, not overridden - and reaches the child env shell_command builds,
                // which a bare spread would miss since Bun hides an assigned TZ from it
                expect(getSandboxEnvOverrides().TZ).toBe('Asia/Kolkata');
                expect({ ...process.env, ...getSandboxEnvOverrides() }.TZ).toBe('Asia/Kolkata');
            } finally {
                // Bun re-inits its clock on assignment but not on delete, so name the old zone
                // before clearing the var - otherwise every later test runs in Kolkata
                process.env.TZ = original ?? originalZone;
                if (original === undefined) delete process.env.TZ;
            }
        });
    });

    describe('resolveHostTimezone', () => {
        test('should report no zone rather than a bogus one when the host resolves UTC or fails', () => {
            const original = Intl.DateTimeFormat;
            try {
                // A UTC host tells us nothing about the real zone, so claim nothing
                Intl.DateTimeFormat = (() => ({ resolvedOptions: () => ({ timeZone: 'UTC' }) })) as never;
                expect(resolveHostTimezone()).toBe('');

                // Same when the platform can't answer at all
                Intl.DateTimeFormat = (() => { throw new Error('no ICU data'); }) as never;
                expect(resolveHostTimezone()).toBe('');
            } finally {
                Intl.DateTimeFormat = original;
            }
        });
    });
});

