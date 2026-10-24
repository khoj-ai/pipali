/**
 * Sandbox configuration types and defaults.
 *
 * The sandbox uses @anthropic-ai/sandbox-runtime which provides:
 * - macOS: Apple Seatbelt (sandbox-exec)
 * - Linux: bubblewrap (bwrap)
 * - Windows: a dedicated sandbox account behind a network filter (srt-win)
 */

import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import { VENDORED_SRT_WIN_EXE, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { expandPaths } from '../utils';

/**
 * Get the macOS user-specific temp directory.
 * On macOS, this returns the per-user temp directory (/var/folders/XX/HASH/T/).
 * Programs like Python's xcrun use this for caching and need write access.
 * Returns null on non-macOS platforms or if the command fails.
 */
function getMacOSUserTempDir(): string | null {
    if (process.platform !== 'darwin') {
        return null;
    }
    try {
        // Get the temp dir and resolve symlinks (e.g., /var -> /private/var)
        const tempDir = execSync('realpath "$(getconf DARWIN_USER_TEMP_DIR)"', { encoding: 'utf-8' }).trim();
        return tempDir || null;
    } catch {
        return null;
    }
}

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
    // SSH and security keys - match anywhere (enforces only on macOS)
    '**/.ssh',
    '**/.gnupg',
    '**/.gpg',
    // SSH and security keys - match specific paths (enforces on Linux too)
    '~/.ssh',
    '~/.gnupg',
    '~/.gpg',
    // Cloud credentials - match anywhere (enforces only on macOS)
    '**/.aws',
    '**/.azure',
    '**/.gcloud',
    // Cloud credentials - match specific paths (enforces on Linux too)
    '~/.aws',
    '~/.azure',
    '~/.gcloud',
    '~/.config/gcloud',
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
    '/private/var/log',  // macOS (not /private/var — it contains $TMPDIR on macOS)
];

/**
 * Credentials and history Windows keeps where the shared list does not look.
 */
const WINDOWS_DENIED_READ_PATHS: string[] = [
    // PowerShell command history
    '~/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine',
    // gcloud keeps its credentials here on Windows, not in ~/.config/gcloud
    '~/AppData/Roaming/gcloud',
    // curl and git read credentials from _netrc on Windows
    '_netrc',
];

/**
 * Paths re-allowed for reading inside the denied system directories above.
 * All hold Apple-shipped public configuration, no secrets.
 *
 * - ssl: macOS curl links against LibreSSL, which unconditionally fopen()s
 *   /private/etc/ssl/openssl.cnf during crypto init — even for plain HTTP, and
 *   before OPENSSL_CONF is consulted, so no env var can redirect it. Denying
 *   /private/etc therefore breaks every curl invocation.
 * - localtime: the symlink naming the system timezone. Unreadable, libc and ICU
 *   both fall back to UTC and every timestamp a command prints is wrong. TZ
 *   (see getSandboxEnvOverrides) covers most tools; this covers the rest.
 */
export const DEFAULT_ALLOWED_READ_PATHS: string[] = [
    '/etc/ssl',
    '/private/etc/ssl',  // macOS: /etc is a symlink to /private/etc
    '/etc/localtime',
    '/private/etc/localtime',
];

/**
 * Default paths that are always denied for writes within allowed paths.
 * Note: The sandbox-runtime already auto-protects many sensitive files
 * (.bashrc, .git/hooks, etc.), this list can be used for additional protection.
 */
export const DEFAULT_DENIED_WRITE_PATHS: string[] = [];

/**
 * Default paths that are allowed for writes.
 * Note: We include /tmp (and /private/tmp on macOS since /tmp is a symlink)
 * because bash needs it for heredoc temp files and many tools use it for
 * scratch space. This is safe as /tmp is cleared on reboot and doesn't
 * contain sensitive user data.
 */
export const DEFAULT_ALLOWED_WRITE_PATHS: string[] = [
    '/tmp',
    '/private/tmp',  // macOS: /tmp is a symlink to /private/tmp
    '~/.pipali',
];

/**
 * Get platform-specific temp directories that should always be writable.
 * These paths are added dynamically and should not be stored in the database.
 */
export function getPlatformTempDirs(): string[] {
    const paths: string[] = [];
    const macTempDir = getMacOSUserTempDir();
    if (macTempDir) {
        paths.push(macTempDir);
    }
    return paths;
}

/**
 * Where sandboxed commands write scratch files. Windows has no /tmp, and the sandbox
 * account's own TEMP is out of the user's reach, so it gets a folder in the user's.
 */
export function getSandboxTempDir(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32' ? path.join(os.tmpdir(), 'pipali') : '/tmp/pipali';
}

/**
 * Get allowed write paths including platform-specific temp directories.
 */
function getAllowedWritePaths(platform: NodeJS.Platform): string[] {
    if (platform === 'win32') {
        return ['~/.pipali', getSandboxTempDir(platform)];
    }
    return [...DEFAULT_ALLOWED_WRITE_PATHS, ...getPlatformTempDirs()];
}

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
    'files.pythonhosted.org',
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

/**
 * Get the default sandbox configuration.
 * Called when no settings exist in the database.
 */
export function getDefaultConfig(platform: NodeJS.Platform = process.platform): SandboxConfig {
    return {
        enabled: true,
        allowedWritePaths: getAllowedWritePaths(platform),
        deniedWritePaths: DEFAULT_DENIED_WRITE_PATHS,
        deniedReadPaths: platform === 'win32'
            ? [...DEFAULT_DENIED_READ_PATHS, ...WINDOWS_DENIED_READ_PATHS]
            : DEFAULT_DENIED_READ_PATHS,
        allowedDomains: DEFAULT_ALLOWED_DOMAINS,
        allowLocalBinding: true,
    };
}

/**
 * Build the SandboxRuntimeConfig for @anthropic-ai/sandbox-runtime
 * from our user-friendly SandboxConfig.
 */
export function buildRuntimeConfig(
    config: SandboxConfig,
    platform: NodeJS.Platform = process.platform
): SandboxRuntimeConfig {
    if (platform === 'win32') {
        return buildWindowsRuntimeConfig(config);
    }

    // Expand all paths
    const allowedWritePaths = expandPaths(config.allowedWritePaths);
    const deniedWritePaths = expandPaths(config.deniedWritePaths);
    const deniedReadPaths = expandPaths(config.deniedReadPaths);

    // macOS: /etc is a symlink to /private/etc. Denying the symlink itself blocks
    // traversal through it, making the carve-outs below unreachable by their
    // canonical /etc/... spelling. Denying only the real path protects the same
    // contents, since Seatbelt resolves symlinks before matching rules.
    const profileDeniedReadPaths = process.platform === 'darwin'
        ? deniedReadPaths.filter(p => p !== '/etc')
        : deniedReadPaths;

    return {
        filesystem: {
            // Deny list for reads - these paths are blocked from reading
            denyRead: profileDeniedReadPaths,
            // Carve-outs within denied paths - these take precedence over denyRead
            allowRead: expandPaths(DEFAULT_ALLOWED_READ_PATHS),
            // Allow list for writes - only these paths can be written to
            allowWrite: allowedWritePaths,
            // Deny list for writes - blocked even if within allowed paths
            denyWrite: deniedWritePaths,
            // Allow reading git config for git operations
            allowGitConfig: true,
        },
        network: {
            allowedDomains: config.allowedDomains,
            allowMachLookup: ['com.apple.metadata.mds'],
            deniedDomains: [],
            allowLocalBinding: config.allowLocalBinding,
            allowAllUnixSockets: true,  // Allow Unix sockets for local services
        },
    };
}

/**
 * The runtime config for Windows, where commands run as a separate sandbox account.
 *
 * That account reads what every local user can, and the user's profile minus its credential
 * stores once the one-time setup grants it, for the broad reads macOS and Linux allow. The
 * bundled runtimes are granted for the shell to run. Denies become ACLs, which need a
 * concrete path, so a name pattern guards the copy in the home folder.
 */
function buildWindowsRuntimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
    const bundledRuntimesDir = process.env.PIPALI_BUNDLED_RUNTIMES_DIR;
    return {
        filesystem: {
            allowRead: bundledRuntimesDir ? [bundledRuntimesDir] : [],
            allowWrite: expandPaths(config.allowedWritePaths),
            denyRead: toWindowsDenyPaths(config.deniedReadPaths),
            denyWrite: expandPaths(config.deniedWritePaths),
        },
        network: {
            allowedDomains: config.allowedDomains,
            deniedDomains: [],
            allowLocalBinding: config.allowLocalBinding,
        },
        windows: {
            srtWin: { path: VENDORED_SRT_WIN_EXE },
        },
    };
}

function toWindowsDenyPaths(deniedPaths: string[]): string[] {
    const home = os.homedir();
    const paths = deniedPaths.map(p => {
        if (p.startsWith('**/')) return path.join(home, p.slice(3));
        if (/^~([\\/]|$)/.test(p)) return path.join(home, p.slice(1));
        if (path.isAbsolute(p)) return p;
        return path.join(home, p);
    });
    return [...new Set(paths)];
}
