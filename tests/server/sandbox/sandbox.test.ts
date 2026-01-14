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
    expandPath,
    expandPaths,
    buildRuntimeConfig,
    DEFAULT_ALLOWED_WRITE_PATHS,
    DEFAULT_DENIED_WRITE_PATHS,
    DEFAULT_DENIED_READ_PATHS,
    DEFAULT_ALLOWED_DOMAINS,
    type SandboxConfig,
} from '../../../src/server/sandbox/config';

describe('Sandbox Config', () => {
    describe('getDefaultConfig', () => {
        test('should return valid default configuration', () => {
            const config = getDefaultConfig();

            expect(config.enabled).toBe(true);
            expect(config.allowedWritePaths).toEqual(DEFAULT_ALLOWED_WRITE_PATHS);
            expect(config.deniedWritePaths).toEqual(DEFAULT_DENIED_WRITE_PATHS);
            expect(config.deniedReadPaths).toEqual(DEFAULT_DENIED_READ_PATHS);
            expect(config.allowedDomains).toEqual(DEFAULT_ALLOWED_DOMAINS);
            expect(config.allowLocalBinding).toBe(true);
        });

        test('should have /tmp/pipali and ~/.pipali as default allowed write paths', () => {
            const config = getDefaultConfig();

            expect(config.allowedWritePaths).toContain('/tmp/pipali');
            expect(config.allowedWritePaths).toContain('~/.pipali');
            // Should NOT include os.tmpdir() which could be /var/folders/... on macOS
            expect(config.allowedWritePaths).not.toContain(os.tmpdir());
        });

        test('should have sensitive paths in denied write paths', () => {
            const config = getDefaultConfig();

            expect(config.deniedWritePaths).toContain('~/.ssh');
            expect(config.deniedWritePaths).toContain('~/.gnupg');
            expect(config.deniedWritePaths).toContain('~/.aws');
            expect(config.deniedWritePaths).toContain('/etc');
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
                allowedWritePaths: ['/tmp/pipali', '~/.pipali'],
                deniedWritePaths: ['~/.ssh'],
                deniedReadPaths: ['~/.aws', '.env'],
                allowedDomains: ['github.com'],
                allowLocalBinding: true,
            };

            const runtimeConfig = buildRuntimeConfig(config);

            // Filesystem config
            expect(runtimeConfig.filesystem.allowWrite).toContain('/tmp/pipali');
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
});

