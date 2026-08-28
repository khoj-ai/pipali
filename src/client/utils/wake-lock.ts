/**
 * Two wake locks with different jobs.
 *
 * preventIdleSleep keeps the machine running: a run works for minutes with nobody
 * watching, and the OS must not suspend underneath it. keepScreenAwake keeps the display
 * lit: a locked screen suspends microphone capture, so hands-free voice stops hearing the
 * moment the phone dims.
 *
 * Their costs differ, which is why they are separate. Lighting a phone's screen for every
 * background run would flatten the battery, so only voice takes the screen lock.
 */

import { isTauri } from './tauri';

// ============================================================================
// Idle sleep — desktop only, reference counted in Rust
// ============================================================================

export async function preventIdleSleep(): Promise<void> {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('acquire_wake_lock');
    } catch (err) {
        console.warn('[wakeLock] Failed to prevent idle sleep:', err);
    }
}

/** Balances one preventIdleSleep(). The OS may sleep once every holder has released. */
export async function releaseIdleSleep(): Promise<void> {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('release_wake_lock');
    } catch (err) {
        console.warn('[wakeLock] Failed to release idle sleep:', err);
    }
}

// ============================================================================
// Screen wake — any platform exposing the Screen Wake Lock API
// ============================================================================

/**
 * Guards the call, not the outcome. On iOS home screen web apps before 18.4 the API is
 * present but the lock never holds, so a true answer here is no promise of a lit screen.
 * There is no fallback worth having, and voice runs the same either way.
 */
function isScreenWakeLockSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

let holders = 0;
let sentinel: WakeLockSentinel | null = null;
let watchingVisibility = false;
let queue: Promise<void> = Promise.resolve();

/** Serialized so an overlapping acquire and release can never strand a second sentinel. */
function enqueue(op: () => Promise<void>): void {
    queue = queue.then(op).catch(() => {});
}

async function acquire(): Promise<void> {
    if (sentinel || holders === 0 || !isScreenWakeLockSupported()) return;
    // The request is rejected while the page is hidden; the visibility listener retries.
    if (document.visibilityState !== 'visible') return;
    try {
        const next = await navigator.wakeLock.request('screen');
        // Hiding the page releases the lock without going through us. Drop the stale
        // handle so returning to the page asks for a fresh one.
        next.addEventListener('release', () => {
            if (sentinel === next) sentinel = null;
        });
        if (holders > 0) sentinel = next;
        else await next.release();
    } catch {
        // Best effort. A refused screen lock must never take voice down with it.
    }
}

async function release(): Promise<void> {
    const current = sentinel;
    sentinel = null;
    try {
        await current?.release();
    } catch {
        // Already gone.
    }
}

function watchVisibility(): void {
    if (watchingVisibility || typeof document === 'undefined') return;
    watchingVisibility = true;
    document.addEventListener('visibilitychange', () => {
        if (holders > 0 && document.visibilityState === 'visible') enqueue(acquire);
    });
}

/** Hold the display on. Balance every call with releaseScreenAwake(). */
export function keepScreenAwake(): void {
    holders++;
    watchVisibility();
    enqueue(acquire);
}

export function releaseScreenAwake(): void {
    if (holders === 0) return;
    holders--;
    if (holders === 0) enqueue(release);
}

export const __test__ = {
    /** Drop every holder and any live sentinel, so a test starts from a cold module. */
    reset(): void {
        holders = 0;
        enqueue(release);
    },
};
