/**
 * The settings token reaches the desktop app as one line on the server's stdout, which the
 * app reads by a prefix its Rust code declares on its own.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import path from 'path';
import { announceSettingsToken, settingsTokenForTesting } from '../../src/server/routes/settings-token';

const realWrite = process.stdout.write;

function captureStdout(): string[] {
    const lines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    return lines;
}

describe('settings token', () => {
    afterEach(() => {
        process.stdout.write = realWrite;
        delete process.env.PIPALI_ANNOUNCE_SETTINGS_TOKEN;
    });

    test('is printed only for the desktop app that asked, by the prefix it reads', async () => {
        const lines = captureStdout();
        announceSettingsToken();
        expect(lines).toEqual([]);

        process.env.PIPALI_ANNOUNCE_SETTINGS_TOKEN = '1';
        announceSettingsToken();
        process.stdout.write = realWrite;

        const tauri = await Bun.file(path.join(import.meta.dir, '../../src-tauri/src/lib.rs')).text();
        const prefix = tauri.match(/const SETTINGS_TOKEN_PREFIX: &str = "([^"]+)";/)?.[1];
        expect(prefix).toBeDefined();
        expect(lines).toEqual([`${prefix}${settingsTokenForTesting()}\n`]);
    });
});
