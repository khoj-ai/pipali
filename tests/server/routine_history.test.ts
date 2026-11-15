import { describe, expect, test } from 'bun:test';
import { ROUTINE_SUMMARY_KEY, routineHistoryView, runsFingerprints, splitRoutineRuns, type SummaryCheckpoint } from '../../src/server/automation/history';
import { generateChatmlMessagesWithContext } from '../../src/server/processor/conversation/utils';
import type { ATIFStep } from '../../src/server/processor/conversation/atif/atif.types';

// Step n is said at 09:00 on November n, 2026, local time; the 2nd is a Monday
let nextId = 1;
function step(source: ATIFStep['source'], message: string, extra?: Partial<ATIFStep>): ATIFStep {
    const id = nextId++;
    return { step_id: id, timestamp: new Date(2026, 10, id, 9, 0).toISOString(), source, message, ...extra };
}
const prompt = (execution: string) => step('user', 'Brief me', { extra: { routine_execution_id: execution } });
const memoryUpdate = () => step('system', '# Memory updated', { extra: { kind: 'memory_update', memory_catalogue: 'a.md: A' } });

/** Base prompt, a run from before runs were marked, then marked runs 2-4 */
function thread() {
    nextId = 1;
    const base = step('system', 'You are Pipali');
    const run1 = [step('user', '[Scheduled execution at 2026-11-01T09:00:00Z]\n\nBrief me'), step('agent', 'Run 1 report')];
    const run2 = [
        prompt('e2'),
        step('agent', '', { tool_calls: [{ tool_call_id: 'c1', function_name: 'search_web', arguments: { query: 'news' } }] }),
        step('agent', 'Run 2 report'),
        step('user', 'Skip crypto from now on'),
        step('agent', 'Noted'),
    ];
    const run3 = [prompt('e3'), memoryUpdate(), step('agent', 'Run 3 report')];
    const run4 = [prompt('e4'), step('system', '# Routine run\nTrigger: schedule', { extra: { kind: 'routine_trigger' } })];
    return { steps: [base, ...run1, ...run2, ...run3, ...run4], base, run1, run2, run3, run4 };
}

/** A summary of the first `runs` runs, as a fold would have saved it */
function checkpoint(steps: ATIFStep[], runs: number, text = `Summary of ${runs}`): SummaryCheckpoint {
    return { text, runs, fingerprint: runsFingerprints(splitRoutineRuns(steps).runs)[runs - 1]! };
}
/** A conversation's extra holding these checkpoints, as a fold saves them */
const saved = (...checkpoints: SummaryCheckpoint[]) => ({ [ROUTINE_SUMMARY_KEY]: { checkpoints } });
const noticeOf = (steps: ATIFStep[]) => steps[1]!.message!.split('\n');

/** Steps with platform compactions placed after the given steps, each recording what came before it as one does when made */
function compactAfter(steps: ATIFStep[], after: ATIFStep[], text = 'Platform summary'): { steps: ATIFStep[]; compactions: ATIFStep[] } {
    const compactions: ATIFStep[] = [];
    const result = steps.flatMap(s => {
        if (!after.includes(s)) return [s];
        const compaction = step('user', `${text} after step ${s.step_id}`, { extra: { is_compaction: true } });
        compactions.push(compaction);
        return [s, compaction];
    });
    for (const compaction of compactions) compaction.extra!.source_steps = result.indexOf(compaction);
    return { steps: result, compactions };
}

describe('splitRoutineRuns', () => {
    test('cuts at marked and older prompts, keeping follow-ups with the run they follow', () => {
        const { steps, base, run1, run2, run3, run4 } = thread();
        expect(splitRoutineRuns(steps)).toEqual({ base: [base], runs: [run1, run2, run3, run4] });
    });
});

describe('routineHistoryView', () => {
    test('all, and a history no longer than what is kept, are sent as they are', () => {
        const { steps } = thread();
        expect(routineHistoryView(steps, { mode: 'all', runs: 3 })).toEqual({ steps, freshCatalogue: false });
        expect(routineHistoryView(steps, { mode: 'summarized', runs: 3 })).toEqual({ steps, freshCatalogue: false });
    });

    test('fresh keeps the base prompt and this run alone', () => {
        const { steps, base, run4 } = thread();
        expect(routineHistoryView(steps, { mode: 'fresh', runs: 3 })).toEqual({ steps: [base, ...run4], freshCatalogue: true });
    });

    test('summarized keeps the latest runs whole, their tool calls and follow-ups included', () => {
        const { steps, base, run2, run3, run4 } = thread();
        const view = routineHistoryView(steps, { mode: 'summarized', runs: 2 }, saved(checkpoint(steps, 1, 'Run 1 found nothing.')));

        const [kept, notice, ...shown] = view.steps;
        expect(kept).toBe(base);
        expect(notice!.message).toBe([
            '# Earlier runs of this routine',
            'Run 1 is not in this context. Summary of run 1, the last from Monday, 2026-11-02 09:00:',
            'Runs 2-3 follow in full, then run 4, this one.',
            '',
            'Run 1 found nothing.',
        ].join('\n'));
        // The catalogue announcement is dropped: the prompt lists the current catalogue instead
        expect(shown).toEqual([...run2, ...run3.filter(s => s.extra?.kind !== 'memory_update'), ...run4]);
        expect(view.freshCatalogue).toBe(true);
    });

    test('summarizes exactly the runs left out, saying which it does not cover yet', () => {
        const { steps } = thread();
        const notice = (runs: number, checkpoints: SummaryCheckpoint[]) =>
            noticeOf(routineHistoryView(steps, { mode: 'summarized', runs }, saved(...checkpoints)).steps);

        expect(notice(0, [])).toEqual([
            '# Earlier runs of this routine',
            'Runs 1-3 are not in this context and not summarized yet.',
            'Run 4, this one, follows.',
        ]);
        expect(notice(0, [checkpoint(steps, 1)])[1]).toBe('Runs 1-3 are not in this context. '
            + 'Summary of run 1, the last from Monday, 2026-11-02 09:00 (runs 2-3 are not in it yet):');
        expect(notice(0, [checkpoint(steps, 1), checkpoint(steps, 3)])[1]).toBe('Runs 1-3 are not in this context. '
            + 'Summary of runs 1-3, the last from Monday, 2026-11-09 09:00:');
    });

    test('keeping more runs goes back to a shorter summary rather than one that covers kept runs', () => {
        const { steps } = thread();
        const checkpoints = [checkpoint(steps, 1, 'Through run 1'), checkpoint(steps, 3, 'Through run 3')];
        const notice = noticeOf(routineHistoryView(steps, { mode: 'summarized', runs: 1 }, saved(...checkpoints)).steps);

        expect(notice[1]).toBe('Runs 1-2 are not in this context. '
            + 'Summary of run 1, the last from Monday, 2026-11-02 09:00 (run 2 is not in it yet):');
        expect(notice.at(-1)).toBe('Through run 1');
    });

    test('an edit inside summarized runs voids the summaries that covered it', () => {
        const { steps, run2 } = thread();
        const checkpoints = [checkpoint(steps, 1, 'Through run 1'), checkpoint(steps, 2, 'Through run 2')];
        const edited = steps.map(s => s === run2[2] ? { ...s, message: 'Run 2 report, corrected' } : s);
        const deleted = steps.filter(s => s !== run2[3] && s !== run2[4]);

        for (const history of [edited, deleted]) {
            const notice = noticeOf(routineHistoryView(history, { mode: 'summarized', runs: 1 }, saved(...checkpoints)).steps);
            expect(notice[1]).toContain('Summary of run 1, the last from Monday, 2026-11-02 09:00 (run 2 is not in it yet):');
            expect(notice.at(-1)).toBe('Through run 1');
        }
    });

    test('the model is sent the summary, then the kept runs', () => {
        const { steps } = thread();
        const view = routineHistoryView(steps, { mode: 'summarized', runs: 1 }, saved(checkpoint(steps, 2)));
        const sent = generateChatmlMessagesWithContext('', view.steps, 'system prompt')
            .map(m => `${'role' in m ? m.role : m.type}: ${'content' in m ? String(m.content).split('\n')[0] : ''}`);

        expect(sent).toEqual([
            'system: system prompt',
            'user: # Earlier runs of this routine',
            'user: Brief me',
            'assistant: Run 3 report',
            'user: Brief me',
            'system: # Routine run',
        ]);
    });

    test('a platform compaction leaves with its run, and still cuts within a run that is kept', () => {
        const { steps, run1, run3 } = thread();
        const { steps: compacted, compactions: [inRun1, inRun3] } = compactAfter(steps, [run1.at(-1)!, run3[0]!]);

        const view = routineHistoryView(compacted, { mode: 'summarized', runs: 1 });
        expect(view.steps).not.toContain(inRun1);
        const sent = generateChatmlMessagesWithContext('', view.steps, 'system prompt').map(m => 'content' in m ? m.content : '');
        expect(sent.slice(0, 2)).toEqual(['system prompt', inRun3!.message]);
    });

    test('a platform compaction is a boundary under all too: the catalogue starts afresh behind it', () => {
        const { steps, run3 } = thread();
        const { steps: compacted } = compactAfter(steps, [run3.at(-1)!]);

        const view = routineHistoryView(compacted, { mode: 'all', runs: 3 });
        expect(view.freshCatalogue).toBe(true);
        expect(view.steps.some(s => s.extra?.kind === 'memory_update')).toBe(false);
        expect(view.steps).toHaveLength(compacted.length - 1);
    });

    test('a platform compaction made before a step it summarized was deleted is not sent', () => {
        const { steps, run2, run3 } = thread();
        const { steps: compacted, compactions: [compaction] } = compactAfter(steps, [run3[0]!]);
        const sentAfter = (history: ATIFStep[], mode: 'all' | 'summarized') => generateChatmlMessagesWithContext(
            '', routineHistoryView(history, { mode, runs: 2 }).steps, 'system prompt').map(m => 'content' in m ? m.content : '');

        expect(sentAfter(compacted, 'all')[1]).toBe(compaction!.message);
        const deleted = compacted.filter(s => s !== run2[3] && s !== run2[4]);
        for (const mode of ['all', 'summarized'] as const) {
            const sent = sentAfter(deleted, mode);
            expect(sent).not.toContain(compaction!.message);
            expect(sent).toContain('Run 2 report');
        }
    });

    test('one made before counts were recorded holds while the ids before it are unbroken', () => {
        const { steps, run3 } = thread();
        // Saved in place with no count, its ids numbered as the database numbers them
        const legacy = step('user', 'Older platform summary', { extra: { is_compaction: true } });
        const history = steps.flatMap(s => s === run3[0] ? [s, legacy] : [s]).map((s, index) => ({ ...s, step_id: index + 1 }));
        const legacyStep = history.find(s => s.message === 'Older platform summary')!;

        expect(routineHistoryView(history, { mode: 'all', runs: 0 }).steps).toContainEqual(legacyStep);
        const deleted = history.filter(s => s.message !== 'Skip crypto from now on');
        expect(routineHistoryView(deleted, { mode: 'all', runs: 0 }).steps).not.toContainEqual(legacyStep);
    });

    test('a compaction added inside summarized runs leaves their summaries valid', () => {
        const { steps, run1, run2 } = thread();
        const checkpoints = [checkpoint(steps, 2, 'Through run 2')];
        const { steps: compacted } = compactAfter(steps, [run1.at(-1)!, run2[2]!]);

        expect(noticeOf(routineHistoryView(compacted, { mode: 'summarized', runs: 1 }, saved(...checkpoints)).steps).at(-1)).toBe('Through run 2');
    });
});
