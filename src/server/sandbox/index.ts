/**
 * Sandbox module for secure shell command execution.
 *
 * Uses @anthropic-ai/sandbox-runtime to provide OS-enforced sandboxing:
 * - macOS: Apple Seatbelt (sandbox-exec)
 * - Linux: bubblewrap (bwrap)
 * - Windows: a dedicated sandbox account behind a network filter (srt-win), set up once
 *
 * This module provides:
 * 1. Sandboxed shell command execution (skips confirmation when sandboxed)
 * 2. Path validation for file operations (skip confirmation for allowed paths)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    SandboxManager,
    parseWindowsBinShell,
    type FilesystemPathEntry,
    type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import { createChildLogger } from '../logger';

import {
    type SandboxConfig,
    DEFAULT_ALLOWED_READ_PATHS,
    getDefaultConfig,
    getSandboxTempDir,
    buildRuntimeConfig,
} from './config';
import { getBundledRuntimes } from '../bundled-runtimes';
import { expandPath, isCaseInsensitiveFS } from '../utils';
import { loadSandboxSettings, saveSandboxSettings, ensureSandboxSettings } from './settings';

const log = createChildLogger({ component: 'sandbox' });

// Current sandbox configuration (loaded from database)
let currentConfig: SandboxConfig = getDefaultConfig();

// Whether the sandbox runtime finished initializing. Commands only run sandboxed when it did.
let runtimeReady = false;

// Starts and stops of the runtime run one at a time, so overlapping ones cannot leave a
// stale policy in force or tear down a runtime another just started
let runtimeQueue: Promise<void> = Promise.resolve();

// What the running Windows session applied, to tell which changes it can take live
let windowsSession: { runtimeConfig: SandboxRuntimeConfig; filesystemKey: string; denies: string } | undefined;

// Default user ID (we're single-user for now)
const DEFAULT_USER_ID = 1;

/**
 * Start the sandbox runtime on the current config. If it fails to start, commands ask for
 * confirmation instead, so a failure is logged rather than thrown.
 */
async function startRuntime(): Promise<void> {
    runtimeReady = false;
    try {
        // Set CLAUDE_TMPDIR so sandbox-runtime uses /tmp/pipali instead of /tmp/claude
        // This must be set before SandboxManager.initialize() as it reads from process.env.
        // Windows children get no TMPDIR.
        if (process.platform !== 'win32') {
            process.env.CLAUDE_TMPDIR = SANDBOX_TEMP_DIR;
        }

        const runtimeConfig = process.platform === 'win32'
            ? prepareWindowsSession(currentConfig)
            : buildRuntimeConfig(currentConfig);
        await SandboxManager.initialize(runtimeConfig);

        const { warnings } = await SandboxManager.checkDependenciesAsync();
        if (warnings.length > 0) {
            log.warn({ warnings }, 'Sandbox running with degraded dependencies');
        }
        runtimeReady = true;
        log.info({
            platform: process.platform,
            allowWrite: runtimeConfig.filesystem.allowWrite,
        }, 'Sandbox initialized');
    } catch (error) {
        log.error({ err: error }, 'Sandbox failed to start, commands will ask for confirmation');
        // A failed start can leave part of the runtime up. Clear it so the next start begins clean.
        await SandboxManager.reset().catch(err => log.warn({ err }, 'Could not clear the failed sandbox start'));
    }
}

/** Run a start or stop of the runtime once those queued before it are done. */
function queueRuntime(task: () => Promise<void>): Promise<void> {
    const run = runtimeQueue.then(task);
    runtimeQueue = run.catch(() => {});
    return run;
}

/**
 * Restart the runtime on the current config. With `skipIf`, a restart that is no longer
 * needed by the time its turn comes is skipped.
 */
function restartRuntime(skipIf?: () => boolean): Promise<void> {
    return queueRuntime(async () => {
        if (skipIf?.()) return;
        runtimeReady = false;
        await SandboxManager.reset();
        await startRuntime();
    });
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
            return;
        }

        // Load settings from database (or create defaults)
        currentConfig = await ensureSandboxSettings(DEFAULT_USER_ID);

        if (!isSandboxSupported()) {
            log.info(`Sandbox not supported on ${process.platform}, will use confirmation-based security`);
            return;
        }

        if (!currentConfig.enabled) {
            log.info('Sandbox disabled by user settings');
            return;
        }

        await restartRuntime();
    } catch (error) {
        // Don't fail server startup; without a runtime, commands ask for confirmation
        log.error({ err: error }, 'Failed to initialize sandbox');
    }
}

/**
 * Initialize sandbox with a given config, bypassing the database.
 * Used in integration tests where the DB is not available.
 */
export async function initializeSandboxWithConfig(config: SandboxConfig): Promise<void> {
    currentConfig = config;
    if (!isSandboxSupported() || !config.enabled) {
        return;
    }
    await restartRuntime();
}

/**
 * Shutdown the sandbox runtime.
 * Should be called on server shutdown.
 */
export async function shutdownSandbox(): Promise<void> {
    runtimeReady = false;
    try {
        await queueRuntime(async () => {
            runtimeReady = false;
            await SandboxManager.reset();
        });
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

    if (!isSandboxSupported()) {
        return;
    }

    // A runtime that never started, or failed to, has no config to update
    if (!runtimeReady) {
        await restartRuntime();
        return;
    }

    // Update the sandbox manager with new config
    const runtimeConfig = buildRuntimeConfig(currentConfig);
    if (process.platform === 'win32') {
        // Windows applies file access and the loopback mode only as its runtime starts; the
        // domain list swaps live
        if (JSON.stringify(runtimeConfig.filesystem) !== windowsSession?.filesystemKey
            || runtimeConfig.network.allowLocalBinding !== windowsSession.runtimeConfig.network.allowLocalBinding) {
            await restartRuntime();
            return;
        }
        SandboxManager.updateConfig({ ...windowsSession.runtimeConfig, network: runtimeConfig.network });
    } else {
        SandboxManager.updateConfig(runtimeConfig);
    }
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
 * Check if sandboxing is currently active: enabled, supported, and its runtime running.
 */
export function isSandboxActive(): boolean {
    return runtimeReady && isSandboxEnabled() && isSandboxSupported();
}

/**
 * Wrap a shell command with sandbox restrictions.
 * Throws rather than hand back a command that would run outside the sandbox.
 *
 * @param command - The command to wrap
 * @param commandId - Files the run's violations for annotateStderrWithSandboxFailures
 * @returns The sandboxed command string
 */
export async function wrapCommandWithSandbox(command: string, commandId?: string): Promise<string> {
    if (!isSandboxActive()) {
        throw new Error('The sandbox is not running');
    }

    const runtimeConfig = buildRuntimeConfig(currentConfig);
    const sandboxedCommand = await SandboxManager.wrapWithSandbox(
        command, '/bin/bash', runtimeConfig, undefined, { commandId },
    );
    log.debug({ command: command.substring(0, 100) }, 'Command wrapped with sandbox');
    return sandboxedCommand;
}

/** A command ready to spawn inside the sandbox. */
export interface SandboxedCommand {
    cmd: string[];
    env: Record<string, string | undefined>;
}

/**
 * The argv and environment that run a command inside the sandbox, from a working directory.
 * Throws rather than hand back anything that would run outside it.
 */
export async function prepareSandboxedCommand(
    command: string,
    commandId: string,
    cwd: string,
): Promise<SandboxedCommand> {
    if (process.platform === 'win32') {
        return prepareWindowsCommand(command, commandId, cwd);
    }
    return {
        cmd: ['/bin/bash', '-c', await wrapCommandWithSandbox(command, commandId)],
        // Redirect tool caches to paths the sandbox lets them write
        env: { ...process.env, ...getSandboxEnvOverrides() },
    };
}

/**
 * Windows runs the command as its sandbox account through srt-win, which only spawns from
 * an argv. PowerShell flags match the shell tool's direct mode.
 */
async function prepareWindowsCommand(command: string, commandId: string, cwd: string): Promise<SandboxedCommand> {
    const deniesChanged = () => windowsSession?.denies !== windowsDenyState(buildRuntimeConfig(currentConfig));
    if (isSandboxActive() && deniesChanged()) {
        log.info('A protected path appeared or was replaced, restarting the sandbox to cover it');
        await restartRuntime(() => !deniesChanged());
    }
    if (!isSandboxActive()) {
        throw new Error('The sandbox is not running');
    }

    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
        `${await windowsPreamble()}; ${command}`,
        { ...parseWindowsBinShell('powershell'), args: ['-NoProfile', '-NonInteractive', '-Command'] },
        undefined,
        undefined,
        cwd,
        { commandId, commandText: command },
    );
    log.debug({ command: command.substring(0, 100) }, 'Command wrapped with sandbox');
    return { cmd: argv, env };
}

/**
 * PowerShell run ahead of each command. The sandbox account brings its own profile, so ~
 * and the home variables point back at the user's, as on macOS and Linux, with bun's cache
 * kept where the sandbox can write. The shell inherits Pipali's PATH, which lacks the
 * bundled runtimes, so they go first on it.
 */
async function windowsPreamble(): Promise<string> {
    const home = toPowerShellLiteral(os.homedir());
    const statements = [
        `$env:USERPROFILE = ${home}`,
        `$env:HOME = ${home}`,
        `try { (Get-PSProvider FileSystem).Home = ${home} } catch {}`,
        `Set-Variable HOME ${home} -Scope Global -Force -ErrorAction Ignore`,
        `$env:BUN_INSTALL_CACHE_DIR = ${toPowerShellLiteral(path.join(SANDBOX_TEMP_DIR, 'bun-cache'))}`,
    ];
    const runtimes = await getBundledRuntimes();
    if (runtimes.isBundled) {
        statements.push(`$env:Path = ${toPowerShellLiteral(`${path.dirname(runtimes.bun)};`)} + $env:Path`);
    }
    return statements.join('; ');
}

/** A PowerShell single-quoted string, doubling each character PowerShell reads as a single quote. */
function toPowerShellLiteral(value: string): string {
    return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
}

function entryPath(entry: FilesystemPathEntry): string {
    return typeof entry === 'string' ? entry : entry.path;
}

function isGlob(p: string): boolean {
    return p.includes('*') || p.includes('?');
}

/**
 * Those of these paths that exist, and any patterns, which the runtime expands to what
 * exists. Told to deny a missing path, Windows creates an empty file in its place, which
 * would break the tool that later makes a folder there.
 */
function existingPaths(entries: FilesystemPathEntry[]): string[] {
    return entries.map(entryPath).filter(p => isGlob(p) || fs.existsSync(p));
}

/**
 * Which protected paths exist, and which file each one is. A deny lives on the file
 * itself, so a path made since the session started, or a file written anew under the
 * same name, stays readable until the runtime restarts.
 */
function windowsDenyState({ filesystem }: SandboxRuntimeConfig): string {
    const paths = [...filesystem.denyRead, ...filesystem.denyWrite].map(entryPath).filter(p => !isGlob(p));
    return JSON.stringify(paths.map(p => {
        try {
            const { dev, ino } = fs.statSync(p, { bigint: true });
            return [p, `${dev}:${ino}`];
        } catch {
            return [p, null];
        }
    }));
}

/**
 * Ready a Windows session for the config, returning the runtime config to start it with.
 * Grants on missing folders are dropped, so Pipali's own write folders are made first.
 */
function prepareWindowsSession(config: SandboxConfig): SandboxRuntimeConfig {
    for (const dir of [SANDBOX_TEMP_DIR, expandPath('~/.pipali')]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const built = buildRuntimeConfig(config);
    const runtimeConfig: SandboxRuntimeConfig = {
        ...built,
        filesystem: {
            ...built.filesystem,
            denyRead: existingPaths(built.filesystem.denyRead),
            denyWrite: existingPaths(built.filesystem.denyWrite),
        },
    };
    windowsSession = {
        runtimeConfig,
        filesystemKey: JSON.stringify(built.filesystem),
        denies: windowsDenyState(built),
    };
    return runtimeConfig;
}

/**
 * How a platform spells and compares paths. Defaults to the host's; tests pass
 * another platform's to check its rules from any machine.
 */
export interface PathStyle {
    path: path.PlatformPath;
    home: string;
    caseInsensitive: boolean;
}

function hostPathStyle(): PathStyle {
    return { path, home: os.homedir(), caseInsensitive: isCaseInsensitiveFS };
}

/**
 * Put a path or rule in the form rules are compared in: ~ expanded, forward
 * slashes as rules are written, and lowercase where the filesystem ignores case,
 * so C:\Users\me\.SSH falls under ~/.ssh.
 */
function toMatchForm(p: string, style: PathStyle): string {
    const homeRelative = style.path.sep === '\\' ? /^~([\\/]|$)/ : /^~(\/|$)/;
    const expanded = homeRelative.test(p) ? style.home + p.slice(1) : p;
    const slashed = style.path.normalize(expanded).split(style.path.sep).join('/');
    return style.caseInsensitive ? slashed.toLowerCase() : slashed;
}

/**
 * Check if a path is within a directory (not just starts with the same prefix), both in match form.
 * e.g., '/tmp/pipali/file.txt' is within '/tmp/pipali', but '/tmp/pipali-fake' is not.
 */
function isPathWithinDirectory(testPath: string, directory: string): boolean {
    const dirWithSep = directory.endsWith('/') ? directory : directory + '/';
    return testPath === directory || testPath.startsWith(dirWithSep);
}

/**
 * Check if a path is within the allowed write directories.
 * Used by write_file and edit_file actors to skip confirmation.
 *
 * @param absolutePath - The absolute path to check
 * @returns true if the path is allowed for writing
 */
export function isPathWithinAllowedWrite(absolutePath: string, style: PathStyle = hostPathStyle()): boolean {
    const matchPath = toMatchForm(absolutePath, style);

    // Check if path is in denied write paths (these always require confirmation)
    for (const deniedPath of currentConfig.deniedWritePaths) {
        if (isPathWithinDirectory(matchPath, toMatchForm(deniedPath, style))) {
            return false;
        }
    }

    // Check if path is within allowed write paths
    for (const allowedPath of currentConfig.allowedWritePaths) {
        if (isPathWithinDirectory(matchPath, toMatchForm(allowedPath, style))) {
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
export function isPathDeniedForRead(absolutePath: string, style: PathStyle = hostPathStyle()): boolean {
    const matchPath = toMatchForm(absolutePath, style);

    // Carve-outs take precedence over the deny list, matching the sandbox profile
    for (const allowedPath of DEFAULT_ALLOWED_READ_PATHS) {
        if (isPathWithinDirectory(matchPath, toMatchForm(allowedPath, style))) {
            return false;
        }
    }

    for (const deniedPath of currentConfig.deniedReadPaths) {
        // Handle **/ prefix - match directory anywhere in path
        if (deniedPath.startsWith('**/')) {
            const dirName = toMatchForm(deniedPath.slice(3), style); // Remove **/ prefix
            // Match /.dirname/ or /.dirname at end of path
            if (
                matchPath.includes(`/${dirName}/`) ||
                matchPath.endsWith(`/${dirName}`)
            ) {
                return true;
            }
            continue;
        }

        // Handle ~ and absolute paths, drive-letter ones included
        if (style.path.isAbsolute(deniedPath) || deniedPath.startsWith('~')) {
            if (isPathWithinDirectory(matchPath, toMatchForm(deniedPath, style))) {
                return true;
            }
            continue;
        }

        // Handle filename patterns (no prefix - match basename)
        const fileName = toMatchForm(deniedPath, style);
        const basename = path.posix.basename(matchPath);

        // Exact filename match
        if (basename === fileName) {
            return true;
        }

        // Special handling for .env - match .env.* variants but NOT .envrc
        if (fileName === '.env' && basename.match(/^\.env(\.[a-zA-Z]+)?$/)) {
            return true;
        }

        // Check if it's a directory in the path (e.g., /project/.env/something)
        if (matchPath.includes(`/${fileName}/`)) {
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
 * Annotate stderr with the violations the sandbox runtime recorded for a run.
 *
 * @param commandId - The id the run's command was wrapped with
 * @param stderr - The stderr output from the command
 * @returns The annotated stderr with sandbox failure information
 */
export function annotateStderrWithSandboxFailures(commandId: string, stderr: string): string {
    if (!isSandboxActive()) {
        return stderr;
    }

    try {
        return SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
    } catch (error) {
        log.error({ err: error }, 'Failed to annotate stderr with sandbox failures');
        return stderr;
    }
}

/**
 * Where sandboxed commands write scratch files.
 * On macOS and Linux also their TMPDIR and tool caches.
 */
export const SANDBOX_TEMP_DIR = getSandboxTempDir();

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
