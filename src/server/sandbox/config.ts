/**
 * Sandbox configuration types and defaults.
 *
 * The sandbox uses @anthropic-ai/sandbox-runtime which provides:
 * - macOS: Apple Seatbelt (sandbox-exec)
 * - Linux: bubblewrap (bwrap)
 * - Windows: Not supported (falls back to confirmation-based security)
 */

import os from 'os';
import path from 'path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

/**
 * User-configurable sandbox settings stored in the database.
 */
export interface SandboxConfig {
    enabled: boolean;
    allowedWritePaths: string[];
    deniedWritePaths: string[];
    deniedReadPaths: string[];
    allowedDomains: string[];
    allowLocalBinding: boolean;
}

/**
 * Default sensitive paths that require confirmation for reads.
 * Derived from the existing isSensitivePath() patterns in path-validator.ts
 *
 * Pattern types:
 * - Tilde prefix (~): expanded to home directory
 * - Slash prefix (/): absolute path matching
 * - Glob prefix (double-star-slash): match directory anywhere in path
 * - No prefix: matches against filename
 */
export const DEFAULT_DENIED_READ_PATHS: string[] = [
    // SSH and security keys - match anywhere using **/ prefix
    '**/.ssh',
    '**/.gnupg',
    '**/.gpg',
    // Cloud credentials - match anywhere
    '**/.aws',
    '**/.azure',
    '**/.gcloud',
    // Package manager credentials - match as filenames
    '.npmrc',
    '.yarnrc',
    '.pypirc',
    '.netrc',
    // Docker config - specific path
    '~/.docker/config.json',
    // Password stores - match anywhere
    '**/.password-store',
    '~/.local/share/keyrings',
    // Shell history - match as filenames
    '.bash_history',
    '.zsh_history',
    '.history',
    // Environment files (match anywhere)
    '.env',
    // System directories
    '/etc',
    '/var/log',
    '/private/etc',  // macOS
    '/private/var',  // macOS
];

/**
 * Default paths that are always denied for writes.
 */
export const DEFAULT_DENIED_WRITE_PATHS: string[] = [
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.azure',
    '~/.gcloud',
    '/etc',
    '/var',
    '/private/etc',
    '/private/var',
];

/**
 * Default paths that are allowed for writes.
 * Note: We use /tmp/pipali explicitly rather than os.tmpdir() because
 * on macOS os.tmpdir() returns /var/folders/... which is a symlink.
 */
export const DEFAULT_ALLOWED_WRITE_PATHS: string[] = [
    '/tmp/pipali',
    '~/.pipali',
];

/**
 * Get the default sandbox configuration.
 * Called when no settings exist in the database.
 */
/**
 * Default allowed network domains for common development use cases.
 */
export const DEFAULT_ALLOWED_DOMAINS: string[] = [
    // Common package registries
    'npmjs.org',
    '*.npmjs.org',
    'registry.npmjs.org',
    'pypi.org',
    '*.pypi.org',
    'rubygems.org',
    'crates.io',
    // GitHub
    'github.com',
    '*.github.com',
    'api.github.com',
    'raw.githubusercontent.com',
    '*.githubusercontent.com',
    // Common cloud APIs
    'api.anthropic.com',
    'api.openai.com',
    'generativelanguage.googleapis.com',
    // General purpose
    'localhost',
];

export function getDefaultConfig(): SandboxConfig {
    return {
        enabled: true,
        allowedWritePaths: DEFAULT_ALLOWED_WRITE_PATHS,
        deniedWritePaths: DEFAULT_DENIED_WRITE_PATHS,
        deniedReadPaths: DEFAULT_DENIED_READ_PATHS,
        allowedDomains: DEFAULT_ALLOWED_DOMAINS,
        allowLocalBinding: true,
    };
}

/**
 * Expand ~ to home directory in a path.
 */
export function expandPath(inputPath: string): string {
    if (inputPath.startsWith('~/')) {
        return path.join(os.homedir(), inputPath.slice(2));
    }
    if (inputPath === '~') {
        return os.homedir();
    }
    return inputPath;
}

/**
 * Expand paths in an array
 */
export function expandPaths(paths: string[]): string[] {
    return paths.map(expandPath);
}

/**
 * Build the SandboxRuntimeConfig for @anthropic-ai/sandbox-runtime
 * from our user-friendly SandboxConfig.
 */
export function buildRuntimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
    // Expand all paths
    const allowedWritePaths = expandPaths(config.allowedWritePaths);
    const deniedWritePaths = expandPaths(config.deniedWritePaths);
    const deniedReadPaths = expandPaths(config.deniedReadPaths);

    return {
        filesystem: {
            // Deny list for reads - these paths are blocked from reading
            denyRead: deniedReadPaths,
            // Allow list for writes - only these paths can be written to
            allowWrite: allowedWritePaths,
            // Deny list for writes - blocked even if within allowed paths
            denyWrite: deniedWritePaths,
            // Allow reading git config for git operations
            allowGitConfig: true,
        },
        network: {
            allowedDomains: config.allowedDomains,
            deniedDomains: [],
            allowLocalBinding: config.allowLocalBinding,
            allowAllUnixSockets: true,  // Allow Unix sockets for local services
        },
    };
}
