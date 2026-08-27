/**
 * Origin policy for the HTTP API.
 *
 * These drive the real middleware through api.fetch, so they cover both the policy and its
 * wiring into the app. An unrouted path keeps the subject to the guard alone: a refused request
 * never reaches the router, an accepted one falls through to a 404.
 *
 * The same policy over the WebSocket upgrade is covered in tests/server/ws/upgrade-origin.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import api from '../../../src/server/routes/api';

const REFUSED = 403;
const REACHED_ROUTER = 404;

const proxyHost = 'machine.tailnet-name.ts.net';
const previousTrustedHosts = process.env.PIPALI_TRUSTED_HOSTS;

beforeAll(() => { process.env.PIPALI_TRUSTED_HOSTS = proxyHost; });
afterAll(() => {
    if (previousTrustedHosts === undefined) delete process.env.PIPALI_TRUSTED_HOSTS;
    else process.env.PIPALI_TRUSTED_HOSTS = previousTrustedHosts;
});

async function post(origin?: string, host?: string): Promise<number> {
    const headers: Record<string, string> = {};
    if (origin) headers.Origin = origin;
    if (host) headers.Host = host;
    const request = new Request('http://127.0.0.1:6464/api/origin-guard-probe', { method: 'POST', headers });
    return (await api.fetch(request)).status;
}

describe('API origin guard', () => {
    test('accepts a request with no Origin from non-browser clients', async () => {
        expect(await post()).toBe(REACHED_ROUTER);
    });

    // macOS/Linux WebView uses tauri://localhost, Windows WebView2 uses http://tauri.localhost
    for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:6464', 'http://127.0.0.1:6464']) {
        test(`accepts the trusted browser origin ${origin}`, async () => {
            expect(await post(origin)).toBe(REACHED_ROUTER);
        });
    }

    test('refuses an unrelated origin', async () => {
        expect(await post('https://untrusted.example')).toBe(REFUSED);
    });

    // Only the host matters, not a trusted looking prefix of the name
    test('refuses an origin that merely starts with a loopback name', async () => {
        expect(await post('http://evil.localhost.attacker.example')).toBe(REFUSED);
    });

    // Userinfo hides the real host behind a trusted looking prefix
    for (const origin of ['http://localhost:pass@evil.example', 'http://127.0.0.1:x@evil.example']) {
        test(`refuses the userinfo smuggled origin ${origin}`, async () => {
            expect(await post(origin, '127.0.0.1:6464')).toBe(REFUSED);
        });
    }

    test('refuses a malformed origin', async () => {
        expect(await post('not-a-url', '127.0.0.1:6464')).toBe(REFUSED);
    });

    test('refuses an origin when the Host header is missing', async () => {
        expect(await post(`https://${proxyHost}`)).toBe(REFUSED);
    });

    describe('behind a TLS-terminating reverse proxy', () => {
        // The proxy forwards the external Host but reaches us over plain http, so schemes never match
        const accepted: Array<[string, string]> = [
            [`https://${proxyHost}`, proxyHost],
            [`https://${proxyHost}`, `${proxyHost}:443`],
            [`https://${proxyHost}:8443`, `${proxyHost}:8443`],
        ];
        for (const [origin, host] of accepted) {
            test(`accepts ${origin} served on ${host}`, async () => {
                expect(await post(origin, host)).toBe(REACHED_ROUTER);
            });
        }

        test('refuses an origin that omits an explicit non-default port', async () => {
            expect(await post(`https://${proxyHost}`, `${proxyHost}:8443`)).toBe(REFUSED);
        });

        test('refuses an unrelated origin even on a configured host', async () => {
            expect(await post('https://attacker.example', proxyHost)).toBe(REFUSED);
        });
    });

    // A rebinding points a name at 127.0.0.1, so Origin and Host both match. Same-origin applies
    // only to hosts we already expect to be reached on.
    test('refuses a host that is not configured, even when Origin matches it', async () => {
        expect(await post('http://rebind.attacker.example:6464', 'rebind.attacker.example:6464')).toBe(REFUSED);
    });

    // Reads stay open because CORS withholds the response. The WebSocket upgrade is a GET that
    // opens a writable channel, so its guard deliberately has no such exemption.
    test('leaves safe methods to CORS', async () => {
        const request = new Request('http://127.0.0.1:6464/api/origin-guard-probe', {
            headers: { Origin: 'https://untrusted.example' },
        });

        expect((await api.fetch(request)).status).toBe(REACHED_ROUTER);
    });
});
