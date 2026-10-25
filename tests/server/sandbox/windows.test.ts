/**
 * Shell commands in the Windows sandbox, end to end: Pipali's sandbox module and shell
 * tool against the real srt-win runtime.
 *
 * Run on Windows from a terminal in an interactive desktop session (RDP or console).
 * The sandbox cannot start commands from session 0, which is where SSM, services and
 * scheduled tasks without /it run.
 *
 *   1. One-time setup, one UAC prompt: Settings > Sandbox > Set up in Pipali, or
 *      bunx @anthropic-ai/sandbox-runtime windows-install --allow-loopback
 *      Run it again on a machine set up by an earlier sandbox-runtime release.
 *   2. $env:SANDBOX_INTEGRATION_TESTS = 'true'
 *      bun test tests/server/sandbox/windows.test.ts
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { VENDORED_SRT_WIN_EXE, checkWindowsSandboxStatusAsync, resolveSrtWin } from '@anthropic-ai/sandbox-runtime';
import { getDefaultConfig } from '../../../src/server/sandbox/config';
import {
    getSandboxStartError,
    initializeSandboxWithConfig,
    isSandboxActive,
    shutdownSandbox,
    SANDBOX_TEMP_DIR,
} from '../../../src/server/sandbox';
import { shellCommand } from '../../../src/server/processor/actor/shell_command';
import type { ConfirmationContext } from '../../../src/server/processor/confirmation';

const runHere = process.platform === 'win32' && process.env.SANDBOX_INTEGRATION_TESTS === 'true';
const describeHere = runHere ? describe : describe.skip;

setDefaultTimeout(60_000);

const home = os.homedir();
const stamp = Date.now();
// Setup makes the profile readable as it is then. Documents is granted whole, so fixtures
// made in it later are readable unless denied.
const fixtures = path.join(home, 'Documents', `pipali-sandbox-test-${stamp}`);
const protectedDir = path.join(fixtures, 'protected');
const lateProtectedDir = path.join(fixtures, 'late');
const protectedFile = path.join(fixtures, 'token.txt');
const readableDir = path.join(fixtures, 'readable');
const outsideFile = path.join(home, `pipali-sandbox-test-outside-${stamp}.txt`);
const insideFile = path.join(SANDBOX_TEMP_DIR, `sandbox-test-inside-${stamp}.txt`);
const pidFile = path.join(SANDBOX_TEMP_DIR, `sandbox-test-pid-${stamp}.txt`);
const created: string[] = [];

/**
 * Why the sandbox is not running, with srt-win's own account of its setup. The server log
 * says the same, but bun test drops it unless NODE_ENV=production.
 */
async function whyNotRunning(): Promise<string> {
    const reason = getSandboxStartError() ?? 'The sandbox account is missing: run the one-time setup.';
    try {
        const { user, wfp } = await checkWindowsSandboxStatusAsync({
            srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }),
        });
        return `${reason} (srt-win status: account provisioned=${user.provisioned}, ` +
            `credential readable=${user.credPresent}, setup version=${user.markerVersion} ` +
            `of ${user.setupVersion}, profile grant=${user.profileGrant?.state ?? 'none'}, ` +
            `network filters=${wfp.state}, loopback open=${wfp.allowLoopback})`;
    } catch (error) {
        return `${reason} (srt-win status failed: ${(error as Error).message})`;
    }
}

/**
 * Run a command the way the agent does, counting confirmations asked for. Refuses while the
 * sandbox is down, where the command would only go to the user and be declined.
 */
async function run(command: string, timeout?: number) {
    if (!isSandboxActive()) {
        throw new Error(`The sandbox is not running: ${await whyNotRunning()}`);
    }
    let asked = 0;
    const confirmationContext: ConfirmationContext = {
        preferences: { skipConfirmationFor: new Set() },
        requestConfirmation: async (request) => {
            asked++;
            return { requestId: request.requestId, selectedOptionId: 'no', timestamp: new Date().toISOString() };
        },
    };
    const result = await shellCommand(
        { justification: 'windows sandbox test', command, operation_type: 'read-write', execution_mode: 'sandbox', timeout },
        { confirmationContext },
    );
    return { output: String(result.compiled), asked };
}

function writeFixture(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    created.push(file);
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: it exists, under the sandbox account
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

describeHere('Windows sandbox', () => {
    beforeAll(async () => {
        writeFixture(path.join(protectedDir, 'secret.txt'), 'protected-secret-value');
        writeFixture(path.join(readableDir, 'note.txt'), 'readable-note-value');
        writeFixture(protectedFile, 'original-token-value');

        const started = performance.now();
        await initializeSandboxWithConfig({
            ...getDefaultConfig(),
            deniedReadPaths: [...getDefaultConfig().deniedReadPaths, protectedDir, lateProtectedDir, protectedFile],
        });
        const ms = Math.round(performance.now() - started);
        console.log(isSandboxActive()
            ? `Sandbox started in ${ms} ms`
            : `Sandbox did not start (${ms} ms): ${await whyNotRunning()}`);
    });

    afterAll(async () => {
        await shutdownSandbox();
        for (const file of [...created, insideFile, outsideFile, pidFile]) {
            fs.rmSync(file, { force: true });
        }
        for (const dir of [protectedDir, lateProtectedDir, readableDir, fixtures]) {
            if (fs.existsSync(dir)) fs.rmdirSync(dir);
        }
    });

    test('starts', async () => {
        if (!isSandboxActive()) {
            throw new Error(`The sandbox did not start: ${await whyNotRunning()}`);
        }
    });

    test('runs PowerShell without asking', async () => {
        const { output, asked } = await run(`Write-Output 'hello from the sandbox'`);
        expect(asked).toBe(0);
        expect(output).toContain('hello from the sandbox');
    });

    test('writes inside its scratch folder', async () => {
        const { asked } = await run(`Set-Content -LiteralPath '${insideFile}' -Value 'written'`);
        expect(asked).toBe(0);
        expect(fs.readFileSync(insideFile, 'utf8').trim()).toBe('written');
    });

    test('is refused writes elsewhere, and says so', async () => {
        const { output } = await run(`Set-Content -LiteralPath '${outsideFile}' -Value 'escaped'`);
        expect(fs.existsSync(outsideFile)).toBe(false);
        expect(output).toContain('Sandbox violation');
    });

    test("reads the user's files", async () => {
        const { output, asked } = await run(`Get-Content -LiteralPath '${path.join(readableDir, 'note.txt')}'`);
        expect(asked).toBe(0);
        expect(output).toContain('readable-note-value');
    });

    test("points ~ and the home variables at the user's home", async () => {
        const { output, asked } = await run('(Resolve-Path ~).Path; $HOME; $env:USERPROFILE');
        expect(asked).toBe(0);
        expect(output.toLowerCase().split(/\r?\n/).map(line => line.trim())).toEqual(Array(3).fill(home.toLowerCase()));
    });

    test('cannot read a protected path', async () => {
        const { output, asked } = await run(`Get-Content -LiteralPath '${path.join(protectedDir, 'secret.txt')}'`);
        expect(asked).toBe(0);
        expect(output).not.toContain('protected-secret-value');
        expect(output).toMatch(/denied/i);
    });

    test('cannot read a protected path created after it started, and left no placeholder for it', async () => {
        expect(fs.existsSync(lateProtectedDir)).toBe(false);
        writeFixture(path.join(lateProtectedDir, 'secret.txt'), 'late-secret-value');

        const { output, asked } = await run(`Get-Content -LiteralPath '${path.join(lateProtectedDir, 'secret.txt')}'`);
        expect(asked).toBe(0);
        expect(output).not.toContain('late-secret-value');
        expect(output).toMatch(/denied/i);
    });

    test('cannot read a protected file written anew under its name after it started', async () => {
        // The way npm login and docker login save credentials: a new file renamed over the old
        fs.writeFileSync(`${protectedFile}.new`, 'replaced-token-value');
        fs.renameSync(`${protectedFile}.new`, protectedFile);

        const { output, asked } = await run(`Get-Content -LiteralPath '${protectedFile}'`);
        expect(asked).toBe(0);
        expect(output).not.toContain('replaced-token-value');
        expect(output).toMatch(/denied/i);
    });

    test('runs bun', async () => {
        const { output, asked } = await run('bun --version');
        expect(asked).toBe(0);
        expect(output).toMatch(/\d+\.\d+\.\d+/);
    });

    test('runs git', async () => {
        if (!Bun.which('git')) return;
        const { output } = await run('git --version');
        expect(output).toContain('git version');
    });

    test('reaches an allowed domain through its proxy', async () => {
        const { output } = await run(`bun -e "const r = await fetch('https://github.com'); console.log('status', r.status)"`);
        expect(output).toMatch(/status (200|301|302)/);
    });

    test('is refused other domains, and the refusal is annotated', async () => {
        const { output } = await run(`bun -e "await fetch('https://example.com')"`);
        expect(output).not.toMatch(/status \d+/);
        expect(output).toContain('example.com');
        expect(output).toContain('<sandbox_violations>');
    });

    test('leaves nothing running once a command times out', async () => {
        const started = Date.now();
        await run(`$PID | Set-Content -LiteralPath '${pidFile}'; Start-Sleep -Seconds 60`, 3_000);
        expect(Date.now() - started).toBeLessThan(30_000);

        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        const deadline = Date.now() + 10_000;
        while (processExists(pid) && Date.now() < deadline) {
            await Bun.sleep(250);
        }
        expect(processExists(pid)).toBe(false);
    });
});
