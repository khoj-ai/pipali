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
    getWindowsSandboxUserStatusAsync,
    installWindowsSandboxAsync,
    parseWindowsBinShell,
    resolveSrtWin,
    WindowsSandboxError,
    type FilesystemPathEntry,
    type SandboxRuntimeConfig,
    type WindowsSandboxErrorCode,
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
import { getAppDataDir } from '../paths';
import { expandPath, isCaseInsensitiveFS } from '../utils';
import { loadSandboxSettings, saveSandboxSettings, ensureSandboxSettings } from './settings';

const log = createChildLogger({ component: 'sandbox' });

// Current sandbox configuration (loaded from database)
let currentConfig: SandboxConfig = getDefaultConfig();

// Where each path rule leads once links resolve, taken as its config is applied, as the
// runtime takes its rules as it starts. A sandboxed command can replace a write folder with
// a link, and must not carry the rule along with it.
let resolvedRules = resolveRules(currentConfig);

function applyConfig(config: SandboxConfig): void {
    currentConfig = config;
    resolvedRules = resolveRules(config);
}

// Whether the sandbox runtime finished initializing. Commands only run sandboxed when it did.
let runtimeReady = false;

// Why the runtime last failed to start, unless that was the missing Windows setup
let runtimeError: string | null = null;

// Whether the runtime's last start failed. A restart takes it down for a moment without that.
let startFailed = false;

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
        // macOS's log monitor records each refusal its sandbox makes. Linux's needs the seccomp
        // helper, which the open unix sockets leave out, so it would only add a way to fail.
        await SandboxManager.initialize(runtimeConfig, undefined, process.platform === 'darwin');

        const { warnings } = await SandboxManager.checkDependenciesAsync();
        if (warnings.length > 0) {
            log.warn({ warnings }, 'Sandbox running with degraded dependencies');
        }
        runtimeReady = true;
        runtimeError = null;
        startFailed = false;
        log.info({
            platform: process.platform,
            allowWrite: runtimeConfig.filesystem.allowWrite,
        }, 'Sandbox initialized');
    } catch (error) {
        const awaitingSetup = process.platform === 'win32' && await isAwaitingWindowsSetup(error);
        if (awaitingSetup) {
            log.info('Windows sandbox awaits its one-time setup, commands will ask for confirmation');
        } else {
            log.error({ err: error }, 'Sandbox failed to start, commands will ask for confirmation');
        }
        runtimeError = awaitingSetup ? null : error instanceof Error ? error.message : String(error);
        startFailed = true;
        // A failed start can leave part of the runtime up. Clear it so the next start begins clean.
        await SandboxManager.reset().catch(err => log.warn({ err }, 'Could not clear the failed sandbox start'));
    }
}

/** Run a start or stop of the runtime once those queued before it are done. */
function queueRuntime<T>(task: () => Promise<T>): Promise<T> {
    const run = runtimeQueue.then(task);
    runtimeQueue = run.then(() => {}, () => {});
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
            applyConfig({ ...getDefaultConfig(), enabled: false });
            return;
        }

        // Load settings from database (or create defaults)
        applyConfig(await ensureSandboxSettings(DEFAULT_USER_ID));

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
    applyConfig(config);
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
    applyConfig(await loadSandboxSettings(DEFAULT_USER_ID));

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
 * Whether the user should run the one-time Windows setup, which makes the account
 * sandboxed commands run as. Setting up again also repairs one that stopped working.
 */
export function needsSandboxSetup(platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'win32' && isSandboxEnabled() && isSandboxSupported() && !isSandboxActive() && startFailed;
}

/** Why the sandbox last failed to start, if it was not just awaiting setup. */
export function getSandboxStartError(): string | null {
    return runtimeError;
}

// Start failures that running the one-time setup again fixes
const SETUP_FIXES: ReadonlySet<WindowsSandboxErrorCode> = new Set<WindowsSandboxErrorCode>([
    'not_provisioned',
    'reinstall_required',
    'profile_grant_outdated',
    'wfp_loopback_mismatch',
]);

/**
 * Whether the runtime failed to start for want of the one-time Windows setup: the sandbox
 * account is missing, was set up by another release or for the other loopback mode, or its
 * read grant on the user's profile is out of date.
 */
async function isAwaitingWindowsSetup(error: unknown): Promise<boolean> {
    if (error instanceof WindowsSandboxError) {
        return SETUP_FIXES.has(error.code);
    }
    // A missing account fails the dependency check first, with a plain Error
    try {
        const { windows } = buildRuntimeConfig(currentConfig, 'win32');
        const user = await getWindowsSandboxUserStatusAsync({ srtWin: resolveSrtWin(windows?.srtWin) });
        return !user.provisioned || !user.credPresent;
    } catch {
        return false;
    }
}

// The Windows setup in flight, which Settings and commands share
let windowsSetup: { elevated: Promise<void>; done: Promise<{ cancelled: boolean }> } | undefined;

/**
 * Run the one-time Windows setup, then start the sandbox on it. Windows asks the user for
 * administrator permission; dismissing that resolves as cancelled. Given it, the setup
 * makes the user's profile readable to the sandbox account, which can take minutes on a
 * large profile; `onElevated` is called as that starts.
 */
export function setUpWindowsSandbox(
    onElevated?: () => void,
    install: typeof installWindowsSandboxAsync = installWindowsSandboxAsync,
): Promise<{ cancelled: boolean }> {
    if (!windowsSetup) {
        const elevated = Promise.withResolvers<void>();
        const done = queueRuntime(async (): Promise<{ cancelled: boolean }> => {
            // The profile grant is not made while a session of ours runs
            runtimeReady = false;
            await SandboxManager.reset();

            const { windows } = buildRuntimeConfig(currentConfig, 'win32');
            const result = await install({
                srtWin: resolveSrtWin(windows?.srtWin),
                // Loopback is open or closed for the whole install, and sessions must ask for that mode
                allowLoopback: currentConfig.allowLocalBinding,
                force: true,
                onProfileGrantStart: () => elevated.resolve(),
            });
            if (!result.cancelled) {
                const grant = result.profileGrant;
                log.info({ profileGrant: grant?.applied ? 'applied' : grant?.reason }, 'Windows sandbox set up');
                fs.rmSync(setupDeclinedMarker(), { force: true });
            }

            // Declining changed nothing, so a sandbox that ran before runs again
            if (currentConfig.enabled) {
                await startRuntime();
            }
            return { cancelled: result.cancelled === true };
        }).finally(() => {
            elevated.resolve();
            windowsSetup = undefined;
        });
        windowsSetup = { elevated: elevated.promise, done };
    }
    if (onElevated) {
        void windowsSetup.elevated.then(onElevated);
    }
    return windowsSetup.done;
}

/** Marks a declined or failed automatic setup, so commands stop raising its prompt. */
function setupDeclinedMarker(): string {
    return path.join(getAppDataDir(), 'sandbox-setup-declined');
}

// The automatic setup in flight, which commands wait on until its prompt is answered
let setupOnFirstNeed: Promise<void> | undefined;

/**
 * Run the one-time Windows setup when a command first needs it, so its UAC prompt arrives
 * with the command it is for. Commands wait for the prompt to be answered, not for the
 * profile grant after it, and ask for confirmation until the sandbox is up. A setup
 * declined, left unanswered or failed is remembered and not raised again; Settings still
 * offers it.
 */
export async function setUpSandboxOnFirstNeed({
    platform = process.platform,
    setUp = setUpWindowsSandbox,
}: {
    platform?: NodeJS.Platform;
    setUp?: (onElevated: () => void) => Promise<{ cancelled: boolean }>;
} = {}): Promise<void> {
    if (platform !== 'win32') return;
    // A restart under way takes the sandbox down for a moment, so the command runs in it once
    // it is back. A setup under way is joined below, to wait only for its prompt.
    if (!windowsSetup) await queueRuntime(async () => {});
    if (!needsSandboxSetup(platform) || fs.existsSync(setupDeclinedMarker())) {
        return;
    }
    setupOnFirstNeed ??= new Promise<void>(answered => {
        void (async () => {
            let outcome: string | undefined;
            try {
                const { cancelled } = await setUp(answered);
                if (cancelled) outcome = 'declined';
                else if (!isSandboxActive()) outcome = `did not start the sandbox: ${runtimeError ?? 'unknown error'}`;
            } catch (error) {
                outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (!outcome) return;
            log.info(`Windows sandbox setup ${outcome}. Commands will ask for confirmation`);
            try {
                fs.mkdirSync(path.dirname(setupDeclinedMarker()), { recursive: true });
                fs.writeFileSync(setupDeclinedMarker(), `${new Date().toISOString()} ${outcome}\n`);
            } catch (error) {
                log.warn({ err: error }, 'Could not remember the declined sandbox setup');
            }
        })().finally(() => {
            setupOnFirstNeed = undefined;
            answered();
        });
    });
    await setupOnFirstNeed;
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
 * @param commandId - Files the run's refusals for describeSandboxRefusals
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
    const slashed = style.path.normalize(expandHome(p, style)).split(style.path.sep).join('/');
    return style.caseInsensitive ? slashed.toLowerCase() : slashed;
}

function expandHome(p: string, style: PathStyle): string {
    const homeRelative = style.path.sep === '\\' ? /^~([\\/]|$)/ : /^~(\/|$)/;
    return homeRelative.test(p) ? style.home + p.slice(1) : p;
}

/**
 * Whether a path in match form falls under a rule, as written or where the rule led once
 * links resolved when its config was applied. File tools also judge the file a path
 * resolves to, and that path is spelled the resolved way: /tmp is /private/tmp on macOS,
 * and Windows' temp folder can be spelled short.
 */
function isWithinRule(matchPath: string, rule: string, style: PathStyle): boolean {
    if (isPathWithinDirectory(matchPath, toMatchForm(rule, style))) return true;
    if (style.path !== path || style.home !== os.homedir()) return false;
    const resolved = resolvedRules.get(rule);
    return resolved !== undefined && isPathWithinDirectory(matchPath, toMatchForm(resolved, style));
}

/** Where a config's ~ and absolute path rules lead once links resolve, for those that exist. */
function resolveRules(config: SandboxConfig): Map<string, string> {
    const style = hostPathStyle();
    const rules = [...config.allowedWritePaths, ...config.deniedWritePaths, ...config.deniedReadPaths, ...DEFAULT_ALLOWED_READ_PATHS];
    const resolved = new Map<string, string>();
    for (const rule of rules) {
        if (!rule.startsWith('~') && !style.path.isAbsolute(rule)) continue;
        try {
            const expanded = expandHome(rule, style);
            // Resolving opens the path, which blocks on a pipe
            const stats = fs.statSync(expanded);
            if (stats.isDirectory() || stats.isFile()) resolved.set(rule, fs.realpathSync(expanded));
        } catch {
            // Not there, so matched as written
        }
    }
    return resolved;
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
        if (isWithinRule(matchPath, deniedPath, style)) {
            return false;
        }
    }

    // Check if path is within allowed write paths
    for (const allowedPath of currentConfig.allowedWritePaths) {
        if (isWithinRule(matchPath, allowedPath, style)) {
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
        if (isWithinRule(matchPath, allowedPath, style)) {
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
            if (isWithinRule(matchPath, deniedPath, style)) {
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

// How an operation the OS refused reads in a command's output. That is all Windows' ACLs
// and Linux's read-only binds leave; macOS also records each refusal, as the proxy does
// each refused connection.
const REFUSAL_ERRORS: Partial<Record<NodeJS.Platform, string[]>> = {
    darwin: ['Operation not permitted', 'EPERM'],
    linux: ['Read-only file system', 'EROFS', 'Operation not permitted', 'EPERM'],
    win32: ['Access is denied', 'Access to the path', 'UnauthorizedAccessException', 'PermissionError', 'Permission denied', 'EPERM', 'EACCES'],
};

// macOS records refusals from its system log, which ran up to 11ms behind the command
// when measured
const REFUSAL_LOG_DELAY_MS = 50;

// A command walking a protected folder is refused once per file in it
const MAX_REFUSALS_SHOWN = 20;

/**
 * A recorded refusal without what its section already says: "bash(4095) deny(1)
 * file-write-create /x" reads "bash: file-write-create /x", and the proxy's
 * "deny network-outbound host:443 (…)" reads "network-outbound host:443 (…)".
 */
function readableRefusal(line: string): string {
    return line.replace(/^(\S+)\(\d+\) deny\(\d+\) /, '$1: ').replace(/^deny /, '');
}

/**
 * What the sandbox refused while a command ran, to end its output with.
 *
 * - The refusals the runtime recorded under the id the command was wrapped with, when it
 *   failed. A refused connection always, since an HTTP client can report one and exit 0.
 * - The sandbox's limits, when the command failed with a refusal error or a connection was
 *   refused. A refused read the command shrugged off, such as an .env a tool probes for,
 *   is listed without them.
 *
 * @param errors - What the command printed that a refusal error would be in
 */
export async function describeSandboxRefusals(
    commandId: string,
    { exitCode, errors }: { exitCode: number; errors: string },
    platform: NodeJS.Platform = process.platform,
): Promise<string> {
    const failed = exitCode !== 0;
    if (failed && platform === 'darwin') {
        await Bun.sleep(REFUSAL_LOG_DELAY_MS);
    }
    let recorded: string[] = [];
    try {
        recorded = SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId).map(v => readableRefusal(v.line));
    } catch (error) {
        log.warn({ err: error }, 'Could not read what the sandbox refused');
    }
    // A refused connection names where it was going. macOS also records bare network-outbound
    // lines for lookups a client such as Bun's fetch makes on its way through the proxy.
    const isConnection = (line: string) => /network-outbound \S+:\d+/.test(line);
    const refusals = [...new Set(recorded)].filter(line => failed || isConnection(line));
    const refusalError = failed && (REFUSAL_ERRORS[platform] ?? []).some(error => errors.includes(error));

    const lines: string[] = [];
    if (refusals.length > 0) {
        const unshown = refusals.length - MAX_REFUSALS_SHOWN;
        lines.push(
            'Refused:',
            ...refusals.slice(0, MAX_REFUSALS_SHOWN).map(refusal => `- ${refusal}`),
            ...(unshown > 0 ? [`- and ${unshown} more`] : []),
        );
    }
    if (refusalError || refusals.some(isConnection)) {
        lines.push(
            ...(lines.length > 0 ? [''] : []),
            `Sandboxed commands write only to ${currentConfig.allowedWritePaths.join(', ')}, ` +
            'read no protected path such as ~/.ssh, and reach only the domains the sandbox settings allow.',
            'execution_mode "direct" runs a command outside the sandbox after prompting the user to approve it.',
        );
    }
    return lines.length > 0 ? ['[sandbox_refusal]', ...lines].join('\n') : '';
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
