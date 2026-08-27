/**
 * Login CSRF prevention tests.
 *
 * The OAuth callback page posts whatever tokens it finds in the URL fragment, so a page that
 * frames it could otherwise sign the user into a chosen platform account.
 * Completion is bound to a state this server minted.
 */

import { describe, expect, test } from 'bun:test';
import api from '../../../src/server/routes/api';
import { createPendingAuthState, consumePendingAuthState } from '../../../src/server/auth/pending-state';

function completeRequest(body: Record<string, unknown>): Request {
    return new Request('http://127.0.0.1:6464/api/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:6464' },
        body: JSON.stringify(body),
    });
}

const attackerTokens = { accessToken: 'attacker-access', refreshToken: 'attacker-refresh' };

describe('POST /api/auth/complete', () => {
    for (const [label, body] of [
        ['no state', attackerTokens],
        ['an unknown state', { ...attackerTokens, state: crypto.randomUUID() }],
        ['a non-string state', { ...attackerTokens, state: 42 }],
        ['an empty state', { ...attackerTokens, state: '' }],
    ] as Array<[string, Record<string, unknown>]>) {
        test(`rejects tokens with ${label}`, async () => {
            const response = await api.fetch(completeRequest(body));

            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: 'Invalid or expired sign-in request' });
        });
    }

});

describe('GET /api/auth/callback', () => {
    test('serves the callback page with framing refused', async () => {
        const response = await api.fetch(new Request('http://127.0.0.1:6464/api/auth/callback'));

        expect(response.status).toBe(200);
        expect(response.headers.get('X-Frame-Options')).toBe('DENY');
        expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    });
});

describe('POST /api/auth/state', () => {
    test('mints a state that the callback page can carry back', async () => {
        const response = await api.fetch(new Request('http://127.0.0.1:6464/api/auth/state', {
            method: 'POST',
            headers: { Origin: 'http://127.0.0.1:6464' },
        }));

        expect(response.status).toBe(200);
        const { state } = await response.json() as { state: string };
        expect(state).toBeTruthy();
        expect(consumePendingAuthState(state)).toBe(true);
    });

    test('does not mint a state for a cross-origin page', async () => {
        const response = await api.fetch(new Request('http://127.0.0.1:6464/api/auth/state', {
            method: 'POST',
            headers: { Origin: 'https://attacker.example' },
        }));

        expect(response.status).toBe(403);
    });
});

describe('pending auth state', () => {
    test('accepts a minted state exactly once', () => {
        const state = createPendingAuthState();

        expect(consumePendingAuthState(state)).toBe(true);
        expect(consumePendingAuthState(state)).toBe(false);
    });

    test('keeps concurrent sign-in attempts independent', () => {
        const first = createPendingAuthState();
        const second = createPendingAuthState();

        expect(consumePendingAuthState(second)).toBe(true);
        expect(consumePendingAuthState(first)).toBe(true);
    });

    // Abandoned attempts are shed oldest first, so a full store still completes recent sign-ins
    test('sheds the oldest attempts once they pile up', () => {
        const states = Array.from({ length: 64 }, () => createPendingAuthState());

        expect(consumePendingAuthState(states[0])).toBe(false);
        expect(consumePendingAuthState(states.at(-1))).toBe(true);
        expect(consumePendingAuthState(states.at(-2))).toBe(true);
    });
});
