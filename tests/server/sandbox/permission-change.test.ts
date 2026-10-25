/**
 * Pipali can reach its own API, so the sandbox permissions it works under would otherwise
 * be its to rewrite. A change asked for outside the settings UI is put to the user first.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import api from '../../../src/server/routes/api';
import {
    clearAllBuses,
    createRunHandle,
    getOrCreateBus,
    type ConversationEventBus,
    type RunHandle,
} from '../../../src/server/events/conversation-event-bus';
import { createConfirmationCallback, resolveConfirmationOnBus } from '../../../src/server/routes/ws/confirmation-manager';
import { CONFIRMATION_OPTIONS, createEmptyPreferences, type ConfirmationRequest } from '../../../src/server/processor/confirmation';
import { getDefaultConfig, getSandboxConfig, reloadSandboxConfig } from '../../../src/server/sandbox';
import { describeSandboxChanges } from '../../../src/server/sandbox/permission-change';
import { previewSandboxSettings } from '../../../src/server/sandbox/settings';
import { settingsTokenForTesting } from '../../../src/server/routes/settings-token';
import { SETTINGS_TOKEN_HEADER } from '../../../src/shared';

const SETTINGS_URL = 'http://127.0.0.1:6464/api/user/sandbox';
const DESKTOP_APP = { [SETTINGS_TOKEN_HEADER]: settingsTokenForTesting() };
// As long as the real token, so only the comparison itself can turn it away
const WRONG_TOKEN = { [SETTINGS_TOKEN_HEADER]: 'f'.repeat(settingsTokenForTesting().length) };

type Row = Record<string, unknown>;

let storedRow: Row | undefined;
let writes: Row[] = [];

function defined(values: Row): Row {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

async function putSandboxSettings(
    body: Record<string, unknown>,
    init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
    return await api.fetch(new Request(SETTINGS_URL, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            ...init.headers,
        },
        body: JSON.stringify(body),
        signal: init.signal,
    }));
}

/** A run in flight, answering any confirmation it is shown with `answer`. */
function startRun(answer?: typeof CONFIRMATION_OPTIONS[keyof typeof CONFIRMATION_OPTIONS]): {
    bus: ConversationEventBus;
    run: RunHandle;
    asked: ConfirmationRequest[];
    resolved: string[];
} {
    const bus = getOrCreateBus('conversation-under-test');
    const run = createRunHandle('run-1', 'message-1', bus.conversationId);
    run.confirmationContext = {
        requestConfirmation: createConfirmationCallback(bus, bus.conversationId, run),
        preferences: createEmptyPreferences(),
    };
    bus.activeRun = run;

    const asked: ConfirmationRequest[] = [];
    const resolved: string[] = [];
    bus.subscribe(event => {
        if (event.type === 'confirmation_resolved') resolved.push(event.data.requestId);
        if (event.type !== 'confirmation_request') return;
        asked.push(event.data);
        if (!answer) return;
        resolveConfirmationOnBus(bus, run, {
            requestId: event.data.requestId,
            selectedOptionId: answer,
            timestamp: new Date().toISOString(),
        });
    });

    return { bus, run, asked, resolved };
}

describe('sandbox permission changes', () => {
    beforeEach(() => {
        storedRow = undefined;
        writes = [];
        globalThis.__pipaliUnitDb = {
            select: () => ({ limit: async () => (storedRow ? [storedRow] : []) }),
            insert: (_table, values) => {
                storedRow = defined(values as Row);
                writes.push(storedRow);
                return Promise.resolve([]);
            },
            update: (_table, values) => {
                storedRow = { ...storedRow, ...defined(values as Row) };
                writes.push(defined(values as Row));
                return Promise.resolve([]);
            },
        };
    });

    afterEach(async () => {
        // Applying a change reloads the server's live config; put the defaults back.
        storedRow = undefined;
        await reloadSandboxConfig();
        globalThis.__pipaliUnitDb = undefined;
        clearAllBuses();
    });

    test('describes what a change does, in both directions', () => {
        const current = previewSandboxSettings(getDefaultConfig(), { deniedReadPaths: ['~/Finance'] });
        const next = previewSandboxSettings(current, {
            allowedDomains: ['api.example.com'],
            deniedReadPaths: [],
            enabled: false,
        });

        expect(describeSandboxChanges(current, next)).toEqual([
            'Turn the sandbox off, so commands run unconfined',
            'Let commands reach: api.example.com',
            'Read without asking: ~/Finance',
        ]);
    });

    test('a request that drops the built-in protections saves without asking, and they stay', async () => {
        const { asked } = startRun();
        const builtIn = getDefaultConfig();

        const response = await putSandboxSettings({ deniedReadPaths: [], deniedWritePaths: [] });

        expect(response.status).toBe(200);
        expect(asked).toEqual([]);
        expect(writes).toHaveLength(1);
        expect(getSandboxConfig().deniedReadPaths).toEqual(builtIn.deniedReadPaths);
        expect(getSandboxConfig().deniedWritePaths).toEqual(builtIn.deniedWritePaths);
    });

    test('asks the running task, and applies the change once approved', async () => {
        const { asked } = startRun(CONFIRMATION_OPTIONS.YES);

        const response = await putSandboxSettings({ allowedDomains: ['api.example.com'] });

        expect(response.status).toBe(200);
        expect(asked).toHaveLength(1);
        expect(asked[0]?.operation).toBe('change_sandbox_settings');
        expect(asked[0]?.message).toContain('Let commands reach: api.example.com');
        expect(asked[0]?.options.map(option => option.id)).toEqual([CONFIRMATION_OPTIONS.YES, CONFIRMATION_OPTIONS.NO]);
        expect(getSandboxConfig().allowedDomains).toContain('api.example.com');
    });

    test('leaves permissions alone when the user says no', async () => {
        const { asked } = startRun(CONFIRMATION_OPTIONS.NO);

        const response = await putSandboxSettings({ allowedDomains: ['api.example.com'] });

        expect(response.status).toBe(403);
        expect(asked).toHaveLength(1);
        expect(writes).toEqual([]);
        expect(getSandboxConfig().allowedDomains).not.toContain('api.example.com');
    });

    test('refuses a change with no task running to ask from', async () => {
        const response = await putSandboxSettings({ allowedDomains: ['api.example.com'] });

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining('unchanged') });
        expect(writes).toEqual([]);
    });

    test('takes the question down when the caller gives up on it', async () => {
        const { asked, resolved, run } = startRun();
        const caller = new AbortController();

        const pending = putSandboxSettings({ allowedDomains: ['api.example.com'] }, { signal: caller.signal });
        await Bun.sleep(0);
        expect(asked).toHaveLength(1);

        caller.abort();
        const response = await pending;

        expect(response.status).toBe(408);
        expect(writes).toEqual([]);
        // Withdrawn everywhere it was raised, so no dialog outlives the request behind it.
        expect(resolved).toEqual([asked[0]!.requestId]);
        expect(run.pendingConfirmations.size).toBe(0);
    });

    test("the desktop app's settings page changes permissions without a second ask", async () => {
        const { asked } = startRun();

        const response = await putSandboxSettings({ allowedDomains: ['api.example.com'] }, { headers: DESKTOP_APP });

        expect(response.status).toBe(200);
        expect(asked).toEqual([]);
        expect(getSandboxConfig().allowedDomains).toContain('api.example.com');
    });

    test('a wrong settings token is put to the user', async () => {
        const { asked } = startRun(CONFIRMATION_OPTIONS.NO);

        const response = await putSandboxSettings({ allowedDomains: ['api.example.com'] }, { headers: WRONG_TOKEN });

        expect(response.status).toBe(403);
        expect(asked).toHaveLength(1);
        expect(writes).toEqual([]);
        expect(getSandboxConfig().allowedDomains).not.toContain('api.example.com');
    });
});
