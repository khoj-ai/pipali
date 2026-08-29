import { test, expect, describe } from 'bun:test';
import {
    createPullTracker,
    resist,
    MAX_PULL,
    TOUCH_SLOP,
    TRIGGER_DISTANCE,
    type PullTracker,
} from '../../src/client/utils/pull-to-refresh';

/** Finger travel that reaches the trigger distance once the rubber band is applied. */
const FULL_PULL = TOUCH_SLOP + (TRIGGER_DISTANCE * MAX_PULL) / (MAX_PULL - TRIGGER_DISTANCE);

/** Runs a gesture down the screen from (0, 0), reporting every point on the way. */
function pullDown(tracker: PullTracker, to: number, from = 0): void {
    tracker.start(0, from);
    for (let y = from + 4; y <= to; y += 4) tracker.move(0, y);
}

describe('pull to refresh gesture', () => {
    test('a tap is not a pull', () => {
        const tracker = createPullTracker();
        tracker.start(120, 200);
        expect(tracker.end()).toBe(false);
    });

    test('a drag up the screen stays with the scroller', () => {
        const tracker = createPullTracker();
        tracker.start(0, 300);
        for (let y = 296; y >= 100; y -= 4) tracker.move(0, y);
        expect(tracker.phase).toBe('idle');
        expect(tracker.end()).toBe(false);
    });

    test('a swipe across the screen stays with whatever handles swipes', () => {
        const tracker = createPullTracker();
        tracker.start(0, 0);
        // Drifts down as it goes, as a real thumb does, but leaves the slop box sideways.
        for (let x = 4; x <= 200; x += 4) tracker.move(x, x / 4);
        expect(tracker.phase).toBe('idle');
        expect(tracker.end()).toBe(false);
    });

    test('a drag down past the slop becomes a pull', () => {
        const tracker = createPullTracker();
        tracker.start(0, 0);
        expect(tracker.move(0, TOUCH_SLOP - 1)).toBe('watching');
        expect(tracker.distance).toBe(0);
        expect(tracker.move(0, TOUCH_SLOP + 20)).toBe('pulling');
        expect(tracker.distance).toBeGreaterThan(0);
    });

    test('the indicator lags the finger and stops short of the screen', () => {
        const tracker = createPullTracker();
        pullDown(tracker, 400);
        expect(tracker.distance).toBeLessThan(400 - TOUCH_SLOP);
        expect(tracker.distance).toBeLessThan(MAX_PULL);

        const tugged = createPullTracker();
        pullDown(tugged, 4000);
        expect(tugged.distance).toBeLessThan(MAX_PULL);
        expect(tugged.distance).toBeGreaterThan(tracker.distance);
    });

    test('resistance grows with the pull and never reaches its limit', () => {
        expect(resist(-10)).toBe(0);
        expect(resist(0)).toBe(0);
        expect(resist(20)).toBeGreaterThan(resist(10));
        expect(resist(10)).toBeGreaterThan(10 * 0.8);
        expect(resist(Number.MAX_SAFE_INTEGER)).toBeLessThan(MAX_PULL);
    });

    test('letting go short of the trigger distance refreshes nothing', () => {
        const tracker = createPullTracker();
        pullDown(tracker, Math.floor(FULL_PULL) - 20);
        expect(tracker.phase).toBe('pulling');
        expect(tracker.end()).toBe(false);
    });

    test('letting go past the trigger distance refreshes', () => {
        const tracker = createPullTracker();
        pullDown(tracker, Math.ceil(FULL_PULL) + 20);
        expect(tracker.distance).toBeGreaterThanOrEqual(TRIGGER_DISTANCE);
        expect(tracker.end()).toBe(true);
    });

    test('pulling back up before letting go calls it off', () => {
        const tracker = createPullTracker();
        pullDown(tracker, Math.ceil(FULL_PULL) + 20);
        for (let y = FULL_PULL; y >= 0; y -= 4) tracker.move(0, y);
        expect(tracker.distance).toBe(0);
        expect(tracker.end()).toBe(false);
    });

    test('a second finger drops the gesture for good', () => {
        const tracker = createPullTracker();
        pullDown(tracker, Math.ceil(FULL_PULL) + 20);
        tracker.cancel();

        expect(tracker.move(0, FULL_PULL + 100)).toBe('idle');
        expect(tracker.distance).toBe(0);
        expect(tracker.end()).toBe(false);
    });

    test('the gesture ends when the finger lifts, not when it moves again', () => {
        const tracker = createPullTracker();
        pullDown(tracker, Math.ceil(FULL_PULL) + 20);
        expect(tracker.end()).toBe(true);

        expect(tracker.move(0, FULL_PULL + 100)).toBe('idle');
        expect(tracker.end()).toBe(false);
    });
});
