/**
 * Wiring-level tests for ConfirmationResponseHandler.
 *
 * The pure validator is covered by tests/server/confirmation_semantics.test.ts.
 * These tests assert the handler actually calls the validator before any
 * downstream dispatch, so a future refactor that moves the check past
 * `handleConfirmationResponse` won't pass silently.
 */

import { describe, test, expect } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { ConfirmationResponseHandler } from '../../../src/server/routes/ws/commands';
import type { CommandContext } from '../../../src/server/routes/ws/commands';
import type { ConfirmationResponseCommand } from '../../../src/server/routes/ws/message-types';
import type { Session } from '../../../src/server/routes/ws/session-state';

interface CtxRecord {
    sendCalls: Array<{ message: Record<string, unknown>; conversationId: string }>;
    sendErrorCalls: Array<{ error: string; conversationId?: string }>;
}

function buildCtx(): { ctx: CommandContext; record: CtxRecord } {
    const record: CtxRecord = { sendCalls: [], sendErrorCalls: [] };
    const ctx: CommandContext = {
        ws: {} as ServerWebSocket<unknown> as CommandContext['ws'],
        getSessions: () => new Map<string, Session>(),
        getUser: async () => null,
        send: (message, conversationId) => {
            record.sendCalls.push({ message, conversationId });
        },
        sendError: (error, conversationId) => {
            record.sendErrorCalls.push({ error, conversationId });
        },
        addSubscription: () => {},
    };
    return { ctx, record };
}

function buildMessage(overrides: Partial<ConfirmationResponseCommand['data']> = {}): ConfirmationResponseCommand {
    return {
        type: 'confirmation_response',
        conversationId: 'conv-1',
        runId: 'run-1',
        data: {
            requestId: 'req-1',
            selectedOptionId: 'yes',
            attachments: [{ path: '/tmp/x.txt' }],
            timestamp: '2026-05-12T00:00:00.000Z',
            ...overrides,
        },
    };
}

describe('ConfirmationResponseHandler', () => {
    test('rejects YES + attachments via ctx.sendError and does not dispatch', async () => {
        const { ctx, record } = buildCtx();

        await ConfirmationResponseHandler.execute(ctx, buildMessage());

        expect(record.sendErrorCalls).toHaveLength(1);
        expect(record.sendErrorCalls[0]!.conversationId).toBe('conv-1');
        expect(record.sendErrorCalls[0]!.error).toMatch(/attach/i);
        expect(record.sendCalls).toHaveLength(0);
    });

    test('rejects YES_DONT_ASK + attachments', async () => {
        const { ctx, record } = buildCtx();

        await ConfirmationResponseHandler.execute(
            ctx,
            buildMessage({ selectedOptionId: 'yes_dont_ask' }),
        );

        expect(record.sendErrorCalls).toHaveLength(1);
    });

    test('does not reject GUIDANCE + attachments at the validation step', async () => {
        // Without an active bus this still bails (`Confirmation for unknown or
        // inactive run`), but the failure mode is different from semantic
        // rejection — sendError is NOT called.
        const { ctx, record } = buildCtx();

        await ConfirmationResponseHandler.execute(
            ctx,
            buildMessage({ selectedOptionId: 'guidance' }),
        );

        expect(record.sendErrorCalls).toHaveLength(0);
    });

    test('does not reject YES with no attachments', async () => {
        const { ctx, record } = buildCtx();

        await ConfirmationResponseHandler.execute(
            ctx,
            buildMessage({ attachments: undefined }),
        );

        expect(record.sendErrorCalls).toHaveLength(0);
    });
});

