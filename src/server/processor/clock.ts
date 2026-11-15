/**
 * The date and time of day the model can see.
 *
 * The system prompt states the moment the conversation started and is never
 * rewritten, so the cached prompt prefix survives the clock moving on. The time
 * since is carried by appended system steps: one whenever the local date or time
 * of day differs from the last one in the model's context.
 */

import type { ATIFStep } from './conversation/atif/atif.types';
import { findMostRecentCompactionIndex } from './conversation/utils';

export const CLOCK_KIND = 'clock';

/**
 * Coarse on purpose: the clock advances a handful of times a day rather than
 * every minute, and the small hours read as a new date rather than the previous
 * night.
 */
export function getTimeOfDay(date: Date): string {
    const hour = date.getHours();
    if (hour < 4) return 'after midnight';
    if (hour < 8) return 'early morning';
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    if (hour < 21) return 'evening';
    return 'night';
}

function formatLocalDate(date: Date): string {
    return `${date.toLocaleDateString('en-US', { weekday: 'long' })}, ${date.toLocaleDateString('en-CA')}`;
}

/** "Friday, 2026-09-18 afternoon" in this machine's timezone, which is the user's: Pipali runs on their computer */
export function formatLocalDateTime(date: Date): string {
    return `${formatLocalDate(date)} ${getTimeOfDay(date)}`;
}

/** "Friday, 2026-09-18 15:05", for a moment the model needs to the minute */
export function formatExactLocalDateTime(date: Date): string {
    return `${formatLocalDate(date)} ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** When the persisted system prompt was written. Auxiliary system steps all carry a kind; the prompt is the one that does not. */
export function conversationStartedAt(steps: ATIFStep[]): Date | undefined {
    const prompt = steps.find(step => step.source === 'system' && step.extra?.kind === undefined);
    return prompt ? new Date(prompt.timestamp) : undefined;
}

/**
 * A system step announcing the current date and time of day, when it differs from
 * the last one the model can see: the latest clock step still in context after
 * compaction, else the system prompt. Nothing for a new conversation, whose prompt
 * is written from the current moment.
 */
export function resolveClockContext(
    steps: ATIFStep[],
    now = new Date(),
): { systemSteps: Array<{ message: string; extra: Record<string, unknown> }> } {
    const compactionIndex = findMostRecentCompactionIndex(steps);
    const inContext = compactionIndex >= 0 ? steps.slice(compactionIndex) : steps;
    const lastClock = inContext.findLast(step => step.extra?.kind === CLOCK_KIND);
    const lastTold = lastClock ? new Date(lastClock.timestamp) : conversationStartedAt(steps);

    const current = formatLocalDateTime(now);
    if (!lastTold || formatLocalDateTime(lastTold) === current) {
        return { systemSteps: [] };
    }
    return {
        systemSteps: [{
            message: `Current Date, Time (in User Local Timezone): ${current}`,
            extra: { kind: CLOCK_KIND },
        }],
    };
}
