import { test, expect, describe, afterEach, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isShellFindCommand, extractFindPath, truncateToolOutput } from '../../src/server/processor/director/index';
import { shellCommand, type ShellCommandArgs } from '../../src/server/processor/actor/shell_command';
import {
    CONFIRMATION_OPTIONS,
    createEmptyPreferences,
    createFileOperationConfirmation,
    getConfirmationKey,
    grantCovers,
    type ConfirmationContext,
    type ConfirmationRequest,
} from '../../src/server/processor/confirmation';
import { createRunHandle, getOrCreateBus, removeBus, type ConversationEvent } from '../../src/server/events/conversation-event-bus';
import { createConfirmationCallback, handleConfirmationResponse } from '../../src/server/routes/ws/confirmation-manager';

describe('isShellFindCommand', () => {
    test('detects find as standalone command or after chain operators', () => {
        expect(isShellFindCommand('find . -name "*.ts"')).toBe(true);
        expect(isShellFindCommand('cd /tmp && find . -type f')).toBe(true);
        expect(isShellFindCommand('echo test | find . -name "*.ts"')).toBe(true);
        expect(isShellFindCommand('cd /tmp; find . -name "*.log"')).toBe(true);
    });

    test('does not match find as substring in other words or quoted strings', () => {
        expect(isShellFindCommand('findutils --version')).toBe(false);
        expect(isShellFindCommand('grep -r "find" .')).toBe(false);
        expect(isShellFindCommand('mdfind -name test')).toBe(false);
    });

    test('ignores heredoc bodies, which are interpreter payloads not shell syntax', () => {
        expect(isShellFindCommand("python3 << 'EOF'\n# parse the payload; find target_query\nEOF")).toBe(false);
        expect(isShellFindCommand('cat <<EOF\nrun this; find ~ -name "*.md"\nEOF')).toBe(false);
        // A real find still wins when it precedes the heredoc
        expect(isShellFindCommand("find ~ -type f && python3 << 'EOF'\npass\nEOF")).toBe(true);
    });
});

describe('extractFindPath', () => {
    test('extracts path from simple find commands', () => {
        expect(extractFindPath('find ~ -name "*.ts"')).toBe('~');
        expect(extractFindPath('find ~/Documents -type f')).toBe('~/Documents');
        expect(extractFindPath('find /tmp -name "*.log"')).toBe('/tmp');
        expect(extractFindPath('find . -name "*.ts"')).toBe('.');
    });

    test('extracts path from chained find commands', () => {
        expect(extractFindPath('cd /tmp && find ~/Code -type f')).toBe('~/Code');
    });

    test('returns undefined when find has no path (only options)', () => {
        expect(extractFindPath('find -name "*.ts"')).toBeUndefined();
    });

    test('returns undefined for non-find commands', () => {
        expect(extractFindPath('ls -la')).toBeUndefined();
    });

    test('returns undefined for find-like text inside a heredoc body', () => {
        expect(extractFindPath("python3 << 'EOF'\n# parse the payload; find target_query\nEOF")).toBeUndefined();
    });
});

/**
 * A foreground shell_command has to hand the turn back on time. What has to hold: a
 * timeout stops the command along with what it started, and a process the command
 * leaves running can neither hold the call open nor be killed by it returning.
 */
describe.skipIf(process.platform === 'win32')('shell command timeouts', () => {
    const leftRunning: number[] = [];

    async function run(command: string, timeout: number = 1000) {
        const startedAt = Date.now();
        const { compiled } = await shellCommand({
            justification: 'test',
            command,
            read_only: false,
            execution_mode: 'direct',
            timeout,
        });
        return { output: compiled, elapsedMs: Date.now() - startedAt };
    }

    function childPid(output: string): number {
        const pid = Number(output.match(/CHILD=(\d+)/)?.[1]);
        expect(pid).toBeGreaterThan(0);
        return pid;
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
        for (const group of leftRunning.splice(0)) {
            try {
                process.kill(-group, 'SIGKILL');
            } catch {
                // Already gone.
            }
        }
    });

    test('a timeout ends a compound command, keeps what it printed and says so', async () => {
        // The shell is not the only process here, so killing it alone leaves `sleep`
        // holding the output pipe open.
        const { output, elapsedMs } = await run('echo before; sleep 20; echo after');

        expect(elapsedMs).toBeLessThan(5_000);
        expect(output).toContain('before');
        expect(output).not.toContain('after');
        expect(output).toContain('1000ms timeout');
        // BashCommandView marks a result as failed by this
        expect(output).toContain('[Exit code:');
    });

    test('a timeout stops what the command started', async () => {
        const { output } = await run('sleep 20 & echo CHILD=$!; wait');
        const pid = childPid(output);

        await Bun.sleep(300);
        expect(isAlive(pid)).toBe(false);
    });

    test('a timeout stops a command that ignores SIGTERM', async () => {
        const { output, elapsedMs } = await run(`trap '' TERM; sleep 20; echo after`);

        expect(elapsedMs).toBeLessThan(8_000);
        expect(output).not.toContain('after');
        expect(output).toContain('1000ms timeout');
    });

    test('a timed out command that exits cleanly still reads as failed', async () => {
        const { output } = await run(`trap 'exit 0' TERM; sleep 20 & wait`);

        expect(output).toContain('[Exit code:');
        expect(output).toContain('1000ms timeout');
    });

    test('a command too chatty to keep stays bounded and still reports its timeout', async () => {
        const { output } = await run('yes');

        expect(output.length).toBeLessThan(1_000_000);
        // The tool result keeps the start of a long output and drops the rest
        expect(truncateToolOutput(output)).toContain('1000ms timeout');
        expect(truncateToolOutput(output)).toContain('[Exit code:');
    });

    test('a malformed timeout falls back to the default', async () => {
        const { output } = await run('echo before; sleep 1; echo after', 'soon' as unknown as number);

        expect(output).toContain('after');
        expect(output).not.toContain('timeout');
    });

    test('a process left running does not hold the call open, and is reported', async () => {
        // `&` backgrounds the whole list while the redirect covers only `sleep`, so the
        // subshell running the list keeps the output pipe for as long as `sleep` lasts.
        const { output, elapsedMs } = await run('true && sleep 10 > /dev/null 2>&1 & echo CHILD=$! GROUP=$$', 30_000);
        leftRunning.push(Number(output.match(/GROUP=(\d+)/)?.[1]));

        expect(elapsedMs).toBeLessThan(5_000);
        expect(isAlive(childPid(output))).toBe(true);
        expect(output).toContain('still running');
        expect(output).not.toContain('timeout');
    });

    test('a process left running can still write once the call has returned', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipali-shell-'));
        const marker = path.join(dir, 'survived');

        // Closing the pipe on return would kill this with SIGPIPE before it reaches touch.
        const { output } = await run(`(sleep 2; echo late; touch ${marker}) & echo started`, 30_000);
        expect(output).not.toContain('late');

        await Bun.sleep(2_000);
        expect(fs.existsSync(marker)).toBe(true);
        fs.unlinkSync(marker);
        fs.rmdirSync(dir);
    });

    test('characters split across output chunks stay intact', async () => {
        const { output } = await run(`yes 'नमस्ते' | head -n 20000`, 5_000);

        expect(output).not.toContain('�');
        expect(output.split('\n')).toHaveLength(20_000);
    });
});

describe('shell command read_only', () => {
    test('a command without a boolean read_only is refused before it asks or runs', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipali-read-only-'));
        const marker = path.join(dir, 'ran');
        const asked: ConfirmationRequest[] = [];
        const context: ConfirmationContext = {
            preferences: createEmptyPreferences(),
            requestConfirmation: async request => {
                asked.push(request);
                return { requestId: request.requestId, selectedOptionId: CONFIRMATION_OPTIONS.YES, timestamp: new Date().toISOString() };
            },
        };
        const base = { justification: 'test', command: `echo x > ${marker}`, execution_mode: 'direct', cwd: dir };

        try {
            for (const args of [
                base,
                { ...base, operation_type: 'read-only' },
                ...[undefined, 'false', 'true', 0, null].map(read_only => ({ ...base, read_only })),
            ]) {
                const { compiled } = await shellCommand(args as unknown as ShellCommandArgs, { confirmationContext: context });
                expect(compiled).toBe('Error: read_only is required and must be a boolean, true or false');
            }
            expect(asked).toHaveLength(0);
            expect(fs.existsSync(marker)).toBe(false);
        } finally {
            if (fs.existsSync(marker)) fs.unlinkSync(marker);
            fs.rmdirSync(dir);
        }
    });
});

/**
 * "Yes, don't ask again" to a direct-mode command covers later commands of its operation
 * type in its working directory and that directory's subfolders.
 */
describe('direct-mode command grants', () => {
    let root: string;
    let project: string;
    let nested: string;
    let prefixTwin: string;

    function command(cwd: string, readOnly: boolean, context: ConfirmationContext) {
        return shellCommand(
            { justification: 'test', command: 'echo ok', read_only: readOnly, execution_mode: 'direct', cwd },
            { confirmationContext: context },
        );
    }

    function grantingContext(asked: ConfirmationRequest[]): ConfirmationContext {
        return {
            preferences: createEmptyPreferences(),
            requestConfirmation: async request => {
                asked.push(request);
                return { requestId: request.requestId, selectedOptionId: CONFIRMATION_OPTIONS.YES_DONT_ASK, timestamp: new Date().toISOString() };
            },
        };
    }

    function commandRequest(workdir: string): ConfirmationRequest {
        return createFileOperationConfirmation('execute_command', workdir, {
            toolName: 'shell_command',
            toolArgs: {},
            operationSubType: 'read-write',
            commandInfo: { command: 'echo ok', reason: 'test', workdir },
        });
    }

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipali-grants-'));
        project = path.join(root, 'project');
        nested = path.join(project, 'nested');
        prefixTwin = path.join(root, 'project-old');
        fs.mkdirSync(nested, { recursive: true });
        fs.mkdirSync(prefixTwin);
    });

    afterAll(() => {
        fs.rmdirSync(nested);
        fs.rmdirSync(project);
        fs.rmdirSync(prefixTwin);
        fs.rmdirSync(root);
    });

    test('a grant holds in its folder and subfolders, for its operation type alone', async () => {
        const asked: ConfirmationRequest[] = [];
        const context = grantingContext(asked);

        expect((await command(project, false, context)).compiled).toBe('ok');
        expect((await command(nested, false, context)).compiled).toBe('ok');
        expect((await command(path.join(nested, '..') + path.sep, false, context)).compiled).toBe('ok');
        expect(asked.map(r => r.context?.commandInfo?.workdir)).toEqual([project]);

        await command(prefixTwin, false, context);
        await command(project, true, context);
        await command(root, false, context);
        expect(asked.map(r => [r.context?.commandInfo?.workdir, r.context?.operationType])).toEqual([
            [project, 'read-write'],
            [prefixTwin, 'read-write'],
            [project, 'read-only'],
            [root, 'read-write'],
        ]);
    });

    test('a grant in the home folder, a folder holding it or a filesystem root covers that folder alone', () => {
        const home = os.homedir();
        const homeLink = path.join(root, 'home-link');
        fs.symlinkSync(home, homeLink, 'junction');

        try {
            for (const folder of [home, path.dirname(home), path.parse(home).root, homeLink]) {
                const grant = getConfirmationKey(commandRequest(folder));
                expect(grantCovers(grant, commandRequest(folder))).toBe(true);
                expect(grantCovers(grant, commandRequest(path.join(folder, 'Documents')))).toBe(false);
            }
            expect(grantCovers(getConfirmationKey(commandRequest(project)), commandRequest(nested))).toBe(true);
        } finally {
            fs.unlinkSync(homeLink);
        }
    });

    test('a grant answers commands already waiting in its folder tree, and leaves the rest waiting', async () => {
        const conversationId = crypto.randomUUID();
        const bus = getOrCreateBus(conversationId);
        const runHandle = createRunHandle('run-1', 'client-message-1', conversationId);
        bus.activeRun = runHandle;
        const raised: ConfirmationRequest[] = [];
        const unsubscribe = bus.subscribe((event: ConversationEvent) => {
            if (event.type === 'confirmation_request') raised.push(event.data as ConfirmationRequest);
        });
        const context: ConfirmationContext = {
            preferences: createEmptyPreferences(),
            requestConfirmation: createConfirmationCallback(bus, conversationId, runHandle),
        };
        const raisedIn = (folder: string) => raised.find(r => r.context?.commandInfo?.workdir === folder)!;

        try {
            const runs = [
                command(project, false, context),
                command(prefixTwin, false, context),
                command(nested, false, context),
            ];
            while (raised.length < runs.length) await Bun.sleep(10);

            const resolved = handleConfirmationResponse(runHandle, {
                requestId: raisedIn(project).requestId,
                selectedOptionId: CONFIRMATION_OPTIONS.YES_DONT_ASK,
                timestamp: new Date().toISOString(),
            });
            expect(resolved).toEqual([raisedIn(project).requestId, raisedIn(nested).requestId]);
            expect([...runHandle.pendingConfirmations.keys()]).toEqual([raisedIn(prefixTwin).requestId]);

            handleConfirmationResponse(runHandle, {
                requestId: raisedIn(prefixTwin).requestId,
                selectedOptionId: CONFIRMATION_OPTIONS.NO,
                timestamp: new Date().toISOString(),
            });
            const outputs = (await Promise.all(runs)).map(result => result.compiled);
            expect(outputs[0]).toBe('ok');
            expect(outputs[1]).toContain('cancelled');
            expect(outputs[2]).toBe('ok');
        } finally {
            unsubscribe();
            removeBus(conversationId);
        }
    });
});
