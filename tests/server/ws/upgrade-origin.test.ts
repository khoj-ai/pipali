/**
 * Cross-site WebSocket origin tests.
 *
 * The /ws/chat channel drives the agent as the local user and CORS does not cover upgrades, so the
 * handshake is the only place a drive-by page can be turned away. These drive real handshakes
 * against the shipped guard rather than calling the predicate directly.
 *
 * The origin policy itself is covered once in tests/server/security/origin-guard.test.ts. What
 * matters here is that this channel applies it, and that a handshake never earns the safe-method
 * exemption the API grants a plain GET.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { handleChatUpgrade, type WebSocketData } from '../../../src/server/routes/ws';

let server: Server<WebSocketData>;
let port: number;
const proxyHost = 'machine.tailnet-name.ts.net';
const previousTrustedHosts = process.env.PIPALI_TRUSTED_HOSTS;

beforeAll(() => {
    process.env.PIPALI_TRUSTED_HOSTS = proxyHost;
    server = Bun.serve<WebSocketData, any>({
        port: 0,
        fetch(req, srv) {
            if (new URL(req.url).pathname === '/ws/chat') return handleChatUpgrade(req, srv);
            return new Response('not found', { status: 404 });
        },
        websocket: {
            message() {},
            open(ws) { ws.send('connected'); },
        },
    });
    port = server.port!;
});

afterAll(() => {
    server?.stop(true);
    if (previousTrustedHosts === undefined) delete process.env.PIPALI_TRUSTED_HOSTS;
    else process.env.PIPALI_TRUSTED_HOSTS = previousTrustedHosts;
});

/** Resolves 'open' when the handshake is accepted, or the failure status when it is refused. */
async function handshake(headers?: Record<string, string>): Promise<'open' | number> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`, { headers } as any);
    const outcome = await new Promise<'open' | number>(resolve => {
        ws.onopen = () => resolve('open');
        // Bun surfaces the refused handshake's status on the close/error event
        ws.onclose = (event: CloseEvent) => resolve(event.code);
        ws.onerror = () => resolve(-1);
    });
    ws.close();
    return outcome;
}

describe('/ws/chat upgrade origin guard', () => {
    test('rejects a cross-origin handshake from a drive-by page', async () => {
        expect(await handshake({ Origin: 'https://attacker.example' })).not.toBe('open');
    });

    test('allows a handshake with no Origin (non-browser local clients)', async () => {
        expect(await handshake()).toBe('open');
    });

    // The desktop webview loads over a custom scheme and connects out to the loopback sidecar
    for (const origin of ['tauri://localhost', 'http://tauri.localhost']) {
        test(`allows the Tauri desktop app from ${origin}`, async () => {
            expect(await handshake({ Origin: origin })).toBe('open');
        });
    }

    test('allows localhost dev origins', async () => {
        expect(await handshake({ Origin: `http://localhost:${port}` })).toBe('open');
    });

    test('allows a same-origin handshake', async () => {
        expect(await handshake({ Origin: `http://127.0.0.1:${port}` })).toBe('open');
    });

    // A TLS-terminating proxy forwards the external Host over plain http, so schemes never match
    test('allows a same-origin handshake behind a TLS-terminating proxy', async () => {
        expect(await handshake({ Origin: `https://${proxyHost}`, Host: proxyHost })).toBe('open');
    });

    // A rebinding points a name at 127.0.0.1, so Origin and Host both match.
    // Only hosts we already expect to be reached on may match same-origin.
    test('rejects a rebound hostname whose Origin matches its Host', async () => {
        expect(await handshake({
            Origin: 'http://rebind.attacker.example:6464',
            Host: 'rebind.attacker.example:6464',
        })).not.toBe('open');
    });
});
