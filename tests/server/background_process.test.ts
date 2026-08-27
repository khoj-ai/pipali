/**
 * Background Process Tests
 *
 * Commands started with run_in_background outlive the tool call. What has to hold:
 * output is readable from a file while the command runs, stopping takes the whole
 * process tree rather than just the shell wrapper, and a stop reaches only the
 * conversation that asked for it.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { User } from '../../src/server/db/schema';

// Keep logs out of the developer's real ~/.pipali.
process.env.PIPALI_BACKGROUND_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pipali-bg-'));

import {
    startBackgroundProcess,
    stopBackgroundProcess,
    stopBackgroundProcessesFor,
    clearBackgroundProcesses,
} from '../../src/server/events/background-processes';
import { stopProcess } from '../../src/server/processor/actor/shell_command';

const user = { id: 1 } as typeof User.$inferSelect;
const startedPids: number[] = [];

function start(command: string, conversationId = 'conv-1') {
    const record = startBackgroundProcess({
        cmd: ['/bin/bash', '-c', command],
        cwd: process.cwd(),
        env: process.env,
        command,
        conversationId,
        user,
    });
    startedPids.push(record.pid);
    return record;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

afterEach(() => {
    for (const pid of startedPids.splice(0)) {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            // Already gone.
        }
    }
    clearBackgroundProcesses();
});

describe('background commands', () => {
    test('both streams are readable from the log while the command still runs', async () => {
        const record = start('echo to-stdout; echo to-stderr >&2; sleep 30');

        await Bun.sleep(300);
        const contents = fs.readFileSync(record.logPath, 'utf8');
        expect(contents).toContain('to-stdout');
        expect(contents).toContain('to-stderr');
        // Readable before the command ends: a pipe nobody drains would block it instead.
        expect(record.running).toBe(true);
    });

    test('stopping kills what the command spawned, not just the shell', async () => {
        // `sleep` is a separate process from the bash wrapper. Signalling the wrapper
        // alone would leave it running - which is what a dev server would do.
        const record = start('sleep 30 & echo CHILD=$!; wait');

        await Bun.sleep(300);
        const childPid = Number(fs.readFileSync(record.logPath, 'utf8').match(/CHILD=(\d+)/)?.[1]);
        expect(childPid).toBeGreaterThan(0);
        expect(isAlive(childPid)).toBe(true);

        expect(stopBackgroundProcess(record.pid)).toBe(true);
        await Bun.sleep(500);

        expect(isAlive(record.pid)).toBe(false);
        expect(isAlive(childPid)).toBe(false);
    });

    test('hitting the limit says what is running, so a stale one can be picked', () => {
        const theirs = start('sleep 30 # another chat', 'conv-theirs');

        const mine: ReturnType<typeof start>[] = [];
        let message = '';
        while (!message && mine.length < 50) {
            try {
                mine.push(start('sleep 30 # my job', 'conv-mine'));
            } catch (error) {
                message = (error as Error).message;
            }
        }

        // A bare pid is not enough to choose with, least of all one this conversation
        // never started - the cap is shared across all of them.
        expect(message).toContain(`pid ${theirs.pid}`);
        expect(message).toContain(`started in conversation: ${theirs.conversationId}`);
        expect(message).toContain(`pid ${mine[0]!.pid}`);
        expect(message).toContain('started here');
        expect(message).toContain('my job');
        expect(message).toContain(mine[0]!.logPath);

        // And it is told what to do about it.
        expect(message).toContain('stop_process');
        expect(message).toMatch(/ask the user/i);
    });

    test('stopping a conversation stops only its own commands', async () => {
        const mine = start('sleep 30', 'conv-mine');
        const theirs = start('sleep 30', 'conv-theirs');

        const stopped = stopBackgroundProcessesFor('conv-mine');
        await Bun.sleep(500);

        expect(stopped).toEqual([mine.pid]);
        expect(isAlive(mine.pid)).toBe(false);
        expect(isAlive(theirs.pid)).toBe(true);
    });
});

describe('stop_process', () => {
    test('reports an unknown pid rather than signalling it', () => {
        expect(stopProcess({ pid: 999_999 }).compiled).toContain('no background command');
    });

    test('reports how a command that already ended exited', async () => {
        const record = start('exit 3');
        await Bun.sleep(500);

        expect(stopProcess({ pid: record.pid }).compiled).toContain('already exited with code 3');
    });
});
