import { test, expect, describe, afterEach, spyOn } from 'bun:test';
import dns from 'node:dns/promises';
import os from 'node:os';
import { getInternalAddressReason, resolveHost } from '../../../src/server/security/url-validator';

describe('getInternalAddressReason', () => {
    test.each([
        ['127.0.0.1', 'localhost/loopback address'],
        ['127.255.255.255', 'localhost/loopback address'],
        ['0.0.0.0', 'localhost/loopback address'],
        ['::1', 'localhost/loopback address'],
        ['::', 'localhost/loopback address'],
        ['10.0.0.1', 'private network address'],
        ['172.16.0.1', 'private network address'],
        ['172.31.255.255', 'private network address'],
        ['192.168.1.1', 'private network address'],
        ['fd12:3456::1', 'private network address'],
        ['169.254.0.1', 'link-local address'],
        ['fe80::1', 'link-local address'],
        ['100.64.0.1', 'carrier-grade NAT address'],
        ['100.127.255.255', 'carrier-grade NAT address'],
        ['169.254.169.254', 'cloud instance metadata endpoint'],
        ['fd00:ec2::254', 'cloud instance metadata endpoint'],
        // IPv4 addresses written as IPv6
        ['::ffff:127.0.0.1', 'localhost/loopback address'],
        ['::ffff:7f00:1', 'localhost/loopback address'],
        ['::ffff:c0a8:101', 'private network address'],
        ['::ffff:a9fe:a9fe', 'cloud instance metadata endpoint'],
    ])('%s is a %s', (address, reason) => {
        expect(getInternalAddressReason(address)).toBe(reason);
    });

    test.each([
        '8.8.8.8',
        '1.1.1.1',
        '172.15.0.1',
        '172.32.0.1',
        '100.63.0.1',
        '100.128.0.1',
        '169.253.0.1',
        '2606:4700::1111',
        '::ffff:8.8.8.8',
    ])('%s is public', (address) => {
        expect(getInternalAddressReason(address)).toBeNull();
    });

    test('a public address of this computer is internal', () => {
        const interfaces = { en0: [{ address: '203.0.113.9' }, { address: '2001:db8::9' }] };
        const interfacesSpy = spyOn(os, 'networkInterfaces').mockReturnValue(interfaces as never);

        try {
            for (const address of ['203.0.113.9', '::ffff:203.0.113.9', '2001:db8::9']) {
                expect(getInternalAddressReason(address)).toBe('network address of this computer');
            }
            expect(getInternalAddressReason('203.0.113.10')).toBeNull();
            expect(getInternalAddressReason('2001:db8::10')).toBeNull();
        } finally {
            interfacesSpy.mockRestore();
        }
    });
});

describe('resolveHost', () => {
    let lookupSpy: ReturnType<typeof spyOn> | undefined;

    function resolveTo(...addresses: string[]) {
        const found = addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
        lookupSpy = spyOn(dns, 'lookup').mockResolvedValue(found as never);
    }

    afterEach(() => {
        lookupSpy?.mockRestore();
        lookupSpy = undefined;
    });

    test.each([
        'http://localhost:3000',
        'http://LOCALHOST',
        'http://localhost.',
        'http://app.localhost',
        'http://[::1]:8080',
        'http://[::ffff:127.0.0.1]',
        'http://[::]',
        'http://[fd00::1]',
        // Other ways to write 127.0.0.1
        'http://2130706433',
        'http://0x7f.1',
        'http://127.1',
    ])('%s is internal however its host is written', async (url) => {
        expect((await resolveHost(new URL(url))).internalReason).not.toBeNull();
    });

    test.each(['http://8.8.8.8', 'http://[2606:4700::1111]'])('%s is public', async (url) => {
        expect((await resolveHost(new URL(url))).internalReason).toBeNull();
    });

    test('a name is internal when any address it resolves to is', async () => {
        resolveTo('2606:4700::1111', '203.0.113.7', '127.0.0.1');

        const host = await resolveHost(new URL('https://rebind.example'));

        expect(host.internalReason).toBe('localhost/loopback address');
        expect(host.addresses).toEqual(['203.0.113.7', '127.0.0.1', '2606:4700::1111']);
    });

    test('a public name that only mentions localhost is public', async () => {
        resolveTo('203.0.113.7');

        expect((await resolveHost(new URL('https://localhost-tunnel.example.com'))).internalReason).toBeNull();
        expect((await resolveHost(new URL('https://my-localhost.dev'))).internalReason).toBeNull();
    });

    test('a name that does not resolve has no addresses to fetch from', async () => {
        lookupSpy = spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND') as never);

        expect(await resolveHost(new URL('https://unknown.example'))).toEqual({ addresses: [], internalReason: null });
    });
});
