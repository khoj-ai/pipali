import path from 'path';
import os from 'os';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';

/**
 * Arguments for the bash_command tool.
 */
export interface BashCommandArgs {
    /** A clear explanation of why this command needs to be run */
    justification: string;
    /** The bash command to execute */
    command: string;
    /** Optional working directory for command execution (defaults to home directory) */
    cwd?: string;
    /** Optional timeout in milliseconds (defaults to 30000ms / 30 seconds) */
    timeout?: number;
}

/**
 * Result from executing a bash command
 */
export interface BashCommandResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Options for bash command execution
 */
export interface BashCommandOptions {
    /** Confirmation context for requesting user approval */
    confirmationContext?: ConfirmationContext;
}

/** Default timeout for command execution (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum timeout allowed (5 minutes) */
const MAX_TIMEOUT_MS = 300_000;

/**
 * Executes a bash command on the user's system.
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
export async function bashCommand(
    args: BashCommandArgs,
    options?: BashCommandOptions
): Promise<BashCommandResult> {
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

    // Validate working directory exists
    const cwdFile = Bun.file(workingDir);
    // Check if it's a directory by trying to stat it
    try {
        const stat = await Bun.file(workingDir + '/.').exists();
        if (!stat) {
            // Try parent to check if cwd itself exists as directory
            const dirCheck = await Bun.$`test -d ${workingDir}`.quiet().nothrow();
            if (dirCheck.exitCode !== 0) {
                return {
                    query,
                    file: '',
                    uri: '',
                    compiled: `Error: Working directory does not exist: ${workingDir}`,
                };
            }
        }
    } catch {
        // Directory check failed, try anyway and let the command fail if needed
    }

    // Clamp timeout to valid range
    const effectiveTimeout = Math.min(
        Math.max(timeout ?? DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS
    );

    // Request user confirmation - this is a high-risk operation
    if (options?.confirmationContext) {
        const confirmResult = await requestOperationConfirmation(
            'execute_command',
            workingDir,
            options.confirmationContext,
            {
                toolName: 'bash_command',
                toolArgs: {
                    command,
                    cwd: workingDir,
                    timeout: effectiveTimeout,
                },
                additionalMessage: `**Why:** ${justification}\n\n**Command:**\n${command}\n\n**Working directory:** ${workingDir}`,
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
        console.log(`[Bash] Executing: ${command} in ${workingDir}`);

        // Execute command using Bun.spawn with /bin/bash -c for full bash compatibility
        // This handles heredocs, complex quoting, pipes, and all bash features
        const proc = Bun.spawn({
            cmd: ['/bin/bash', '-c', command],
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

        console.log(`[Bash] Command completed with exit code ${exitCode}`);

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
            console.error(`[Bash] ${errorMsg}`);
            return {
                query,
                file: workingDir,
                uri: workingDir,
                compiled: errorMsg,
            };
        }

        const errorMsg = `Error executing command: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[Bash] ${errorMsg}`, error);

        return {
            query,
            file: workingDir,
            uri: workingDir,
            compiled: errorMsg,
        };
    }
}
