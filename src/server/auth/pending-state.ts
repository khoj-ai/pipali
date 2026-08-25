/**
 * Pending platform sign-in requests.
 *
 * Each sign-in carries a state we minted and consume on completion,
 * so only a sign-in this server started can store credentials.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 16;

const pending = new Map<string, number>();

function dropExpired(now: number): void {
    for (const [state, expiresAt] of pending) {
        if (expiresAt <= now) pending.delete(state);
    }
}

export function createPendingAuthState(): string {
    const now = Date.now();
    dropExpired(now);
    // Map iterates in insertion order, so this sheds the stalest abandoned sign-in attempts
    while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
    }

    const state = crypto.randomUUID();
    pending.set(state, now + STATE_TTL_MS);
    return state;
}

/** Accept a state exactly once, so a captured callback URL cannot be replayed. */
export function consumePendingAuthState(state: unknown): boolean {
    if (typeof state !== 'string' || !state) return false;
    dropExpired(Date.now());
    return pending.delete(state);
}
