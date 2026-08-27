/**
 * Sandbox module for secure shell command execution.
 *
 * Uses @anthropic-ai/sandbox-runtime to provide OS-enforced sandboxing:
 * - macOS: Apple Seatbelt (sandbox-exec)
 * - Linux: bubblewrap (bwrap)
 * - Windows: Not supported (falls back to confirmation-based security)
 *
 * This module provides:
 * 1. Sandboxed shell command execution (skips confirmation when sandboxed)
 * 2. Path validation for file operations (skip confirmation for allowed paths)
 */

import path from 'path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createChildLogger } from '../logger';

import {
    type SandboxConfig,
    DEFAULT_ALLOWED_READ_PATHS,
    getDefaultConfig,
    buildRuntimeConfig,
} from './config';
import { expandPath } from '../utils';
import { loadSandboxSettings, saveSandboxSettings, ensureSandboxSettings } from './settings';

const log = createChildLogger({ component: 'sandbox' });

// Current sandbox configuration (loaded from database)
let currentConfig: SandboxConfig = getDefaultConfig();

// Whether sandbox has been initialized
let initialized = false;

// Default user ID (we're single-user for now)
const DEFAULT_USER_ID = 1;

/**
 * Initialize the sandbox runtime.
 * Should be called once on server startup.
 *
 * Set PIPALI_SANDBOX_DISABLED=true to disable sandbox (useful for testing).
 */
export async function initializeSandbox(): Promise<void> {
    try {
        // Check if sandbox is disabled via environment variable (for testing)
        if (process.env.PIPALI_SANDBOX_DISABLED === 'true') {
            log.info('Sandbox disabled via PIPALI_SANDBOX_DISABLED environment variable');
            currentConfig = { ...getDefaultConfig(), enabled: false };
            initialized = true;
            return;
        }

        // Load settings from database (or create defaults)
        currentConfig = await ensureSandboxSettings(DEFAULT_USER_ID);

        // Check if sandboxing is supported on this platform
        const supported = SandboxManager.isSupportedPlatform();

        if (!supported) {
            log.info(`Sandbox not supported on ${process.platform}, will use confirmation-based security`);
            initialized = true;
            return;
        }

        if (!currentConfig.enabled) {
            log.info('Sandbox disabled by user settings');
            initialized = true;
            return;
        }

        // Set CLAUDE_TMPDIR so sandbox-runtime uses /tmp/pipali instead of /tmp/claude
        // This must be set before SandboxManager.initialize() as it reads from process.env
        process.env.CLAUDE_TMPDIR = '/tmp/pipali';

        // Build runtime configuration
        const runtimeConfig = buildRuntimeConfig(currentConfig);

        // Initialize the sandbox manager
        await SandboxManager.initialize(runtimeConfig);

        // Check dependencies
        const hasDepends = SandboxManager.checkDependencies();
        if (!hasDepends) {
            log.warn('Sandbox dependencies not fully available, sandboxing may be limited');
        }

        log.info({
            platform: process.platform,
            hasDepends,
            allowWrite: runtimeConfig.filesystem.allowWrite,
        }, 'Sandbox initialized');
        initialized = true;
    } catch (error) {
        log.error({ err: error }, 'Failed to initialize sandbox');
        // Don't fail server startup, just disable sandboxing
        initialized = true;
    }
}

/**
 * Initialize sandbox with a given config, bypassing the database.
 * Used in integration tests where the DB is not available.
 */
export async function initializeSandboxWithConfig(config: SandboxConfig): Promise<void> {
    currentConfig = config;
    if (!isSandboxSupported() || !config.enabled) {
        initialized = true;
        return;
    }
    try {
        process.env.CLAUDE_TMPDIR = '/tmp/pipali';
        const runtimeConfig = buildRuntimeConfig(config);
        await SandboxManager.initialize(runtimeConfig);
        initialized = true;
    } catch (error) {
        log.error({ err: error }, 'Failed to initialize sandbox with config');
        initialized = true;
    }
}

/**
 * Shutdown the sandbox runtime.
 * Should be called on server shutdown.
 */
export async function shutdownSandbox(): Promise<void> {
    try {
        await SandboxManager.reset();
        initialized = false;
        log.info('Sandbox shutdown complete');
    } catch (error) {
        log.error({ err: error }, 'Error during sandbox shutdown');
    }
}

/**
 * Reload sandbox configuration from database.
 * Call this after settings are updated.
 */
export async function reloadSandboxConfig(): Promise<void> {
    currentConfig = await loadSandboxSettings(DEFAULT_USER_ID);

    if (!currentConfig.enabled) {
        log.info('Sandbox disabled after config reload');
        return;
    }

    if (!SandboxManager.isSupportedPlatform()) {
        return;
    }

    // Update the sandbox manager with new config
    const runtimeConfig = buildRuntimeConfig(currentConfig);
    SandboxManager.updateConfig(runtimeConfig);
    log.info('Sandbox configuration reloaded');
}

/**
 * Check if sandbox mode is enabled.
 */
export function isSandboxEnabled(): boolean {
    return currentConfig.enabled;
}

/**
 * Check if sandboxing is supported on this platform.
 */
export function isSandboxSupported(): boolean {
    return SandboxManager.isSupportedPlatform();
}

/**
 * Check if sandboxing is currently active (enabled AND supported).
 */
export function isSandboxActive(): boolean {
    return initialized && isSandboxEnabled() && isSandboxSupported();
}

/**
 * Wrap a shell command with sandbox restrictions.
 * Returns the sandboxed command string to execute.
 *
 * @param command - The command to wrap
 * @returns The sandboxed command string
 */
export async function wrapCommandWithSandbox(command: string): Promise<string> {
    if (!isSandboxActive()) {
        // Return original command if sandbox not active
        return command;
    }

    try {
        const runtimeConfig = buildRuntimeConfig(currentConfig);

        // Wrap the command with sandbox restrictions
        const sandboxedCommand = await SandboxManager.wrapWithSandbox(
            command,
            '/bin/bash',
            runtimeConfig
        );

        log.debug({ command: command.substring(0, 100) }, 'Command wrapped with sandbox');

        // Fix shell-quote over-escaping: when the command contains single quotes,
        // shell-quote falls back to double-quote wrapping and escapes ! to \!
        // (for interactive bash history expansion). But sandbox-exec runs bash -c
        // non-interactively, so history expansion is disabled and the backslash
        // leaks through as a literal character, breaking scripts (e.g. Python's !=).
        // This is safe: ! is the only char where shell-quote's escaping diverges
        // from non-interactive bash behavior (\$ and \` are correctly consumed).
        return sandboxedCommand.replace(/\\!/g, '!');
    } catch (error) {
        log.error({ err: error }, 'Failed to wrap command with sandbox');
        // Return original command on error
        return command;
    }
}

/**
 * Check if a path is within a directory (not just starts with the same prefix).
 * e.g., '/tmp/pipali/file.txt' is within '/tmp/pipali', but '/tmp/pipali-fake' is not.
 */
function isPathWithinDirectory(testPath: string, directory: string): boolean {
    // Ensure directory path ends with separator for proper matching
    const dirWithSep = directory.endsWith(path.sep) ? directory : directory + path.sep;
    return testPath === directory || testPath.startsWith(dirWithSep);
}

/**
 * Check if a path is within the allowed write directories.
 * Used by write_file and edit_file actors to skip confirmation.
 *
 * @param absolutePath - The absolute path to check
 * @returns true if the path is allowed for writing
 */
export function isPathWithinAllowedWrite(absolutePath: string): boolean {
    // Normalize the path
    const normalizedPath = path.normalize(absolutePath);

    // Check if path is in denied write paths (these always require confirmation)
    for (const deniedPath of currentConfig.deniedWritePaths) {
        const expandedDenied = expandPath(deniedPath);
        if (isPathWithinDirectory(normalizedPath, expandedDenied)) {
            return false;
        }
    }

    // Check if path is within allowed write paths
    for (const allowedPath of currentConfig.allowedWritePaths) {
        const expandedAllowed = expandPath(allowedPath);
        if (isPathWithinDirectory(normalizedPath, expandedAllowed)) {
            return true;
        }
    }

    return false;
}

/**
 * Check if a path is denied for reading (requires confirmation).
 * Used by read_file actor.
 *
 * @param absolutePath - The absolute path to check
 * @returns true if the path requires confirmation for reading
 */
export function isPathDeniedForRead(absolutePath: string): boolean {
    // Normalize the path
    const normalizedPath = path.normalize(absolutePath);

    // Carve-outs take precedence over the deny list, matching the sandbox profile
    for (const allowedPath of DEFAULT_ALLOWED_READ_PATHS) {
        if (isPathWithinDirectory(normalizedPath, expandPath(allowedPath))) {
            return false;
        }
    }

    for (const deniedPath of currentConfig.deniedReadPaths) {
        // Handle **/ prefix - match directory anywhere in path
        if (deniedPath.startsWith('**/')) {
            const dirName = deniedPath.slice(3); // Remove **/ prefix
            // Match /.dirname/ or /.dirname at end of path
            if (
                normalizedPath.includes(`/${dirName}/`) ||
                normalizedPath.endsWith(`/${dirName}`)
            ) {
                return true;
            }
            continue;
        }

        // Handle ~ and / prefixed paths (absolute paths)
        if (deniedPath.startsWith('/') || deniedPath.startsWith('~')) {
            const expandedDenied = expandPath(deniedPath);
            if (isPathWithinDirectory(normalizedPath, expandedDenied)) {
                return true;
            }
            continue;
        }

        // Handle filename patterns (no prefix - match basename)
        const basename = path.basename(normalizedPath);

        // Exact filename match
        if (basename === deniedPath) {
            return true;
        }

        // Special handling for .env - match .env.* variants but NOT .envrc
        if (deniedPath === '.env' && basename.match(/^\.env(\.[a-zA-Z]+)?$/)) {
            return true;
        }

        // Check if it's a directory in the path (e.g., /project/.env/something)
        if (normalizedPath.includes(`/${deniedPath}/`)) {
            return true;
        }
    }

    return false;
}

/**
 * Get the current sandbox configuration.
 */
export function getSandboxConfig(): SandboxConfig {
    return { ...currentConfig };
}

/**
 * Update sandbox settings and reload configuration.
 * @param config - Partial config to update
 */
export async function updateSandboxConfig(config: Partial<SandboxConfig>): Promise<void> {
    await saveSandboxSettings(DEFAULT_USER_ID, config);
    await reloadSandboxConfig();
}

/**
 * Annotate stderr with sandbox failure information.
 * Uses the sandbox-runtime's built-in violation detection on macOS.
 *
 * @param command - The command that was executed
 * @param stderr - The stderr output from the command
 * @returns The annotated stderr with sandbox failure information
 */
export function annotateStderrWithSandboxFailures(command: string, stderr: string): string {
    if (!isSandboxActive()) {
        return stderr;
    }

    try {
        return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
    } catch (error) {
        log.error({ err: error }, 'Failed to annotate stderr with sandbox failures');
        return stderr;
    }
}

/**
 * Sandbox temp directory path.
 * Used for TMPDIR and tool cache environment variables.
 */
export const SANDBOX_TEMP_DIR = '/tmp/pipali';

/**
 * Resolve the host's IANA timezone, or '' if it can't be determined.
 *
 * Sandboxed commands cannot read the /etc/localtime symlink, which is how both
 * libc and ICU discover the system zone, so they silently report UTC. Naming the
 * zone in TZ fixes that: the rules under /var/db/timezone/zoneinfo are readable,
 * only the pointer to them is not.
 *
 * Returns '' when resolution fails or already yields UTC — pinning a zone we could
 * not determine would turn a known-UTC reading into a confidently wrong one.
 */
export function resolveHostTimezone(): string {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return zone && zone !== 'UTC' ? zone : '';
    } catch {
        return '';
    }
}

// The server process is never sandboxed, so this resolves correctly. Cached because
// the host zone doesn't change under us and every command would otherwise re-resolve.
const HOST_TIMEZONE = resolveHostTimezone();

/**
 * Get environment variables that redirect tool caches to sandbox-allowed directories.
 * These should be merged with process.env when running sandboxed commands.
 *
 * This ensures tools like uv, pip, npm, etc. write their caches to allowed paths
 * instead of ~/.cache which isn't in the sandbox allowlist.
 */
export function getSandboxEnvOverrides(): Record<string, string> {
    // An explicit TZ wins; we only supply the zone the sandbox can't discover itself.
    // Forwarding it rather than omitting it also sidesteps Bun marking a TZ assigned at
    // runtime non-enumerable, which would silently drop it from the caller's spread.
    const timezone = process.env.TZ || HOST_TIMEZONE;

    return {
        // General temp directory
        TMPDIR: SANDBOX_TEMP_DIR,

        // Timezone - without this, /etc/localtime is unreadable and commands report UTC
        ...(timezone ? { TZ: timezone } : {}),

        // Git - skip /etc/gitconfig which is denied by sandbox read restrictions
        GIT_CONFIG_NOSYSTEM: '1',

        // Python/Uv - redirect cache, tool installs, and data to /tmp/pipali instead of ~/
        UV_CACHE_DIR: `${SANDBOX_TEMP_DIR}/uv-cache`,
        UV_TOOL_DIR: `${SANDBOX_TEMP_DIR}/uv-tools`,
        UV_TOOL_BIN_DIR: `${SANDBOX_TEMP_DIR}/uv-tools/bin`,
        UV_PYTHON_INSTALL_DIR: `${SANDBOX_TEMP_DIR}/uv-python`,
        PIP_CACHE_DIR: `${SANDBOX_TEMP_DIR}/pip-cache`,

        // Node/Bun caches
        npm_config_cache: `${SANDBOX_TEMP_DIR}/npm-cache`,
        BUN_INSTALL_CACHE_DIR: `${SANDBOX_TEMP_DIR}/bun-cache`,
    };
}

/**
 * Get the set of default paths managed by the system.
 * Used by the settings UI to hide system paths and only show user-added ones.
 */
export function getDefaultPaths() {
    const defaults = getDefaultConfig();
    return {
        allowedWritePaths: defaults.allowedWritePaths,
        deniedReadPaths: defaults.deniedReadPaths,
    };
}

// Re-export types and settings functions
export type { SandboxConfig };
export { getDefaultConfig } from './config';
export { loadSandboxSettings, saveSandboxSettings } from './settings';
