/**
 * Origin checks shared by the HTTP API and the WebSocket upgrade.
 *
 * Browsers attach an Origin the page cannot forge, so comparing it to the Host we were reached on
 * tells us whether the request came from our own UI or from an unrelated site driving the user's
 * browser. Non-browser clients send no Origin at all and stay allowed.
 *
 * The Host header alone proves nothing: a DNS rebinding can point a chosen name at 127.0.0.1
 * and supply pages with a matching Origin and Host. Same-origin matching is therefore
 * limited to hosts we already expect to be reached on.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Drop the port when it is the default for http/https, so https://host and host compare equal
function normalizeAuthority(authority: string): string {
    return authority.trim().toLowerCase().replace(/:(80|443)$/, '');
}

function hostnameOf(authority: string): string {
    const normalized = normalizeAuthority(authority);
    if (normalized.startsWith('[')) {
        const end = normalized.indexOf(']');
        return end === -1 ? normalized : normalized.slice(0, end + 1);
    }
    const port = normalized.lastIndexOf(':');
    return port === -1 ? normalized : normalized.slice(0, port);
}

let cachedTrustedHostsRaw: string | undefined;
let cachedTrustedHosts = new Set<string>();

/**
 * Extra names this server is served under, for reverse-proxy and tailnet deployments:
 * PIPALI_TRUSTED_HOSTS=machine.tailnet-name.ts.net,pipali.example. Ports are ignored.
 */
function configuredTrustedHosts(): Set<string> {
    const raw = process.env.PIPALI_TRUSTED_HOSTS ?? '';
    if (raw !== cachedTrustedHostsRaw) {
        cachedTrustedHostsRaw = raw;
        cachedTrustedHosts = new Set(raw.split(',').map(hostnameOf).filter(Boolean));
    }
    return cachedTrustedHosts;
}

function isExpectedHost(host: string): boolean {
    const hostname = hostnameOf(host);
    return LOOPBACK_HOSTNAMES.has(hostname) || configuredTrustedHosts().has(hostname);
}

// A browser serializes Origin as scheme://host[:port]; userinfo means it came from somewhere else
function parseOrigin(origin: string): URL | null {
    try {
        const url = new URL(origin);
        return url.username || url.password ? null : url;
    } catch {
        return null;
    }
}

// macOS/Linux WebView uses tauri://localhost, Windows WebView2 uses http://tauri.localhost
export function isTrustedBrowserOrigin(origin: string): boolean {
    const url = parseOrigin(origin);
    if (!url) return false;
    if (url.protocol === 'tauri:') return true;
    return url.protocol === 'http:'
        && (url.hostname === 'tauri.localhost' || LOOPBACK_HOSTNAMES.has(url.hostname));
}

// TLS-terminating reverse proxies (e.g. tailscale serve) forward the external Host but reach us over
// plain http, so the origin scheme cannot match. Comparing host(:port) keeps those requests working.
function isSameOriginRequest(origin: string, host: string | undefined): boolean {
    if (!host || !isExpectedHost(host)) return false;
    const url = parseOrigin(origin);
    return !!url?.host && normalizeAuthority(url.host) === normalizeAuthority(host);
}

export function isAllowedOrigin(origin: string, host: string | undefined): boolean {
    return isTrustedBrowserOrigin(origin) || isSameOriginRequest(origin, host);
}

/**
 * Whether a request may act on the user's behalf.
 *
 * Unlike the API guard this has no safe-method exemption: a WebSocket handshake is a GET that opens
 * a fully state-changing channel, and CORS never covers it.
 */
export function isAllowedRequestOrigin(req: Request): boolean {
    const origin = req.headers.get('Origin');
    if (!origin) return true; // Non-browser clients (CLI, desktop internals) send no Origin
    return isAllowedOrigin(origin, req.headers.get('Host') ?? undefined);
}
