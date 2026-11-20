/**
 * Tells whether a URL leads to this computer or its private network, and fetches from the
 * addresses that were checked. Used to ask the user before an internal resource is read.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';

/** What the confirmation calls an internal address, by range. The first match names it. */
const INTERNAL_RANGES: Record<string, string[]> = {
    'cloud instance metadata endpoint': ['169.254.169.254/32', '192.0.0.192/32', 'fd00:ec2::254/128'],
    'localhost/loopback address': ['127.0.0.0/8', '0.0.0.0/8', '::1/128', '::/128'],
    'private network address': ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
    'link-local address': ['169.254.0.0/16', 'fe80::/10'],
    'carrier-grade NAT address': ['100.64.0.0/10'],
};

/**
 * The ranges of each reason as a net.BlockList, Node's set of IP ranges.
 * Its check() tells whether an address falls in any of them.
 */
const INTERNAL_RANGE_SETS = Object.entries(INTERNAL_RANGES).map(([reason, subnets]) => {
    const ranges = new net.BlockList();
    for (const subnet of subnets) {
        const [address, prefix] = subnet.split('/') as [string, string];
        ranges.addSubnet(address, Number(prefix), net.isIPv6(address) ? 'ipv6' : 'ipv4');
    }
    return { reason, ranges };
});

/**
 * Why an IP address is internal, or null for one on the public internet.
 * An IPv4 address written as IPv6 (::ffff:127.0.0.1) is judged by the IPv4 ranges.
 */
export function getInternalAddressReason(address: string): string | null {
    const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
    const internal = INTERNAL_RANGE_SETS.find(({ ranges }) => ranges.check(address, family));
    if (internal) return internal.reason;

    // A public address of one of this computer's network interfaces leads back to it.
    // They are read on each check, as they change with the network.
    const own = new net.BlockList();
    for (const assigned of Object.values(os.networkInterfaces()).flatMap(assigned => assigned ?? [])) {
        own.addAddress(assigned.address, net.isIPv6(assigned.address) ? 'ipv6' : 'ipv4');
    }
    return own.check(address, family) ? 'network address of this computer' : null;
}

export interface ResolvedHost {
    /** The addresses the host resolved to, IPv4 first. None for a name that did not resolve. */
    addresses: string[];
    /** Why the host is internal, or null for one on the public internet */
    internalReason: string | null;
}

/** The host of a URL as a resolver takes it: no IPv6 brackets, no root dot */
function bareHostname(url: URL): string {
    return url.hostname.replace(/^\[|\]$|\.$/g, '');
}

/**
 * Resolve the host of a URL. It is internal when any address it resolves to is, since a
 * public name can point at a private address.
 */
export async function resolveHost(url: URL): Promise<ResolvedHost> {
    const hostname = bareHostname(url);

    // Names under localhost are loopback (RFC 6761), though not every resolver answers for them
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        return { addresses: [], internalReason: 'localhost/loopback address' };
    }

    const found = await dns.lookup(hostname, { all: true }).catch(() => []);
    const addresses = found.sort((a, b) => a.family - b.family).map(({ address }) => address);
    const internalReason = addresses.map(getInternalAddressReason).find(reason => reason !== null) ?? null;
    return { addresses, internalReason };
}

/**
 * Fetch a URL from the addresses its host resolved to. Fetching by name would resolve the
 * host again, and that answer can differ from the one checked.
 *
 * An internal host is fetched by name: the user allowed it wherever it leads, and a
 * local server may listen on only one of localhost's addresses.
 */
export async function fetchResolvedHost(url: URL, host: ResolvedHost, init: RequestInit): Promise<Response> {
    if (host.internalReason) return fetch(url, init);

    // The request URL names an address, so the hostname goes where the server and TLS
    // look for it. The Host header picks the site among those sharing the address. The
    // TLS server name picks its certificate, and is the name the certificate must be for.
    const headers = new Headers(init.headers);
    headers.set('Host', url.host);
    const tls = { serverName: bareHostname(url) };

    // A host can have several addresses. The next is tried when one cannot be reached.
    let failure: unknown = new Error(`Could not resolve ${url.hostname}`);
    for (const address of host.addresses) {
        const pinned = new URL(url);
        pinned.hostname = net.isIPv6(address) ? `[${address}]` : address;
        try {
            return await fetch(pinned, { ...init, headers, tls });
        } catch (error) {
            if (init.signal?.aborted) throw error;
            failure = error;
        }
    }
    throw failure;
}
