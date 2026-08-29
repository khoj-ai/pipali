/**
 * Pull-to-refresh gesture tracking.
 *
 * Pure geometry: the caller feeds it touch points and it decides whether the drag is a
 * pull and how far the indicator has travelled. No DOM, so the rules that keep the
 * gesture out of the way of scrolling - a slop box before it commits, a rubber band, a
 * distance to beat - can be exercised directly.
 */

/** Travel allowed before the gesture commits, so a tap stays a tap and a flick stays a flick. */
export const TOUCH_SLOP = 8;

/** However hard it is pulled, the indicator stops here. */
export const MAX_PULL = 160;

/** Indicator travel that arms the refresh, reached after ~140px of finger travel. */
export const TRIGGER_DISTANCE = 72;

export type PullPhase = 'idle' | 'watching' | 'pulling';

/**
 * Rubber band: the indicator keeps pace with the finger at first, then falls behind and
 * approaches MAX_PULL, so the end of the pull feels like resistance rather than a wall.
 */
export function resist(travel: number): number {
    if (travel <= 0) return 0;
    return (travel * MAX_PULL) / (travel + MAX_PULL);
}

export interface PullTracker {
    readonly phase: PullPhase;
    /** How far the indicator should sit from its resting place, in pixels. */
    readonly distance: number;
    start(x: number, y: number): void;
    move(x: number, y: number): PullPhase;
    /** Ends the gesture. Returns whether releasing here should refresh. */
    end(): boolean;
    cancel(): void;
}

export function createPullTracker(): PullTracker {
    let phase: PullPhase = 'idle';
    let originX = 0;
    let originY = 0;
    let distance = 0;

    return {
        get phase() {
            return phase;
        },

        get distance() {
            return distance;
        },

        start(x, y) {
            phase = 'watching';
            originX = x;
            originY = y;
            distance = 0;
        },

        move(x, y) {
            const dx = x - originX;
            const dy = y - originY;

            if (phase === 'watching') {
                // Whichever direction leaves the slop box first owns the touch. Sideways or
                // upward means a swipe or a scroll, and the gesture is given up for good.
                if (Math.abs(dx) >= TOUCH_SLOP || dy <= -TOUCH_SLOP) phase = 'idle';
                else if (dy >= TOUCH_SLOP) phase = 'pulling';
            }

            if (phase === 'pulling') distance = resist(dy - TOUCH_SLOP);
            return phase;
        },

        end() {
            const triggered = phase === 'pulling' && distance >= TRIGGER_DISTANCE;
            phase = 'idle';
            distance = 0;
            return triggered;
        },

        cancel() {
            phase = 'idle';
            distance = 0;
        },
    };
}
