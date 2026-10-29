/**
 * A routine reuses one conversation, which the user can follow up in. A routine that fires
 * while such a follow-up runs waits for it, and the follow-up stays the user's throughout.
 */

import { test, expect, describe, afterEach } from 'bun:test';
import { createRunHandle, getBus, getOrCreateBus } from '../../src/server/events/conversation-event-bus';
import { Automation, AutomationExecution, Conversation, User } from '../../src/server/db/schema';
import { queueExecution } from '../../src/server/automation/executor';
import { deactivateAutomation } from '../../src/server/automation';

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the routine');
        await Bun.sleep(10);
    }
}

describe('routine waiting for its conversation', () => {
    afterEach(() => {
        globalThis.__pipaliUnitDb = undefined;
    });

    test('pausing it leaves the follow-up running and keeps the routine from starting', async () => {
        const automationId = crypto.randomUUID();
        const conversationId = crypto.randomUUID();
        const routine = { id: automationId, userId: 1, status: 'active', name: 'Daily brief', prompt: 'Brief me', conversationId };
        const executionStatuses: unknown[] = [];
        const routineUpdates: unknown[] = [];
        let conversationLookups = 0;
        globalThis.__pipaliUnitDb = {
            select: (table) => {
                if (table === Conversation) conversationLookups++;
                return Promise.resolve(
                    table === Automation ? [routine]
                        : table === User ? [{ id: 1 }]
                        : table === Conversation ? [{ id: conversationId }]
                        : []);
            },
            insert: () => ({ returning: async () => [{ id: crypto.randomUUID() }] }),
            update: (table, values) => {
                if (table === AutomationExecution) executionStatuses.push((values as { status?: string }).status);
                if (table === Automation) routineUpdates.push(values);
                return Promise.resolve([]);
            },
        };

        const bus = getOrCreateBus(conversationId);
        const followUp = createRunHandle('follow-up-run', 'follow-up-message', conversationId);
        bus.activeRun = followUp;

        expect(await queueExecution(automationId, { type: 'cron', timestamp: new Date().toISOString() })).not.toBeNull();
        // Queueing and running each look the conversation up; the second is just before the wait
        await until(() => conversationLookups >= 2);
        await Bun.sleep(10);

        await deactivateAutomation(automationId);
        expect(followUp.abortController.signal.aborted).toBe(false);
        expect(bus.activeRun).toBe(followUp);

        // The follow-up finishes, and the paused routine does not start in its place
        bus.activeRun = null;
        await until(() => executionStatuses.includes('cancelled'));
        expect(getBus(conversationId)?.activeRun ?? null).toBeNull();
        expect(routineUpdates).toEqual([]);
    });
});
