/**
 * Background Processes
 *
 * Shell commands that outlive the tool call that started them: builds, test suites,
 * dev servers. Output is appended to a log file rather than a pipe, so the agent reads
 * it back with tail/grep and nothing has to drain a buffer to keep a full pipe from
 * blocking the command halfway through.
 *
 * Exits are reported through the parent inbox, the same path delegated tasks use.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { User } from '../db/schema';
import { deliverToParent } from './parent-inbox';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'background-process' });

/** Enough to see how a command ended without pasting a whole build log into context. */
const REPORT_TAIL_BYTES = 2_000;

/** These outlive the run that starts them, so a stuck agent could otherwise pile them up. */
const MAX_CONCURRENT = 10;

/** How long a stopped command gets to exit on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** Finished commands are kept so a late stop_process can still say how they ended. */
const MAX_FINISHED_RETAINED = 20;

/** Enough of a command to recognise it in the at-capacity listing. */
const MAX_LISTED_COMMAND_CHARS = 100;

export interface BackgroundProcess {
    pid: number;
    conversationId: string;
    /** Server-side only, so an operator reading logs can tell what a pid is. */
    command: string;
    logPath: string;
    startedAt: Date;
    running: boolean;
    exitCode?: number;
    /** Set when the exit was asked for, so it is not reported back as news. */
    stopRequested: boolean;
}

const processes = new Map<number, BackgroundProcess>();

/**
 * Logs live in the app's scratch space: sandbox-writable, so a sandboxed shell_command
 * can tail them without escalating to direct mode and prompting on every look, and
 * cleared by the OS, which is the only cleanup these ever get.
 */
function getBackgroundLogDir(): string {
    const dir = process.env.PIPALI_BACKGROUND_LOG_DIR || path.join(os.tmpdir(), 'pipali', 'background');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export interface StartBackgroundProcessOptions {
    /** Fully prepared argv, sandbox wrapping already applied. */
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    command: string;
    conversationId: string;
    user: typeof User.$inferSelect;
}

/** Records outlive the commands they describe, so drop the oldest finished ones. */
function pruneFinished(): void {
    const finished = [...processes.values()]
        .filter(p => !p.running)
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

    for (const record of finished.slice(0, finished.length - MAX_FINISHED_RETAINED)) {
        processes.delete(record.pid);
    }
}

function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * At capacity the agent has to choose something to stop, and a bare pid is not enough
 * to choose with: the cap is shared, so some of these may belong to a conversation it
 * cannot see the history of. Name what each one is, whose it is, and where its output
 * went, so it can judge staleness rather than guess.
 */
function describeRunning(running: BackgroundProcess[], callerConversationId: string): string {
    const now = Date.now();
    return running
        .slice()
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .map(record => {
            const command = record.command.length > MAX_LISTED_COMMAND_CHARS
                ? `${record.command.slice(0, MAX_LISTED_COMMAND_CHARS)}…`
                : record.command;
            const owner = record.conversationId === callerConversationId
                ? 'started here'
                : `started in conversation: ${record.conversationId}`;
            return `  pid ${record.pid} | running ${formatDuration(now - record.startedAt.getTime())}`
                + ` | ${owner} | ${command} | log: ${record.logPath}`;
        })
        .join('\n');
}

/** Throws when too many are already running; the caller turns that into a tool error. */
export function startBackgroundProcess(options: StartBackgroundProcessOptions): BackgroundProcess {
    pruneFinished();

    const running = [...processes.values()].filter(p => p.running);
    if (running.length >= MAX_CONCURRENT) {
        throw new Error([
            `hit the limit of ${MAX_CONCURRENT} concurrent background commands you can run across all conversations:`,
            describeRunning(running, options.conversationId),
            'End one with stop_process if it is stale - finished with, superseded, or no longer',
            'making progress, which its log will tell you. Ask the user which to stop if none is',
            'clearly safe to end.',
        ].join('\n'));
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(getBackgroundLogDir(), `${stamp}-${crypto.randomUUID().slice(0, 8)}.log`);
    const fd = fs.openSync(logPath, 'a');

    try {
        const proc = Bun.spawn({
            cmd: options.cmd,
            cwd: options.cwd,
            env: options.env,
            stdout: fd,
            stderr: fd,
            // Its own process group, so stopping it takes the whole tree. Signalling the
            // bash wrapper alone would leave a dev server it started running.
            detached: true,
        });

        const record: BackgroundProcess = {
            pid: proc.pid,
            conversationId: options.conversationId,
            command: options.command,
            logPath,
            startedAt: new Date(),
            running: true,
            stopRequested: false,
        };
        processes.set(proc.pid, record);
        reportOnExit(proc, record, options.user);

        log.info({ pid: record.pid, logPath, command: options.command }, 'Started background command');
        return record;
    } finally {
        // The child holds its own copy of the descriptor.
        fs.closeSync(fd);
    }
}

function reportOnExit(
    proc: Bun.Subprocess,
    record: BackgroundProcess,
    user: typeof User.$inferSelect,
): void {
    void proc.exited.then(async (exitCode) => {
        record.running = false;
        record.exitCode = exitCode;
        log.info({ pid: record.pid, exitCode }, 'Background command exited');

        // Don't report event back to caller if they requested stop, they already know.
        if (record.stopRequested) return;

        try {
            await deliverToParent({
                parentConversationId: record.conversationId,
                user,
                kind: 'background_command_update',
                message: [
                    exitCode === 0
                        ? `[Background command finished] pid ${record.pid}`
                        : `[Background command exited with code ${exitCode}] pid ${record.pid}`,
                    `Log: ${record.logPath}`,
                    '',
                    readLogTail(record.logPath) || '(no output)',
                ].join('\n'),
            });
        } catch (error) {
            log.error({ err: error, pid: record.pid }, 'Failed to report background command');
        }
    });
}

/** Reads only the tail, so reporting on a command that logged gigabytes stays cheap. */
function readLogTail(logPath: string, limit = REPORT_TAIL_BYTES): string {
    try {
        const { size } = fs.statSync(logPath);
        const start = Math.max(0, size - limit);
        const fd = fs.openSync(logPath, 'r');
        try {
            const buffer = Buffer.alloc(size - start);
            fs.readSync(fd, buffer, 0, buffer.length, start);
            const tail = buffer.toString('utf8').trim();
            return start > 0 ? `[last ${buffer.length} of ${size} bytes]\n${tail}` : tail;
        } finally {
            fs.closeSync(fd);
        }
    } catch (error) {
        log.warn({ err: error, logPath }, 'Could not read background command log');
        return '';
    }
}

/** A negative pid targets the group that `detached` made this process the leader of. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(process.platform === 'win32' ? pid : -pid, signal);
    } catch {
        // Already gone.
    }
}

export function stopBackgroundProcess(pid: number): boolean {
    const record = processes.get(pid);
    if (!record?.running) return false;

    record.stopRequested = true;
    signalGroup(pid, 'SIGTERM');
    const forceKill = setTimeout(() => {
        if (processes.get(pid)?.running) signalGroup(pid, 'SIGKILL');
    }, KILL_GRACE_MS);
    forceKill.unref?.();
    return true;
}

/** Stopping a conversation stops the work it started, commands included. */
export function stopBackgroundProcessesFor(conversationId: string): number[] {
    const stopped: number[] = [];
    for (const record of processes.values()) {
        if (record.conversationId === conversationId && stopBackgroundProcess(record.pid)) {
            stopped.push(record.pid);
        }
    }
    return stopped;
}

/** Background commands do not outlive the server that started them. */
export function killAllBackgroundProcesses(): void {
    for (const record of processes.values()) {
        if (!record.running) continue;
        // Also keeps the exit from reaching for a database that is closing behind it.
        record.stopRequested = true;
        signalGroup(record.pid, 'SIGTERM');
    }
}

export function getBackgroundProcess(pid: number): BackgroundProcess | undefined {
    return processes.get(pid);
}

/** For tests: forget every record without signalling anything. */
export function clearBackgroundProcesses(): void {
    processes.clear();
}
