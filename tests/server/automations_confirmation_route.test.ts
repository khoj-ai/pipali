/**
 * Wiring-level test for the REST confirmation respond endpoint.
 *
 * Ensures the route's pre-handler returns 400 when YES (or YES_DONT_ASK) is
 * combined with attachments, before any downstream `respondToConfirmation`
 * call (which would touch the DB) is reached. A future refactor that moves
 * the guard past respondToConfirmation will fail this test instead of
 * silently dropping attachments.
 */

import { describe, test, expect } from 'bun:test';
import automations from '../../src/server/routes/automations';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

async function postRespond(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await automations.request(`/confirmations/${VALID_UUID}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
}

describe('POST /api/automations/confirmations/:id/respond', () => {
    test('rejects YES + attachments with 400', async () => {
        const { status, json } = await postRespond({
            selectedOptionId: 'yes',
            attachments: [{ path: '/tmp/x.txt' }],
        });
        expect(status).toBe(400);
        expect(json.error).toMatch(/attach/i);
    });

    test('rejects YES_DONT_ASK + attachments with 400', async () => {
        const { status, json } = await postRespond({
            selectedOptionId: 'yes_dont_ask',
            attachments: [{ path: '/tmp/x.txt' }],
        });
        expect(status).toBe(400);
        expect(json.error).toMatch(/attach/i);
    });

    test('rejects an invalid UUID with 400 before the semantic check', async () => {
        const res = await automations.request('/confirmations/not-a-uuid/respond', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ selectedOptionId: 'yes' }),
        });
        expect(res.status).toBe(400);
    });
});
