import { test, expect, describe, beforeEach, afterAll } from 'bun:test';
import { keepScreenAwake, releaseScreenAwake, __test__ } from '../../src/client/utils/wake-lock';

class FakeSentinel {
    released = false;
    private listeners: Array<() => void> = [];

    addEventListener(type: string, fn: () => void): void {
        if (type === 'release') this.listeners.push(fn);
    }

    async release(): Promise<void> {
        this.drop();
    }

    /** A release the platform performs on its own, as iOS does when the page hides. */
    drop(): void {
        if (this.released) return;
        this.released = true;
        for (const fn of this.listeners) fn();
    }
}

const visibilityListeners: Array<() => void> = [];
let requests = 0;
let live: FakeSentinel[] = [];

const fakeDocument = {
    visibilityState: 'visible',
    addEventListener(type: string, fn: () => void) {
        if (type === 'visibilitychange') visibilityListeners.push(fn);
    },
};

const fakeNavigator = {
    wakeLock: {
        async request(type: string) {
            if (type !== 'screen') throw new Error(`unexpected wake lock type: ${type}`);
            requests++;
            const sentinel = new FakeSentinel();
            live.push(sentinel);
            return sentinel;
        },
    },
};

const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function install(name: string, value: unknown): void {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// One install for the whole file: the module latches its visibilitychange listener on
// first use, so a per-test document would leave that listener on a stale object.
install('document', fakeDocument);
install('navigator', fakeNavigator);

// Both are process-global, so hand them back to whichever test file runs next.
afterAll(() => {
    if (realDocument) Object.defineProperty(globalThis, 'document', realDocument);
    else delete (globalThis as Record<string, unknown>).document;
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    else delete (globalThis as Record<string, unknown>).navigator;
});

/** Flush the module's serialized acquire/release queue. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const fireVisibilityChange = () => { for (const fn of visibilityListeners) fn(); };

describe('screen wake lock', () => {
    beforeEach(async () => {
        __test__.reset();
        await settle();
        requests = 0;
        live = [];
        fakeDocument.visibilityState = 'visible';
    });

    test('one lock serves every holder and survives all but the last release', async () => {
        keepScreenAwake();
        keepScreenAwake();
        await settle();
        expect(requests).toBe(1);

        releaseScreenAwake();
        await settle();
        expect(live[0]!.released).toBe(false);

        releaseScreenAwake();
        await settle();
        expect(live[0]!.released).toBe(true);

        // A release with nothing held must not drive the count below zero, which would
        // silently absorb the next acquire and leave the screen free to lock.
        releaseScreenAwake();
        keepScreenAwake();
        await settle();
        expect(requests).toBe(2);
        expect(live[1]!.released).toBe(false);
    });

    test('reclaims the lock the platform drops when the page hides', async () => {
        keepScreenAwake();
        await settle();
        expect(requests).toBe(1);

        // Backgrounding releases the sentinel without routing through us, and a request
        // made while hidden is refused.
        fakeDocument.visibilityState = 'hidden';
        live[0]!.drop();
        fireVisibilityChange();
        await settle();
        expect(requests).toBe(1);

        fakeDocument.visibilityState = 'visible';
        fireVisibilityChange();
        await settle();
        expect(requests).toBe(2);
        expect(live[1]!.released).toBe(false);
    });
});
