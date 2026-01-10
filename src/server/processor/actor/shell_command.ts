import path from 'path';
import os from 'os';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';

/**
 * Operation type indicating whether command modifies state
 * - read-only: No side effects (e.g., ls, cat, grep)
 * - write-only: Creates new state without reading (e.g., mkdir, touch, echo > newfile)
 * - read-write: Reads and modifies state (e.g., sed -i, mv, rm)
 */
export type ShellOperationType = 'read-only' | 'write-only' | 'read-write';

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

    // Request user confirmation - this is a high-risk operation
    // Confirmation is tracked per operation_type (read-only, write-only, read-write)
    // If user approves a read-only command with "don't ask again", future read-only commands won't ask
    // but write-only or read-write commands will still require confirmation
    if (options?.confirmationContext) {
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
        console.log(`[Shell] Executing: ${command} in ${workingDir}`);

        // Determine shell based on platform
        const isWindows = process.platform === 'win32';
        const shellCmd = isWindows
            ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command]
            : ['/bin/bash', '-c', command];

        const proc = Bun.spawn({
            cmd: shellCmd,
            cwd: workingDir,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: effectiveTimeout,
        });

        const exitCode = await proc.exited;
        const stdout = (await new Response(proc.stdout).text()).trim();
        const stderr = (await new Response(proc.stderr).text()).trim();

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

        console.log(`[Shell] Command completed with exit code ${exitCode}`);

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
            console.error(`[Shell] ${errorMsg}`);
            return {
                query,
                file: workingDir,
                uri: workingDir,
                compiled: errorMsg,
            };
        }

        const errorMsg = `Error executing command: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[Shell] ${errorMsg}`, error);

        return {
            query,
            file: workingDir,
            uri: workingDir,
            compiled: errorMsg,
        };
    }
}
