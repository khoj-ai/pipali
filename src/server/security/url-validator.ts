/**
 * URL validation utilities for detecting internal/private network URLs.
 * Used to request user confirmation before accessing internal network resources.
 */

/**
 * Regex patterns for private/internal IP ranges (RFC 1918 and others).
 */
const INTERNAL_IP_PATTERNS: RegExp[] = [
    // Loopback addresses (127.0.0.0/8)
    /^127\./,

    // Private networks (RFC 1918)
    /^10\./,                                    // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,          // 172.16.0.0/12
    /^192\.168\./,                              // 192.168.0.0/16

    // Link-local addresses (169.254.0.0/16)
    /^169\.254\./,

    // Carrier-grade NAT (100.64.0.0/10)
    /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,
];

/**
 * Known internal/localhost hostnames.
 */
const INTERNAL_HOSTNAMES: string[] = [
    'localhost',
    'localhost.localdomain',
    '0.0.0.0',
    '::1',
    'ip6-localhost',
    'ip6-loopback',
];

/**
 * Cloud provider metadata endpoints that should require confirmation.
 * These can expose sensitive instance information.
 */
const CLOUD_METADATA_HOSTS: string[] = [
    '169.254.169.254',      // AWS, GCP, Azure, DigitalOcean, etc.
    'metadata.google.internal',
    'metadata.goog',
];

/**
 * Check if a URL points to an internal/private network resource.
 *
 * @param urlString - The URL to check
 * @returns true if the URL targets an internal resource
 */
export function isInternalUrl(urlString: string): boolean {
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();

        // Check known internal hostnames
        if (INTERNAL_HOSTNAMES.includes(hostname)) {
            return true;
        }

        // Check cloud metadata endpoints
        if (CLOUD_METADATA_HOSTS.includes(hostname)) {
            return true;
        }

        // Check if hostname is an IP in internal ranges
        for (const pattern of INTERNAL_IP_PATTERNS) {
            if (pattern.test(hostname)) {
                return true;
            }
        }

        // Check for IPv6 loopback and link-local
        // URL parser includes brackets for IPv6, so check both forms
        if (hostname === '::1' || hostname === '[::1]' ||
            hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) {
            return true;
        }

        return false;
    } catch {
        // Invalid URL, treat as non-internal
        return false;
    }
}

/**
 * Get a human-readable description of why a URL is considered internal.
 *
 * @param urlString - The URL to describe
 * @returns Description of the internal URL type, or null if not internal
 */
export function getInternalUrlReason(urlString: string): string | null {
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();

        if (INTERNAL_HOSTNAMES.includes(hostname)) {
            return 'localhost/loopback address';
        }

        if (CLOUD_METADATA_HOSTS.includes(hostname)) {
            return 'cloud instance metadata endpoint';
        }

        if (/^127\./.test(hostname)) {
            return 'loopback address (127.x.x.x)';
        }

        if (/^10\./.test(hostname)) {
            return 'private network (10.x.x.x)';
        }

        if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) {
            return 'private network (172.16-31.x.x)';
        }

        if (/^192\.168\./.test(hostname)) {
            return 'private network (192.168.x.x)';
        }

        if (/^169\.254\./.test(hostname)) {
            return 'link-local address';
        }

        if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(hostname)) {
            return 'carrier-grade NAT address';
        }

        return null;
    } catch {
        return null;
    }
}
