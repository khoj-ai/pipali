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

// Platform type matching @anthropic-ai/sandbox-runtime
type Platform = 'macos' | 'linux' | 'windows' | 'unknown';
import {
    type SandboxConfig,
    getDefaultConfig,
    buildRuntimeConfig,
    expandPath,
} from './config';
import { loadSandboxSettings, saveSandboxSettings, ensureSandboxSettings } from './settings';

const log = createChildLogger({ component: 'sandbox' });

// Current sandbox configuration (loaded from database)
let currentConfig: SandboxConfig = getDefaultConfig();

// Whether sandbox has been initialized
let initialized = false;

// Default user ID (we're single-user for now)
const DEFAULT_USER_ID = 1;

/**
 * Map Node.js platform to sandbox-runtime Platform type
 */
function getPlatformType(): Platform {
    switch (process.platform) {
        case 'darwin':
            return 'macos';
        case 'linux':
            return 'linux';
        case 'win32':
            return 'windows';
        default:
            return 'unknown';
    }
}

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
        const platform = getPlatformType();
        const supported = SandboxManager.isSupportedPlatform(platform);

        if (!supported) {
            log.info(`Sandbox not supported on ${platform}, will use confirmation-based security`);
            initialized = true;
            return;
        }

        if (!currentConfig.enabled) {
            log.info('Sandbox disabled by user settings');
            initialized = true;
            return;
        }

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
            platform,
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
 * Shutdown the sandbox runtime.
 * Should be called on server shutdown.
 */
export async function shutdownSandbox(): Promise<void> {
    try {
        await SandboxManager.reset();
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

    const platform = getPlatformType();
    if (!SandboxManager.isSupportedPlatform(platform)) {
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
    const platform = getPlatformType();
    return SandboxManager.isSupportedPlatform(platform);
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

        return sandboxedCommand;
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

// Re-export types and settings functions
export type { SandboxConfig };
export { getDefaultConfig } from './config';
export { loadSandboxSettings, saveSandboxSettings } from './settings';
