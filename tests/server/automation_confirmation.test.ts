/**
 * A routine's confirmations travel the conversation's event bus like any other run's, and
 * are recorded so the routines page can answer one raised while nobody is watching.
 * These cover both doors onto the same waiting run.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createRunHandle, getOrCreateBus, type ConversationEvent } from '../../src/server/events/conversation-event-bus';
import { PendingConfirmation } from '../../src/server/db/schema';
import { createConfirmationCallback, rejectAllConfirmations, resolveConfirmationOnBus } from '../../src/server/routes/ws/confirmation-manager';
import { createAutomationConfirmationPersistence, respondToConfirmation } from '../../src/server/automation/executor';
import {
    CONFIRMATION_OPTIONS,
    createStandardConfirmationOptions,
    type ConfirmationRequest,
    type ConfirmationResponse,
} from '../../src/server/processor/confirmation';

const EXECUTION_ID = 'execution-1';
const ROW_ID = 'pending-confirmation-1';

interface RecordedWrite {
    table: unknown;
    values: Record<string, unknown>;
}

let writes: RecordedWrite[] = [];
let inserted: Record<string, unknown>[] = [];
/** What a lookup by confirmation row id finds. */
let storedRow: Record<string, unknown> | undefined;

function editRequest(): ConfirmationRequest {
    return {
        requestId: crypto.randomUUID(),
        inputType: 'choice',
        title: 'Confirm File Edit',
        operation: 'edit_file',
        context: { toolName: 'edit_file', toolArgs: { file_path: '/tmp/notes.md' } },
        options: createStandardConfirmationOptions(),
    };
}

function answer(requestId: string, selectedOptionId: string): ConfirmationResponse {
    return { requestId, selectedOptionId, timestamp: new Date().toISOString() };
}

/** Set up a routine run that a client is watching, and raise a confirmation on it. */
async function raiseConfirmation() {
    const conversationId = crypto.randomUUID();
    const bus = getOrCreateBus(conversationId);
    const runHandle = createRunHandle('run-1', 'client-message-1', conversationId);
    bus.activeRun = runHandle;

    const events: ConversationEvent[] = [];
    const unsubscribe = bus.subscribe(event => events.push(event));

    const request = editRequest();
    const persistence = createAutomationConfirmationPersistence(EXECUTION_ID);
    const requestConfirmation = createConfirmationCallback(bus, conversationId, runHandle, persistence);

    const answered = requestConfirmation(request);
    // The request is recorded before it is published, so let both land.
    await new Promise(resolve => setTimeout(resolve, 0));

    storedRow = { status: 'pending', request, executionId: EXECUTION_ID, conversationId };

    return { conversationId, bus, runHandle, events, request, answered, unsubscribe };
}

function statusesWritten(): unknown[] {
    return writes.map(write => write.values.status);
}

describe('routine confirmations', () => {
    beforeEach(() => {
        writes = [];
        inserted = [];
        storedRow = undefined;
        globalThis.__pipaliUnitDb = {
            select: () => Promise.resolve(storedRow ? [storedRow] : []),
            insert: (_table, values) => {
                inserted.push(values as Record<string, unknown>);
                return { returning: async () => [{ id: ROW_ID }] };
            },
            update: (table, values) => {
                const written = values as Record<string, unknown>;
                writes.push({ table, values: written });
                // Drizzle's builder is awaitable and chainable. Settling the confirmation is
                // conditional on the row still being pending, and reads that off .returning().
                return Object.assign(Promise.resolve<unknown[]>([]), {
                    returning: async (): Promise<unknown[]> => {
                        if (table !== PendingConfirmation || storedRow?.status !== 'pending') return [];
                        storedRow.status = written.status;
                        return [{ id: ROW_ID }];
                    },
                });
            },
        };
    });

    afterEach(() => {
        globalThis.__pipaliUnitDb = undefined;
    });

    test('reaches the conversation the moment it is raised, and is recorded alongside', async () => {
        const { events, request, unsubscribe } = await raiseConfirmation();

        expect(events.map(event => event.type)).toEqual(['confirmation_request']);
        expect((events[0] as { data: ConfirmationRequest }).data.requestId).toBe(request.requestId);

        expect(inserted).toHaveLength(1);
        expect(inserted[0]).toMatchObject({ executionId: EXECUTION_ID, status: 'pending' });
        expect(statusesWritten()).toEqual(['awaiting_confirmation']);

        unsubscribe();
    });

    test('answering the dialog settles the recorded copy and resumes the execution', async () => {
        const { bus, runHandle, events, request, answered, unsubscribe } = await raiseConfirmation();

        resolveConfirmationOnBus(bus, runHandle, answer(request.requestId, CONFIRMATION_OPTIONS.YES));

        expect((await answered).selectedOptionId).toBe(CONFIRMATION_OPTIONS.YES);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(events.map(event => event.type)).toEqual(['confirmation_request', 'confirmation_resolved']);
        expect(statusesWritten()).toEqual(['awaiting_confirmation', 'approved', 'running']);

        unsubscribe();
    });

    test('answering from the routines page reaches the run waiting on it', async () => {
        const { events, request, answered, unsubscribe } = await raiseConfirmation();

        // The routines page addresses the row; the run knows only its own request id.
        const accepted = await respondToConfirmation(ROW_ID, answer(ROW_ID, CONFIRMATION_OPTIONS.YES));

        expect(accepted).toBe(true);
        const response = await answered;
        expect(response.requestId).toBe(request.requestId);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(events.map(event => event.type)).toEqual(['confirmation_request', 'confirmation_resolved']);
        expect(statusesWritten()).toEqual(['awaiting_confirmation', 'approved', 'running']);

        unsubscribe();
    });

    test('a denial from the routines page cancels the execution', async () => {
        const { answered, unsubscribe } = await raiseConfirmation();

        await respondToConfirmation(ROW_ID, answer(ROW_ID, CONFIRMATION_OPTIONS.NO));

        expect((await answered).selectedOptionId).toBe(CONFIRMATION_OPTIONS.NO);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(statusesWritten()).toEqual(['awaiting_confirmation', 'denied', 'cancelled']);

        unsubscribe();
    });

    test('an answer that arrives second finds nothing left to settle', async () => {
        const { request, unsubscribe } = await raiseConfirmation();

        storedRow = { ...storedRow, status: 'approved', request };
        expect(await respondToConfirmation(ROW_ID, answer(ROW_ID, CONFIRMATION_OPTIONS.NO))).toBe(false);
        expect(statusesWritten()).toEqual(['awaiting_confirmation']);

        unsubscribe();
    });

    test('a run stopped while the request is being recorded leaves no dialog behind', async () => {
        const conversationId = crypto.randomUUID();
        const bus = getOrCreateBus(conversationId);
        const runHandle = createRunHandle('run-1', 'client-message-1', conversationId);
        bus.activeRun = runHandle;

        const events: ConversationEvent[] = [];
        const unsubscribe = bus.subscribe(event => events.push(event));

        const request = editRequest();
        const persistence = createAutomationConfirmationPersistence(EXECUTION_ID);
        const recorded = persistence.onRequest.bind(persistence);
        persistence.onRequest = async (pending) => {
            await recorded(pending);
            storedRow = { status: 'pending', request: pending, executionId: EXECUTION_ID, conversationId };
            // The run is stopped while its confirmation is being written down.
            rejectAllConfirmations(runHandle, 'Research stopped');
            runHandle.abortController.abort();
        };

        const requestConfirmation = createConfirmationCallback(bus, conversationId, runHandle, persistence);

        await expect(requestConfirmation(request)).rejects.toThrow('Research stopped');
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(events).toEqual([]);
        expect(runHandle.pendingConfirmations.size).toBe(0);
        expect(statusesWritten()).toEqual(['awaiting_confirmation', 'expired']);

        unsubscribe();
    });

    test('a stopped run retires the confirmation it was blocked on', async () => {
        const { runHandle, answered, unsubscribe } = await raiseConfirmation();

        rejectAllConfirmations(runHandle, 'Research stopped');

        await expect(answered).rejects.toThrow('Research stopped');
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(statusesWritten()).toEqual(['awaiting_confirmation', 'expired']);

        unsubscribe();
    });
});
