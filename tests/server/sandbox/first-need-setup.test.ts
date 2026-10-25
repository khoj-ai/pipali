/**
 * On Windows the sandbox needs a one-time setup, behind a UAC prompt. The first command that
 * needs it raises that prompt, once, and a "no" is not asked again.
 *
 * The runtime's failure to start is produced by making its initialize throw, the way it does
 * before the sandbox account exists, and setup stands in for the install behind the prompt.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { getDefaultConfig } from '../../../src/server/sandbox/config';
import {
    initializeSandboxWithConfig,
    isSandboxActive,
    setUpSandboxOnFirstNeed,
} from '../../../src/server/sandbox';

const realInitialize = SandboxManager.initialize;
const realDataDir = process.env.PIPALI_DATA_DIR;
let dataDir: string;

async function startWithoutSetup() {
    SandboxManager.initialize = async () => {
        throw new Error('Sandbox dependencies not available: Sandbox user is not provisioned');
    };
    await initializeSandboxWithConfig(getDefaultConfig());
}

describe('Windows sandbox setup on first need', () => {
    beforeEach(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipali-first-need-'));
        process.env.PIPALI_DATA_DIR = dataDir;
        await startWithoutSetup();
    });

    afterEach(async () => {
        SandboxManager.initialize = realInitialize;
        await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false });
        if (realDataDir === undefined) delete process.env.PIPALI_DATA_DIR;
        else process.env.PIPALI_DATA_DIR = realDataDir;
        fs.rmSync(path.join(dataDir, 'sandbox-setup-declined'), { force: true });
        fs.rmdirSync(dataDir);
    });

    test('commands arriving together raise one prompt, and a no is not asked again', async () => {
        let prompts = 0;
        const declined = async () => {
            prompts++;
            await Bun.sleep(10);
            return { cancelled: true };
        };

        await setUpSandboxOnFirstNeed({ platform: 'darwin', setUp: declined });
        expect(prompts).toBe(0);

        await Promise.all([
            setUpSandboxOnFirstNeed({ platform: 'win32', setUp: declined }),
            setUpSandboxOnFirstNeed({ platform: 'win32', setUp: declined }),
        ]);
        expect(prompts).toBe(1);

        await setUpSandboxOnFirstNeed({ platform: 'win32', setUp: declined });
        expect(prompts).toBe(1);
        expect(isSandboxActive()).toBe(false);
    });

    test('commands wait for the prompt to be answered, not for the profile grant after it', async () => {
        let prompts = 0;
        const grant = Promise.withResolvers<void>();
        const granted = Promise.withResolvers<void>();
        const approved = async (onElevated: () => void) => {
            prompts++;
            onElevated();
            await grant.promise;
            SandboxManager.initialize = async () => {};
            await initializeSandboxWithConfig(getDefaultConfig());
            granted.resolve();
            return { cancelled: false };
        };

        // Both go on to ask for confirmation while the grant runs, and neither prompts again
        await setUpSandboxOnFirstNeed({ platform: 'win32', setUp: approved });
        await setUpSandboxOnFirstNeed({ platform: 'win32', setUp: approved });
        expect(prompts).toBe(1);
        expect(isSandboxActive()).toBe(false);

        grant.resolve();
        await granted.promise;
        expect(isSandboxActive()).toBe(true);
    });

    test('a setup that brings the sandbox up is not remembered, so a later breakage is repaired', async () => {
        let prompts = 0;
        const approved = async () => {
            prompts++;
            SandboxManager.initialize = async () => {};
            await initializeSandboxWithConfig(getDefaultConfig());
            return { cancelled: false };
        };

        await setUpSandboxOnFirstNeed({ platform: 'win32', setUp: approved });
        expect(isSandboxActive()).toBe(true);

        // An update that needs the setup redone stops the sandbox again
        await startWithoutSetup();
        await setUpSandboxOnFirstNeed({ platform: 'win32', setUp: approved });
        expect(prompts).toBe(2);
        expect(isSandboxActive()).toBe(true);
    });
});
