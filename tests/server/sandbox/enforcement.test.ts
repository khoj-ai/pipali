/**
 * Shell commands in the macOS and Linux sandbox, end to end: Pipali's sandbox config and
 * shell tool against the real sandbox-runtime.
 *
 * Run from outside any existing sandbox, with a network for the curl test:
 *
 *   SANDBOX_INTEGRATION_TESTS=true bun test tests/server/sandbox/enforcement.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDefaultConfig } from '../../../src/server/sandbox/config';
import {
    initializeSandboxWithConfig,
    isSandboxActive,
    shutdownSandbox,
    SANDBOX_TEMP_DIR,
} from '../../../src/server/sandbox';
import { shellCommand } from '../../../src/server/processor/actor/shell_command';
import type { ConfirmationContext } from '../../../src/server/processor/confirmation';

const runHere = (process.platform === 'darwin' || process.platform === 'linux')
    && process.env.SANDBOX_INTEGRATION_TESTS === 'true';
const describeHere = runHere ? describe : describe.skip;

const stamp = Date.now();
const fixtures = path.join(SANDBOX_TEMP_DIR, `sandbox-test-${stamp}`);
const protectedDir = path.join(fixtures, 'protected');
const readableDir = path.join(fixtures, 'readable');
const deniedDir = path.join(fixtures, 'denied');
const insideFile = path.join(fixtures, 'inside.txt');
const unrunnableScript = path.join(readableDir, 'unrunnable.sh');
const deniedFile = path.join(deniedDir, 'escaped.txt');
// Only the sandbox failing would create this
const outsideFile = path.join(os.homedir(), `pipali-sandbox-test-outside-${stamp}.txt`);
const created: string[] = [];

/** Run a command the way the agent does, counting confirmations asked for. */
async function run(command: string) {
    if (!isSandboxActive()) throw new Error('The sandbox is not running');
    let asked = 0;
    const confirmationContext: ConfirmationContext = {
        preferences: { skipConfirmationFor: new Set() },
        requestConfirmation: async (request) => {
            asked++;
            return { requestId: request.requestId, selectedOptionId: 'no', timestamp: new Date().toISOString() };
        },
    };
    const result = await shellCommand(
        { justification: 'sandbox test', command, operation_type: 'read-write', execution_mode: 'sandbox' },
        { confirmationContext },
    );
    return { output: String(result.compiled), asked };
}

/** How macOS names a path in its refusals: resolved, so /tmp reads /private/tmp. */
function resolved(file: string): string {
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
}

function writeFixture(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    created.push(file);
}

describeHere('macOS and Linux sandbox', () => {
    beforeAll(async () => {
        writeFixture(path.join(protectedDir, 'secret.txt'), 'protected-secret-value');
        writeFixture(path.join(readableDir, 'note.txt'), 'readable-note-value');
        fs.mkdirSync(deniedDir, { recursive: true });

        const defaults = getDefaultConfig();
        await initializeSandboxWithConfig({
            ...defaults,
            deniedReadPaths: [...defaults.deniedReadPaths, protectedDir],
            deniedWritePaths: [...defaults.deniedWritePaths, deniedDir],
        });
    });

    afterAll(async () => {
        await shutdownSandbox();
        for (const file of [...created, insideFile, outsideFile, deniedFile]) {
            fs.rmSync(file, { force: true });
        }
        for (const dir of [protectedDir, readableDir, deniedDir, fixtures]) {
            if (fs.existsSync(dir)) fs.rmdirSync(dir);
        }
    });

    test('writes inside its scratch folder without asking', async () => {
        const { asked } = await run(`echo written > '${insideFile}'`);
        expect(asked).toBe(0);
        expect(fs.readFileSync(insideFile, 'utf8').trim()).toBe('written');
    });

    test.each([
        ['outside its write folders', outsideFile],
        ['in a denied folder inside an allowed one', deniedFile],
    ])('is refused a write %s, and says so', async (_, file) => {
        const { output, asked } = await run(`echo escaped > '${file}'`);
        expect(asked).toBe(0);
        expect(fs.existsSync(file)).toBe(false);
        expect(output).toContain('Sandboxed commands write only to');
        // Linux refuses with a read-only bind, which leaves no record to name the path from
        if (process.platform === 'darwin') expect(output).toContain(`- bash: file-write-create ${resolved(file)}`);
    });

    test("reads the user's files, but not a protected path", async () => {
        const readable = await run(`cat '${path.join(readableDir, 'note.txt')}'`);
        expect(readable.asked).toBe(0);
        expect(readable.output).toContain('readable-note-value');

        const secret = await run(`cat '${path.join(protectedDir, 'secret.txt')}'`);
        expect(secret.asked).toBe(0);
        expect(secret.output).not.toContain('protected-secret-value');
    });

    // Linux hides a protected path behind an empty one, so its reads fail as missing files
    test.if(process.platform === 'darwin')('names a refused read the command kept quiet about', async () => {
        const secret = path.join(protectedDir, 'secret.txt');
        const { output } = await run(`cat '${secret}' 2>/dev/null || exit 3`);
        expect(output).toContain('[sandbox_refusal]');
        expect(output).toContain(`- cat: file-read-data ${resolved(secret)}`);
        // With no refusal error to go by, the read may as well have been one a tool probes for
        expect(output).not.toContain('Sandboxed commands write only to');
    });

    test('does not point at the sandbox for a failure it did not cause', async () => {
        // Not executable, which refuses root too
        writeFixture(unrunnableScript, 'echo ran');
        const { output } = await run(`'${unrunnableScript}'`);
        expect(output).toContain('Permission denied');
        expect(output).not.toContain('[sandbox_refusal]');
    });

    test('reaches an allowed domain with curl', async () => {
        // macOS curl links LibreSSL, which reads /etc/ssl/openssl.cnf on startup
        const { output, asked } = await run(`curl -sS -o /dev/null -w '%{http_code}' https://api.github.com`);
        expect(asked).toBe(0);
        expect(output).not.toContain('openssl.cnf');
        expect(output).not.toContain('certificate verify locations');
        expect(output).toMatch(/^200\b/);
    });

    test('reports a refused domain to the run that tried it alone', async () => {
        // The runtime tells commands apart by their first 100 characters
        const sharedPrefix = `: ${'x'.repeat(100)};`;

        const refused = await run(`${sharedPrefix} curl -sS --max-time 10 https://example.com`);
        expect(refused.output).toContain('[sandbox_refusal]');
        expect(refused.output).toContain('example.com');
        expect(refused.output).toContain('Sandboxed commands write only to');

        const later = await run(`${sharedPrefix} echo later >&2`);
        expect(later.output).toContain('later');
        expect(later.output).not.toContain('[sandbox_refusal]');
    });

    test('reports a refused connection the command exited 0 on', async () => {
        // The refusal reaches curl as an HTTP 403, which it exits 0 on without -f
        const { output } = await run(`curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://example.com`);
        expect(output).toMatch(/^403\b/);
        expect(output).not.toContain('[Exit code');
        expect(output).toContain('- network-outbound example.com:80');
    });

    test("passes a Python heredoc's != through as written", async () => {
        // Single quotes beside a ! are the shape that once got it escaped to \!
        const { output, asked } = await run(`python3 - <<'PY'
data = {'key': 'value'}
for k, v in data.items():
    if k != 'missing':
        print(f'{k}={v}')
PY`);
        expect(asked).toBe(0);
        expect(output).not.toContain('SyntaxError');
        expect(output.trim()).toBe('key=value');
    });
});
