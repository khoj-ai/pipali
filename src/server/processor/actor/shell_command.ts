import path from 'path';
import os from 'os';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import {
    isSandboxActive,
    wrapCommandWithSandbox,
    annotateStderrWithSandboxFailures,
    getSandboxEnvOverrides,
} from '../../sandbox';
import { createChildLogger } from '../../logger';
import { buildBundledRuntimeEnv } from '../../bundled-runtimes';

const log = createChildLogger({ component: 'shell' });

/**
 * Operation type indicating whether command modifies state
 * - read-only: No side effects (e.g., ls, cat, grep)
 * - write-only: Creates new state without reading (e.g., mkdir, touch, echo > newfile)
 * - read-write: Reads and modifies state (e.g., sed -i, mv, rm)
 */
export type ShellOperationType = 'read-only' | 'write-only' | 'read-write';

/**
 * Execution mode for shell commands
 * - sandbox: Run in OS-enforced sandbox (macOS/Linux only), skips user confirmation
 * - direct: Run directly without sandbox, requires user confirmation
 */
export type ShellExecutionMode = 'sandbox' | 'direct';

/**
 * Arguments for the shell_command tool.
 */
export interface ShellCommandArgs {
    /** A clear explanation of why this command needs to be run */
    justification: string;
    /** The shell command to execute (bash on Unix, PowerShell on Windows) */
    command: string;
    /** Whether the command is read-only (no side effects) or read-write (modifies state) */
    operation_type: ShellOperationType;
    /**
     * Execution mode for the command:
     * - 'sandbox': Run in OS-enforced sandbox (skips confirmation, but restricted access)
     * - 'direct': Run directly (requires user confirmation, but full access)
     * Defaults to 'sandbox' if available, otherwise 'direct'.
     */
    execution_mode?: ShellExecutionMode;
    /** Optional working directory for command execution (defaults to home directory) */
    cwd?: string;
    /** Optional timeout in milliseconds (defaults to 30000ms / 30 seconds) */
    timeout?: number;
}

/**
 * Result from executing a shell command
 */
export interface ShellCommandResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Options for shell command execution
 */
export interface ShellCommandOptions {
    /** Confirmation context for requesting user approval */
    confirmationContext?: ConfirmationContext;
}

/** Default timeout for command execution (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum timeout allowed (1 minutes) */
const MAX_TIMEOUT_MS = 60_000;

/**
 * Executes a shell command on the user's system.
 * Uses bash on Unix/macOS and PowerShell on Windows.
 *
 * Features:
 * - Requires user confirmation before execution (high-risk operation)
 * - Configurable working directory
 * - Configurable timeout with sensible defaults
 * - Captures both stdout and stderr
 * - Returns exit code information
 *
 * Security:
 * - All commands require explicit user approval
 * - Commands run in a subshell with user's default shell
 */
export async function shellCommand(
    args: ShellCommandArgs,
    options?: ShellCommandOptions
): Promise<ShellCommandResult> {
    const { justification, command, cwd, timeout } = args;

    const query = `Execute command: ${command}`;

    // Validate inputs
    if (!command || command.trim() === '') {
        return {
            query,
            file: '',
            uri: '',
            compiled: 'Error: command is required and cannot be empty',
        };
    }

    // Resolve working directory
    let workingDir: string;
    if (cwd) {
        workingDir = path.isAbsolute(cwd)
            ? cwd
            : cwd.startsWith('~')
                ? path.join(os.homedir(), cwd.slice(1))
                : path.resolve(os.homedir(), cwd);
    } else {
        workingDir = os.homedir();
    }

    // Validate working directory exists using cross-platform fs.stat
    try {
        const fs = await import('node:fs/promises');
        const stat = await fs.stat(workingDir);
        if (!stat.isDirectory()) {
            return {
                query,
                file: '',
                uri: '',
                compiled: `Error: Working directory is not a directory: ${workingDir}`,
            };
        }
    } catch (err) {
        // Directory doesn't exist or can't be accessed
        return {
            query,
            file: '',
            uri: '',
            compiled: `Error: Working directory does not exist: ${workingDir}`,
        };
    }

    // Clamp timeout to valid range
    const effectiveTimeout = Math.min(
        Math.max(timeout ?? DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS
    );

    // Check if sandbox is available (enabled AND supported platform)
    const sandboxAvailable = isSandboxActive();
    const isWindows = process.platform === 'win32';

    // Determine execution mode:
    // - If explicitly set to 'direct', use direct mode (requires confirmation)
    // - If explicitly set to 'sandbox' but sandbox not available, fall back to direct
    // - Default to sandbox if available, otherwise direct
    const requestedMode = args.execution_mode;
    const useSandbox = requestedMode === 'sandbox'
        ? sandboxAvailable  // Requested sandbox, use if available
        : requestedMode === 'direct'
            ? false  // Explicitly requested direct mode
            : sandboxAvailable;  // Default: use sandbox if available

    // Log if sandbox was requested but unavailable
    if (requestedMode === 'sandbox' && !sandboxAvailable) {
        log.debug(`Sandbox mode requested but unavailable, falling back to direct mode (requires confirmation)`);
    }

    // Request user confirmation if using direct mode (not sandboxed)
    // When using sandbox, security is enforced by the OS - skip confirmation
    if (!useSandbox && options?.confirmationContext) {
        const confirmResult = await requestOperationConfirmation(
            'execute_command',
            workingDir,
            options.confirmationContext,
            {
                toolName: 'shell_command',
                toolArgs: {
                    command,
                    cwd: workingDir,
                    timeout: effectiveTimeout,
                    operation_type: args.operation_type,
                },
                operationSubType: args.operation_type,
                commandInfo: {
                    command,
                    reason: justification,
                    workdir: workingDir,
                },
            }
        );

        if (!confirmResult.approved) {
            return {
                query,
                file: workingDir,
                uri: workingDir,
                compiled: `Command execution cancelled: ${confirmResult.denialReason || 'User denied the operation'}`,
            };
        }
    }

    try {
        // Determine shell command based on platform and sandbox mode
        let shellCmd: string[];

        if (isWindows) {
            // Windows: no sandbox support, use PowerShell directly
            shellCmd = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command];
            log.debug(`Executing (no sandbox): ${command} in ${workingDir}`);
        } else if (useSandbox) {
            // Unix with sandbox: wrap the command
            const sandboxedCommand = await wrapCommandWithSandbox(command);
            shellCmd = ['/bin/bash', '-c', sandboxedCommand];
            log.debug(`Executing (sandboxed): ${command} in ${workingDir}`);
        } else {
            // Unix without sandbox
            shellCmd = ['/bin/bash', '-c', command];
            log.debug(`Executing (no sandbox): ${command} in ${workingDir}`);
        }

        // For sandboxed commands, set environment variables to redirect tool caches
        // to sandbox-allowed directories. This prevents tools like uv, pip, npm from
        // trying to write to ~/.cache which isn't in the sandbox allowlist.
        const baseEnv = useSandbox
            ? { ...process.env, ...getSandboxEnvOverrides() }
            : process.env;
        const env = await buildBundledRuntimeEnv(baseEnv);

        const proc = Bun.spawn({
            cmd: shellCmd,
            cwd: workingDir,
            env,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: effectiveTimeout,
        });

        const exitCode = await proc.exited;
        const stdout = (await new Response(proc.stdout).text()).trim();
        let stderr = (await new Response(proc.stderr).text()).trim();

        // Filter out known cosmetic xcrun cache creation warnings from stderr on macOS.
        // Sandbox works fine, just can't cache the SDK path lookup. Unable to disable it.
        if (useSandbox && stderr) {
            stderr = stderr
                .split('\n')
                .filter(line => !line.includes("error: couldn't create cache file") && !line.includes("xcrun_db"))
                .join('\n')
                .trim();
        }

        const originalStderr = stderr;

        // Annotate stderr with sandbox violation information if running in sandbox mode
        // This uses sandbox-runtime's built-in violation detection (reads macOS sandbox logs)
        if (useSandbox && stderr) {
            stderr = annotateStderrWithSandboxFailures(command, stderr);
        }

        // Detect sandbox violations:
        // 1. Check if annotateStderrWithSandboxFailures added violation info (most reliable on macOS)
        // 2. Fall back to pattern matching for common sandbox error messages
        const annotationAdded = stderr !== originalStderr;
        const hasViolationPatterns = exitCode !== 0 && (
            originalStderr.includes('Operation not permitted') ||
            originalStderr.includes('EPERM') ||
            originalStderr.includes('Permission denied')
        );
        const isSandboxViolation = useSandbox && (annotationAdded || hasViolationPatterns);

        // Build output message
        let output = '';

        if (stdout) {
            output += stdout;
        }

        if (stderr) {
            if (output) output += '\n\n';
            output += `[stderr]\n${stderr}`;
        }

        if (!output) {
            output = '(no output)';
        }

        // Add exit code if non-zero
        if (exitCode !== 0) {
            output += `\n\n[Exit code: ${exitCode}]`;
        }

        // Add sandbox violation notice if detected
        if (isSandboxViolation) {
            output += `\n\n[Sandbox violation: The command attempted an operation outside the allowed sandbox paths. ` +
                `Write operations are only allowed in /tmp/pipali and ~/.pipali. ` +
                `Use execution_mode: "direct" if you need full filesystem access (requires user confirmation).]`;
            log.error(`Sandbox violation detected for command: ${command}`);
        }

        log.debug(`Command completed with exit code ${exitCode}${isSandboxViolation ? ' (sandbox violation)' : ''}`);

        return {
            query,
            file: workingDir,
            uri: workingDir,
            compiled: output,
        };
    } catch (error) {
        // Handle timeout specifically
        if (error instanceof Error && error.message.includes('timed out')) {
            const errorMsg = `Command timed out after ${effectiveTimeout}ms: ${command}`;
            log.error(`${errorMsg}`);
            return {
                query,
                file: workingDir,
                uri: workingDir,
                compiled: errorMsg,
            };
        }

        const errorMsg = `Error executing command: ${error instanceof Error ? error.message : String(error)}`;
        log.error({ err: error }, errorMsg);

        return {
            query,
            file: workingDir,
            uri: workingDir,
            compiled: errorMsg,
        };
    }
}
