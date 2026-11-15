import { test, expect, describe } from 'bun:test';
import { CLOCK_KIND, conversationStartedAt, formatExactLocalDateTime, formatLocalDateTime, resolveClockContext } from '../../src/server/processor/clock';
import type { ATIFStep } from '../../src/server/processor/conversation/atif/atif.types';

// Built from local components, so the expectations hold in whichever timezone the tests run.
// September 2026: the 18th is a Friday.
const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 30);

const step = (source: ATIFStep['source'], when: Date, extra?: Record<string, unknown>): ATIFStep => ({
    step_id: 0,
    timestamp: when.toISOString(),
    source,
    message: '',
    ...(extra ? { extra } : {}),
});

/** A conversation whose system prompt was written at this moment, with one exchange after it */
const startedAt = (when: Date): ATIFStep[] => [
    step('system', when),
    step('user', when),
    step('agent', when),
];

/** One turn of the research runner: resolve, then persist what it returned */
function runTurn(steps: ATIFStep[], now: Date): ATIFStep[] {
    const { systemSteps } = resolveClockContext(steps, now);
    return [...steps, ...systemSteps.map(s => step('system', now, s.extra))];
}

describe('formatLocalDateTime', () => {
    test('renders weekday, ISO date and a coarse time of day', () => {
        expect(formatLocalDateTime(at(18, 15))).toBe('Friday, 2026-09-18 afternoon');
    });

    test('the small hours belong to the new date, not the previous night', () => {
        expect(formatLocalDateTime(at(18, 23))).toBe('Friday, 2026-09-18 night');
        expect(formatLocalDateTime(at(19, 1))).toBe('Saturday, 2026-09-19 after midnight');
    });

    test('the exact form gives the minute on a 24-hour clock', () => {
        expect(formatExactLocalDateTime(at(19, 1))).toBe('Saturday, 2026-09-19 01:30');
        expect(formatExactLocalDateTime(at(18, 15))).toBe('Friday, 2026-09-18 15:30');
    });
});

describe('resolveClockContext', () => {
    test('announces nothing while the conversation stays in the time of day it started in', () => {
        expect(resolveClockContext(startedAt(at(18, 13)), at(18, 16)).systemSteps).toEqual([]);
    });

    test('announces the new date and time of day once they differ from the prompt', () => {
        const { systemSteps } = resolveClockContext(startedAt(at(18, 15)), at(19, 9));

        expect(systemSteps).toHaveLength(1);
        expect(systemSteps[0]?.message).toBe('Current Date, Time (in User Local Timezone): Saturday, 2026-09-19 morning');
        expect(systemSteps[0]?.extra).toEqual({ kind: CLOCK_KIND });
    });

    test('announces each change once, the appended step being what the next turn reads', () => {
        const morning = runTurn(startedAt(at(18, 15)), at(19, 9));
        expect(morning).toHaveLength(4);

        // Still morning: the appended step is now the known state, not the prompt
        expect(runTurn(morning, at(19, 11))).toHaveLength(4);

        const afternoon = runTurn(morning, at(19, 14));
        expect(afternoon).toHaveLength(5);
        expect(resolveClockContext(afternoon, at(19, 14)).systemSteps).toEqual([]);
    });

    test('announces again when compaction has hidden the last announcement', () => {
        const announced = runTurn(startedAt(at(18, 15)), at(19, 9));
        const compacted = [
            ...announced,
            step('user', at(19, 9), { is_compaction: true }),
            step('agent', at(19, 9)),
        ];

        // Same morning, but the step that said so is no longer in the model's context
        const { systemSteps } = resolveClockContext(compacted, at(19, 10));
        expect(systemSteps).toHaveLength(1);
        expect(systemSteps[0]?.message).toContain('Saturday, 2026-09-19 morning');
    });

    test('announces nothing to a new conversation, whose prompt is written from now', () => {
        const steps = [step('user', at(18, 15))];
        expect(resolveClockContext(steps, at(19, 9)).systemSteps).toEqual([]);
    });
});

describe('conversationStartedAt', () => {
    test('reads the system prompt, not an auxiliary system step that precedes it in memory', () => {
        const steps = [
            step('user', at(18, 15)),
            step('system', at(18, 15), { kind: 'memory_recall', memory_paths: ['a.md'] }),
            step('system', at(18, 16)),
        ];
        expect(conversationStartedAt(steps)).toEqual(at(18, 16));
    });

    test('is undefined until a system prompt exists', () => {
        expect(conversationStartedAt([step('user', at(18, 15))])).toBeUndefined();
    });
});
