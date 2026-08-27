import { expect, test } from 'bun:test';
import { __test__ } from '../../src/client/hooks/useWebSocketChat';

test('queues the complete response before removing the pending confirmation', () => {
    const frames: string[] = [];
    const events: string[] = [];
    const socket = {
        readyState: WebSocket.OPEN,
        send: (frame: string) => {
            frames.push(frame);
            events.push('queued');
        },
    } as unknown as WebSocket;

    const sent = __test__.tryQueueConfirmationResponse(socket, {
        conversationId: 'conv-1',
        runId: 'run-1',
        requestId: 'request-1',
        optionId: 'guidance',
        guidance: 'use the staging bucket',
        attachments: [{ path: '/tmp/report.csv', name: 'report.csv' }],
    }, () => {
        events.push('removed');
    });

    expect(sent).toBe(true);
    expect(events).toEqual(['queued', 'removed']);
    expect(frames).toHaveLength(1);
    const frame = JSON.parse(frames[0]!);
    expect(frame).toMatchObject({
        type: 'confirmation_response',
        conversationId: 'conv-1',
        runId: 'run-1',
        data: {
            requestId: 'request-1',
            selectedOptionId: 'guidance',
            guidance: 'use the staging bucket',
            attachments: [{ path: '/tmp/report.csv', name: 'report.csv' }],
        },
    });
    expect(Number.isNaN(Date.parse(frame.data.timestamp))).toBe(false);
});

test('keeps the confirmation pending when its response cannot be queued', () => {
    const params = {
        conversationId: 'conv-1',
        runId: 'run-1',
        requestId: 'request-1',
        optionId: 'yes',
    };
    const closed = { readyState: WebSocket.CLOSED, send: () => { throw new Error('must not send'); } } as unknown as WebSocket;
    const failing = { readyState: WebSocket.OPEN, send: () => { throw new Error('connection lost'); } } as unknown as WebSocket;
    let removals = 0;
    const removePending = () => { removals++; };

    expect(__test__.tryQueueConfirmationResponse(null, params, removePending)).toBe(false);
    expect(__test__.tryQueueConfirmationResponse(closed, params, removePending)).toBe(false);
    expect(__test__.tryQueueConfirmationResponse(failing, params, removePending)).toBe(false);
    expect(removals).toBe(0);
});
