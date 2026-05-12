/**
 * Tests for ctx.sendError in the WebSocket command context.
 *
 * sendError must surface failures to the client as a real WS frame so the
 * client can clear optimistic state. Previously it only wrote to the server
 * log, so a run that failed validation before `run_started` left the client
 * hanging with an optimistic user-message bubble forever.
 *
 * The chosen wire format reuses the existing `run_stopped` ServerMessage with
 * `reason: 'error'`, which the client already handles for rollback.
 */

import { describe, test, expect } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { createCommandContext } from '../../../src/server/routes/ws';
import type { WebSocketData } from '../../../src/server/routes/ws';
import type { Session } from '../../../src/server/routes/ws/session-state';

interface SentFrame {
    raw: string;
    parsed: Record<string, unknown>;
}

function makeFakeWs(): { ws: ServerWebSocket<WebSocketData>; sent: SentFrame[] } {
    const sent: SentFrame[] = [];
    const ws = {
        send(payload: string | Buffer) {
            const raw = typeof payload === 'string' ? payload : payload.toString('utf8');
            sent.push({ raw, parsed: JSON.parse(raw) });
        },
    } as unknown as ServerWebSocket<WebSocketData>;
    return { ws, sent };
}

function makeCtx(ws: ServerWebSocket<WebSocketData>) {
    return createCommandContext({
        ws,
        sessions: new Map<string, Session>(),
        subscriptions: new Map<string, () => void>(),
        getUser: async () => null,
    });
}

describe('ctx.sendError', () => {
    test('emits run_stopped { reason: "error" } when conversationId and runId are provided', () => {
        const { ws, sent } = makeFakeWs();
        const ctx = makeCtx(ws);

        ctx.sendError('Selected chat model not found', 'conv-1', 'run-1');

        expect(sent).toHaveLength(1);
        expect(sent[0]!.parsed).toEqual({
            type: 'run_stopped',
            conversationId: 'conv-1',
            runId: 'run-1',
            reason: 'error',
            error: 'Selected chat model not found',
        });
    });

    test('does not emit a frame when runId is missing (no run to stop yet)', () => {
        const { ws, sent } = makeFakeWs();
        const ctx = makeCtx(ws);

        ctx.sendError('Selected chat model not found', 'conv-1');

        expect(sent).toHaveLength(0);
    });

    test('does not emit a frame when both conversationId and runId are missing', () => {
        const { ws, sent } = makeFakeWs();
        const ctx = makeCtx(ws);

        ctx.sendError('User not found');

        expect(sent).toHaveLength(0);
    });

    test('does not emit a frame when only runId is provided without conversationId', () => {
        const { ws, sent } = makeFakeWs();
        const ctx = makeCtx(ws);

        ctx.sendError('User not found', undefined, 'run-1');

        expect(sent).toHaveLength(0);
    });
});
