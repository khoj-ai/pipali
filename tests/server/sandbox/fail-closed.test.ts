/**
 * The sandbox is a security boundary: when its runtime cannot start or cannot wrap a
 * command, the command must go to the user for confirmation, never run unsandboxed.
 *
 * The runtime's own failures are produced by making its initialize or wrap throw,
 * the way a missing dependency or an unprovisioned Windows sandbox account does.
 */

import { test, expect, describe, afterEach } from 'bun:test';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { getDefaultConfig } from '../../../src/server/sandbox/config';
import {
    initializeSandboxWithConfig,
    isSandboxActive,
    isSandboxSupported,
    wrapCommandWithSandbox,
} from '../../../src/server/sandbox';
import { shellCommand } from '../../../src/server/processor/actor/shell_command';
import type { ConfirmationContext } from '../../../src/server/processor/confirmation';

const realInitialize = SandboxManager.initialize;
const realWrap = SandboxManager.wrapWithSandbox;
const realWrapArgv = SandboxManager.wrapWithSandboxArgv;

/** A user who declines every confirmation, counting how often they were asked. */
function decliningUser() {
    const user = { asked: 0, context: undefined as unknown as ConfirmationContext };
    user.context = {
        preferences: { skipConfirmationFor: new Set() },
        requestConfirmation: async (request) => {
            user.asked++;
            return { requestId: request.requestId, selectedOptionId: 'no', timestamp: new Date().toISOString() };
        },
    };
    return user;
}

function runInSandbox(confirmationContext: ConfirmationContext) {
    return shellCommand(
        { justification: 'test', command: 'echo hi', operation_type: 'read-only', execution_mode: 'sandbox' },
        { confirmationContext },
    );
}

describe('Sandbox fails closed', () => {
    afterEach(async () => {
        SandboxManager.initialize = realInitialize;
        SandboxManager.wrapWithSandbox = realWrap;
        SandboxManager.wrapWithSandboxArgv = realWrapArgv;
        await initializeSandboxWithConfig({ ...getDefaultConfig(), enabled: false });
    });

    test('a runtime that fails to start leaves commands asking for confirmation', async () => {
        SandboxManager.initialize = async () => {
            throw new Error('Windows sandbox user is not provisioned');
        };
        await initializeSandboxWithConfig(getDefaultConfig());

        expect(isSandboxActive()).toBe(false);
        await expect(wrapCommandWithSandbox('echo hi')).rejects.toThrow();

        const user = decliningUser();
        const result = await runInSandbox(user.context);
        expect(user.asked).toBe(1);
        expect(result.compiled).toContain('cancelled');
    });

    test.skipIf(!isSandboxSupported())('a command the running sandbox cannot wrap asks for confirmation', async () => {
        SandboxManager.initialize = async () => {};
        // Windows wraps to an argv, macOS and Linux to a shell string
        SandboxManager.wrapWithSandbox = async () => {
            throw new Error('wrap failed');
        };
        SandboxManager.wrapWithSandboxArgv = async () => {
            throw new Error('wrap failed');
        };
        await initializeSandboxWithConfig(getDefaultConfig());
        expect(isSandboxActive()).toBe(true);

        const user = decliningUser();
        const result = await runInSandbox(user.context);
        expect(user.asked).toBe(1);
        expect(result.compiled).toContain('cancelled');
    });
});
