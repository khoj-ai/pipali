import { test, expect, describe } from 'bun:test';
import { isInternalUrl, getInternalUrlReason } from '../../../src/server/security/url-validator';

describe('isInternalUrl', () => {
    describe('Localhost and loopback', () => {
        test('should detect localhost', () => {
            expect(isInternalUrl('http://localhost')).toBe(true);
            expect(isInternalUrl('http://localhost:3000')).toBe(true);
            expect(isInternalUrl('https://localhost/path')).toBe(true);
            expect(isInternalUrl('http://LOCALHOST:8080')).toBe(true);
        });

        test('should detect localhost.localdomain', () => {
            expect(isInternalUrl('http://localhost.localdomain')).toBe(true);
        });

        test('should detect 127.x.x.x loopback addresses', () => {
            expect(isInternalUrl('http://127.0.0.1')).toBe(true);
            expect(isInternalUrl('http://127.0.0.1:8080')).toBe(true);
            expect(isInternalUrl('http://127.0.1.1')).toBe(true);
            expect(isInternalUrl('http://127.255.255.255')).toBe(true);
        });

        test('should detect 0.0.0.0', () => {
            expect(isInternalUrl('http://0.0.0.0')).toBe(true);
            expect(isInternalUrl('http://0.0.0.0:3000')).toBe(true);
        });

        test('should detect IPv6 loopback', () => {
            // Note: URL parser extracts hostname without brackets for IPv6
            // The validator checks for '::1' directly in INTERNAL_HOSTNAMES
            expect(isInternalUrl('http://[::1]')).toBe(true);
            expect(isInternalUrl('http://[::1]:8080')).toBe(true);
        });

        test('should detect ip6-localhost', () => {
            expect(isInternalUrl('http://ip6-localhost')).toBe(true);
            expect(isInternalUrl('http://ip6-loopback')).toBe(true);
        });
    });

    describe('RFC 1918 private networks', () => {
        test('should detect 10.x.x.x addresses', () => {
            expect(isInternalUrl('http://10.0.0.1')).toBe(true);
            expect(isInternalUrl('http://10.255.255.255')).toBe(true);
            expect(isInternalUrl('http://10.0.0.1:8080/api')).toBe(true);
        });

        test('should detect 172.16-31.x.x addresses', () => {
            expect(isInternalUrl('http://172.16.0.1')).toBe(true);
            expect(isInternalUrl('http://172.20.0.1')).toBe(true);
            expect(isInternalUrl('http://172.31.255.255')).toBe(true);
        });

        test('should not detect 172.15.x.x or 172.32.x.x (outside private range)', () => {
            expect(isInternalUrl('http://172.15.0.1')).toBe(false);
            expect(isInternalUrl('http://172.32.0.1')).toBe(false);
        });

        test('should detect 192.168.x.x addresses', () => {
            expect(isInternalUrl('http://192.168.0.1')).toBe(true);
            expect(isInternalUrl('http://192.168.1.1')).toBe(true);
            expect(isInternalUrl('http://192.168.255.255')).toBe(true);
        });
    });

    describe('Link-local addresses', () => {
        test('should detect 169.254.x.x addresses', () => {
            expect(isInternalUrl('http://169.254.0.1')).toBe(true);
            expect(isInternalUrl('http://169.254.169.254')).toBe(true);
        });

        test('should detect IPv6 link-local', () => {
            expect(isInternalUrl('http://[fe80::1]')).toBe(true);
            expect(isInternalUrl('http://[fe80::1]:8080')).toBe(true);
        });
    });

    describe('Carrier-grade NAT addresses', () => {
        test('should detect 100.64-127.x.x addresses', () => {
            expect(isInternalUrl('http://100.64.0.1')).toBe(true);
            expect(isInternalUrl('http://100.100.0.1')).toBe(true);
            expect(isInternalUrl('http://100.127.255.255')).toBe(true);
        });

        test('should not detect addresses outside CGNAT range', () => {
            expect(isInternalUrl('http://100.63.0.1')).toBe(false);
            expect(isInternalUrl('http://100.128.0.1')).toBe(false);
        });
    });

    describe('Cloud metadata endpoints', () => {
        test('should detect AWS/GCP/Azure metadata endpoint', () => {
            expect(isInternalUrl('http://169.254.169.254')).toBe(true);
            expect(isInternalUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
            expect(isInternalUrl('http://169.254.169.254/metadata/instance')).toBe(true);
        });

        test('should detect Google metadata internal hostname', () => {
            expect(isInternalUrl('http://metadata.google.internal')).toBe(true);
            expect(isInternalUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(true);
        });

        test('should detect metadata.goog hostname', () => {
            expect(isInternalUrl('http://metadata.goog')).toBe(true);
        });
    });

    describe('External URLs (should NOT be internal)', () => {
        test('should not flag public websites', () => {
            expect(isInternalUrl('https://google.com')).toBe(false);
            expect(isInternalUrl('https://api.github.com')).toBe(false);
            expect(isInternalUrl('https://example.com/path')).toBe(false);
        });

        test('should not flag public IP addresses', () => {
            expect(isInternalUrl('http://8.8.8.8')).toBe(false);
            expect(isInternalUrl('http://1.1.1.1')).toBe(false);
            expect(isInternalUrl('http://208.67.222.222')).toBe(false);
        });

        test('should not flag hostnames containing internal keywords', () => {
            expect(isInternalUrl('https://localhost-tunnel.example.com')).toBe(false);
            expect(isInternalUrl('https://my-localhost.dev')).toBe(false);
        });
    });

    describe('Invalid URLs', () => {
        test('should return false for invalid URLs', () => {
            expect(isInternalUrl('not-a-url')).toBe(false);
            expect(isInternalUrl('')).toBe(false);
            expect(isInternalUrl('ftp://')).toBe(false);
        });
    });
});

describe('getInternalUrlReason', () => {
    test('should return reason for localhost', () => {
        expect(getInternalUrlReason('http://localhost')).toBe('localhost/loopback address');
        expect(getInternalUrlReason('http://0.0.0.0')).toBe('localhost/loopback address');
    });

    test('should return reason for cloud metadata', () => {
        expect(getInternalUrlReason('http://169.254.169.254/latest/meta-data/')).toBe('cloud instance metadata endpoint');
        expect(getInternalUrlReason('http://metadata.google.internal')).toBe('cloud instance metadata endpoint');
    });

    test('should return reason for loopback addresses', () => {
        expect(getInternalUrlReason('http://127.0.0.1')).toBe('loopback address (127.x.x.x)');
        expect(getInternalUrlReason('http://127.0.1.1')).toBe('loopback address (127.x.x.x)');
    });

    test('should return reason for 10.x.x.x network', () => {
        expect(getInternalUrlReason('http://10.0.0.1')).toBe('private network (10.x.x.x)');
    });

    test('should return reason for 172.16-31.x.x network', () => {
        expect(getInternalUrlReason('http://172.16.0.1')).toBe('private network (172.16-31.x.x)');
        expect(getInternalUrlReason('http://172.31.0.1')).toBe('private network (172.16-31.x.x)');
    });

    test('should return reason for 192.168.x.x network', () => {
        expect(getInternalUrlReason('http://192.168.1.1')).toBe('private network (192.168.x.x)');
    });

    test('should return reason for link-local addresses', () => {
        expect(getInternalUrlReason('http://169.254.0.1')).toBe('link-local address');
    });

    test('should return reason for CGNAT addresses', () => {
        expect(getInternalUrlReason('http://100.64.0.1')).toBe('carrier-grade NAT address');
        expect(getInternalUrlReason('http://100.100.0.1')).toBe('carrier-grade NAT address');
    });

    test('should return null for external URLs', () => {
        expect(getInternalUrlReason('https://google.com')).toBeNull();
        expect(getInternalUrlReason('http://8.8.8.8')).toBeNull();
    });

    test('should return null for invalid URLs', () => {
        expect(getInternalUrlReason('not-a-url')).toBeNull();
    });
});
