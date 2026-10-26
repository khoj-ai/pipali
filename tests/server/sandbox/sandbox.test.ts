/**
 * The sandbox policy Pipali ships, how it is handed to the runtime, and the path rules its
 * file tools ask by.
 */

import { test, expect, describe } from 'bun:test';
import os from 'os';
import path from 'path';
import { VENDORED_SRT_WIN_EXE } from '@anthropic-ai/sandbox-runtime';
import {
    getDefaultConfig,
    buildRuntimeConfig,
    DEFAULT_DENIED_READ_PATHS,
    type SandboxConfig,
} from '../../../src/server/sandbox/config';
import {
    describeSandboxRefusals,
    getSandboxEnvOverrides,
    initializeSandboxWithConfig,
    isPathDeniedForRead,
    isPathWithinAllowedWrite,
    resolveHostTimezone,
    SANDBOX_TEMP_DIR,
    type PathStyle,
} from '../../../src/server/sandbox';

const WINDOWS: PathStyle = { path: path.win32, home: 'C:\\Users\\alice', caseInsensitive: true };
const LINUX: PathStyle = { path: path.posix, home: '/home/alice', caseInsensitive: false };

describe('default policy', () => {
    test('is on, protects credentials, and lets commands write to scratch space and ~/.pipali', () => {
        const config = getDefaultConfig();

        expect(config.enabled).toBe(true);
        expect(config.deniedReadPaths).toEqual(expect.arrayContaining(['**/.ssh', '~/.ssh', '**/.aws', '~/.aws', '.env', '/etc']));
        expect(config.allowedWritePaths).toEqual(expect.arrayContaining(['/tmp', '/private/tmp', '~/.pipali']));
        if (process.platform === 'darwin') {
            // The user temp dir sits behind the /var symlink, and sandbox-exec matches real paths
            expect(config.allowedWritePaths.some(p => p.startsWith('/private/var/folders/'))).toBe(true);
        }
        // sandbox-runtime rejects a bare wildcard domain
        expect(config.allowedDomains).not.toContain('*');
    });
});

describe('runtime config', () => {
    test('expands home paths and keeps the network and git settings Pipali relies on', () => {
        const config: SandboxConfig = {
            enabled: true,
            allowedWritePaths: ['/tmp', '~/.pipali'],
            deniedWritePaths: ['~/.ssh'],
            deniedReadPaths: ['~/.aws', '.env'],
            allowedDomains: ['github.com'],
            allowLocalBinding: true,
        };

        const { filesystem, network } = buildRuntimeConfig(config);

        expect(filesystem.allowWrite).toEqual(['/tmp', path.join(os.homedir(), '.pipali')]);
        expect(filesystem.denyWrite).toEqual([path.join(os.homedir(), '.ssh')]);
        expect(filesystem.denyRead).toEqual([path.join(os.homedir(), '.aws'), '.env']);
        expect(filesystem.allowGitConfig).toBe(true);
        expect(network.allowedDomains).toEqual(['github.com']);
        expect(network.deniedDomains).toEqual([]);
        expect(network.allowLocalBinding).toBe(true);
        expect(network.allowAllUnixSockets).toBe(true);
    });
});

describe('on Windows', () => {
    const home = os.homedir();

    test('gives sandboxed commands a scratch folder the user can reach', () => {
        const config = getDefaultConfig('win32');
        expect(config.allowedWritePaths).toEqual(['~/.pipali', path.join(os.tmpdir(), 'pipali')]);
        expect(config.deniedReadPaths).toEqual(expect.arrayContaining([
            ...DEFAULT_DENIED_READ_PATHS,
            '~/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine',
            '~/AppData/Roaming/gcloud',
            '_netrc',
        ]));
    });

    test('leaves reads of the profile to its setup grant and turns every deny into a concrete path', () => {
        const { filesystem, windows } = buildRuntimeConfig(getDefaultConfig('win32'), 'win32');

        // The runtime refuses a session grant that reaches a credential store the setup excluded
        expect(filesystem.allowRead).toEqual([]);
        expect(filesystem.allowWrite).toEqual([path.join(home, '.pipali'), path.join(os.tmpdir(), 'pipali')]);
        expect(windows?.srtWin?.path).toBe(VENDORED_SRT_WIN_EXE);

        // Anywhere and file-name patterns guard the copy in the home folder, once each
        const denyRead = filesystem.denyRead as string[];
        expect(denyRead.filter(p => p === path.join(home, '.ssh'))).toHaveLength(1);
        expect(denyRead).toContain(path.join(home, '.npmrc'));
        expect(denyRead).toContain(path.join(home, '_netrc'));
        expect(denyRead).toContain(path.join(home, 'AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine'));
        expect(denyRead).toContain(path.join(home, 'AppData/Roaming/gcloud'));
        expect(denyRead.every(p => path.isAbsolute(p))).toBe(true);
    });

    test('lets the sandbox account run the bundled runtimes', () => {
        const previous = process.env.PIPALI_BUNDLED_RUNTIMES_DIR;
        process.env.PIPALI_BUNDLED_RUNTIMES_DIR = path.join(home, 'AppData', 'Local', 'Pipali');
        try {
            const { filesystem } = buildRuntimeConfig(getDefaultConfig('win32'), 'win32');
            expect(filesystem.allowRead).toEqual([path.join(home, 'AppData', 'Local', 'Pipali')]);
            expect(filesystem.allowWrite).not.toContain(path.join(home, 'AppData', 'Local', 'Pipali'));
        } finally {
            if (previous === undefined) delete process.env.PIPALI_BUNDLED_RUNTIMES_DIR;
            else process.env.PIPALI_BUNDLED_RUNTIMES_DIR = previous;
        }
    });
});

describe('isPathDeniedForRead', () => {
    test('scopes the /etc/ssl carve-out to that directory alone', () => {
        expect(isPathDeniedForRead('/etc/ssl/cert.pem')).toBe(false);
        expect(isPathDeniedForRead('/private/etc/ssl/openssl.cnf')).toBe(false);
        // Neighbours and prefix look-alikes stay denied
        expect(isPathDeniedForRead('/etc/sslkeys/private.key')).toBe(true);
        expect(isPathDeniedForRead('/private/etc/sudoers')).toBe(true);
    });

    test('denies protected Windows paths however their case and separators are spelled', () => {
        expect(isPathDeniedForRead('c:\\users\\ALICE\\.SSH\\id_rsa', WINDOWS)).toBe(true);
        expect(isPathDeniedForRead('C:/Users/alice/.ssh/config', WINDOWS)).toBe(true);
        expect(isPathDeniedForRead('D:\\backup\\.Aws\\credentials', WINDOWS)).toBe(true);
        expect(isPathDeniedForRead('C:\\work\\app\\.ENV.local', WINDOWS)).toBe(true);
        // Look-alikes stay readable
        expect(isPathDeniedForRead('C:\\Users\\alice\\.ssh-notes.txt', WINDOWS)).toBe(false);
        expect(isPathDeniedForRead('C:\\work\\app\\.envrc', WINDOWS)).toBe(false);
    });

    test('folds case exactly where the filesystem does', () => {
        const macos: PathStyle = { path: path.posix, home: '/Users/alice', caseInsensitive: true };
        expect(isPathDeniedForRead('/Users/alice/.SSH/id_rsa', macos)).toBe(true);
        expect(isPathDeniedForRead('/home/alice/.SSH/id_rsa', LINUX)).toBe(false);
    });

    test('applies drive-letter and home rules added on Windows', async () => {
        await initializeSandboxWithConfig({
            ...getDefaultConfig(),
            enabled: false,
            deniedReadPaths: ['D:\\Finance', '~\\Taxes'],
        });
        try {
            expect(isPathDeniedForRead('d:\\finance\\2026\\payroll.xlsx', WINDOWS)).toBe(true);
            expect(isPathDeniedForRead('D:\\Finance-public\\report.pdf', WINDOWS)).toBe(false);
            expect(isPathDeniedForRead('C:\\Users\\alice\\Taxes\\2026.pdf', WINDOWS)).toBe(true);
        } finally {
            await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false });
        }
    });
});

describe('isPathWithinAllowedWrite', () => {
    test('lets a denied folder inside an allowed one win, and on Windows matches any case', async () => {
        await initializeSandboxWithConfig({
            ...getDefaultConfig(),
            enabled: false,
            allowedWritePaths: ['~/.pipali'],
            deniedWritePaths: ['~/.pipali/skills'],
        });
        try {
            expect(isPathWithinAllowedWrite('/home/alice/.pipali/notes.md', LINUX)).toBe(true);
            expect(isPathWithinAllowedWrite('/home/alice/.pipali/skills/x/SKILL.md', LINUX)).toBe(false);
            expect(isPathWithinAllowedWrite('/home/alice/.pipali-evil/x', LINUX)).toBe(false);

            expect(isPathWithinAllowedWrite('C:\\Users\\Alice\\.Pipali\\notes.md', WINDOWS)).toBe(true);
            expect(isPathWithinAllowedWrite('c:\\users\\alice\\.pipali\\SKILLS\\x\\SKILL.md', WINDOWS)).toBe(false);
            expect(isPathWithinAllowedWrite('C:\\Users\\alice\\.pipali-evil\\x', WINDOWS)).toBe(false);
        } finally {
            await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false });
        }
    });
});

describe('describeSandboxRefusals', () => {
    // Windows' ACLs and Linux's read-only binds refuse without a record, leaving the error
    test.each([
        ['win32', 1, "Set-Content : Access to the path 'C:\\Users\\alice\\out.txt' is denied.", true],
        ['linux', 1, 'bash: /home/alice/out.txt: Read-only file system', true],
        ['linux', 1, 'cat: /tmp/locked.txt: Permission denied', false],
        ['darwin', 0, 'mkdir: /Users/alice/out: Operation not permitted', false],
    ] as const)('on %s, exit %d with %p, points at the sandbox: %p', async (platform, exitCode, errors, told) => {
        const note = await describeSandboxRefusals(crypto.randomUUID(), { exitCode, errors }, platform);
        expect(note.startsWith('[sandbox_refusal]')).toBe(told);
    });
});

describe('getSandboxEnvOverrides', () => {
    test('points temp files and tool caches at the sandbox scratch folder', () => {
        const env = getSandboxEnvOverrides();

        expect(env.TMPDIR).toBe(SANDBOX_TEMP_DIR);
        // System git config sits under /etc, which the sandbox denies
        expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
        expect(env.UV_CACHE_DIR).toContain(SANDBOX_TEMP_DIR);
        expect(env.PIP_CACHE_DIR).toContain(SANDBOX_TEMP_DIR);
        expect(env.npm_config_cache).toContain(SANDBOX_TEMP_DIR);
        expect(env.BUN_INSTALL_CACHE_DIR).toContain(SANDBOX_TEMP_DIR);
    });

    test('preserves an explicitly set TZ instead of replacing it with the host zone', () => {
        const original = process.env.TZ;
        const originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        process.env.TZ = 'Asia/Kolkata';
        try {
            // Forwarded, not overridden - and reaches the child env shell_command builds,
            // which a bare spread would miss since Bun hides an assigned TZ from it
            expect(getSandboxEnvOverrides().TZ).toBe('Asia/Kolkata');
            expect({ ...process.env, ...getSandboxEnvOverrides() }.TZ).toBe('Asia/Kolkata');
        } finally {
            // Bun re-inits its clock on assignment but not on delete, so name the old zone
            // before clearing the var - otherwise every later test runs in Kolkata
            process.env.TZ = original ?? originalZone;
            if (original === undefined) delete process.env.TZ;
        }
    });
});

describe('resolveHostTimezone', () => {
    test('reports no zone rather than a bogus one when the host resolves UTC or fails', () => {
        const original = Intl.DateTimeFormat;
        try {
            // A UTC host tells us nothing about the real zone, so claim nothing
            Intl.DateTimeFormat = (() => ({ resolvedOptions: () => ({ timeZone: 'UTC' }) })) as never;
            expect(resolveHostTimezone()).toBe('');

            // Same when the platform can't answer at all
            Intl.DateTimeFormat = (() => { throw new Error('no ICU data'); }) as never;
            expect(resolveHostTimezone()).toBe('');
        } finally {
            Intl.DateTimeFormat = original;
        }
    });
});
