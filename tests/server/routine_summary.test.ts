import { describe, expect, test } from 'bun:test';
import { runsFingerprints, splitRoutineRuns, type SummaryCheckpoint } from '../../src/server/automation/history';
import { boundSummary, foldCheckpoints, planFolds, renderRun } from '../../src/server/automation/summary';
import type { ATIFStep } from '../../src/server/processor/conversation/atif/atif.types';

let nextId = 1;
function step(source: ATIFStep['source'], message: string, extra?: Partial<ATIFStep>): ATIFStep {
    const id = nextId++;
    return { step_id: id, timestamp: new Date(2026, 10, 1, 9, id).toISOString(), source, message, ...extra };
}
const toolResult = (content: string) => step('agent', '', { observation: { results: [{ source_call_id: 'c', content }] } });

/** `count` marked runs, each a prompt, `output` characters of tool output and a report */
function runsOf(count: number, output = 0): ATIFStep[][] {
    nextId = 1;
    return Array.from({ length: count }, (_, index) => [
        step('user', `Brief me ${index + 1}`, { extra: { routine_execution_id: `e${index + 1}` } }),
        ...(output ? [toolResult(`<output of run ${index + 1}>${'x'.repeat(output)}</output of run ${index + 1}>`)] : []),
        step('agent', `Report ${index + 1}`),
    ]);
}

/** A summarizer that answers with the runs it was given, so each summary shows what it covers */
function fakeSummarizer() {
    const queries: string[] = [];
    const summarize = async (query: string) => {
        queries.push(query);
        const previous = query.match(/<previous_summary>\n([\s\S]*?)\n<\/previous_summary>/)![1];
        const runs = [...query.matchAll(/## Run (\d+)/g)].map(match => match[1]).join(',');
        return [previous, runs].filter(Boolean).join(',');
    };
    return { queries, summarize };
}
const checkpointOf = (runs: ATIFStep[][], covered: number, text: string): SummaryCheckpoint =>
    ({ text, runs: covered, fingerprint: runsFingerprints(runs)[covered - 1]! });
const covering = (checkpoints: SummaryCheckpoint[]) => checkpoints.map(cp => `${cp.runs}:${cp.text}`);

describe('planFolds', () => {
    test('short runs share a call that ends where they do', () => {
        const calls = planFolds(runsOf(3), 1, 3);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.coversRuns).toBe(3);
        expect(calls[0]!.text.match(/## Run \d/g)).toEqual(['## Run 1', '## Run 2', '## Run 3']);
    });

    test('a run too long for one call is split into parts, and every character reaches a call', () => {
        const runs = runsOf(2, 150_000);
        const calls = planFolds(runs, 1, 2);

        expect(calls.every(call => call.text.length <= 60_000)).toBe(true);
        expect(calls.filter(call => call.coversRuns).map(call => call.coversRuns)).toEqual([1, 2]);
        const sent = calls.map(call => call.text).join('\n').replace(/\[Run \d, part \d of \d\]\n/g, '');
        for (const run of [1, 2]) {
            const output = sent.slice(sent.indexOf(`<output of run ${run}>`), sent.indexOf(`</output of run ${run}>`));
            expect(output.replace(/\n/g, '')).toHaveLength(`<output of run ${run}>`.length + 150_000);
        }
        expect(calls[0]!.text).toStartWith('[Run 1, part 1 of 3]');
    });
});

describe('renderRun', () => {
    test('gives the summarizer what was said, done and recalled, not bookkeeping or derived summaries', () => {
        nextId = 1;
        const text = renderRun([
            step('user', 'Brief me'),
            step('user', 'Markets were calm all week', { extra: { is_compaction: true } }),
            step('system', '# Routine run\nTrigger: schedule', { extra: { kind: 'routine_trigger' } }),
            step('system', 'Current Date, Time: Monday', { extra: { kind: 'clock' } }),
            step('system', '# Memory recalled\nThe user reads at 7am', { extra: { kind: 'memory_recall' } }),
            step('system', '# Memory updated', { extra: { kind: 'memory_update' } }),
            step('agent', '', { tool_calls: [{ tool_call_id: 'c', function_name: 'search_web', arguments: { query: 'news' } }] }),
            step('agent', '', { observation: { results: [{ source_call_id: 'c', content: 'y'.repeat(5_000) }] } }),
            step('agent', 'Nothing urgent'),
        ], 4);

        expect(text.split('\n').map(line => line.slice(0, 60))).toEqual([
            '## Run 4, Sunday, 2026-11-01 09:01',
            'User: Brief me',
            'System: # Routine run',
            'Trigger: schedule',
            'System: # Memory recalled',
            'The user reads at 7am',
            'Tool call: search_web {"query":"news"}',
            `Tool result: ${'y'.repeat(47)}`,
            'Pipali: Nothing urgent',
        ]);
        expect(text).toContain(`Tool result: ${'y'.repeat(5_000)}\n`);
    });
});

describe('boundSummary', () => {
    test('shortens a summary over its limit, and says where it cuts one still over', async () => {
        expect(await boundSummary('short', async () => 'unused')).toBe('short');
        expect(await boundSummary('z'.repeat(7_000), async () => 'shortened')).toBe('shortened');
        const cut = await boundSummary('z'.repeat(7_000), async () => 'w'.repeat(6_500));
        expect(cut).toBe(`${'w'.repeat(6_000)}\n[The summary was over its 6000 character limit and is cut here.]`);
    });
});

describe('foldCheckpoints', () => {
    test('folds the runs left out on top of the summary that covers the runs before them', async () => {
        const runs = runsOf(6);
        const { queries, summarize } = fakeSummarizer();
        const saved: SummaryCheckpoint[][] = [];

        const checkpoints = await foldCheckpoints(runs, [checkpointOf(runs, 1, 'S1')], 3, summarize, async cps => saved.push(cps));
        expect(covering(checkpoints)).toEqual(['1:S1', '2:S1,2']);
        expect(queries).toHaveLength(1);
        expect(saved.at(-1)).toEqual(checkpoints);
    });

    test('an edit in summarized runs rebuilds from the last summary before it', async () => {
        const runs = runsOf(6);
        const stored = [checkpointOf(runs, 1, 'S1'), checkpointOf(runs, 2, 'S1,2')];
        runs[1]![1] = { ...runs[1]![1]!, message: 'Report 2, corrected' };
        const { summarize } = fakeSummarizer();

        const checkpoints = await foldCheckpoints(runs, stored, 3, summarize, async () => {});
        expect(covering(checkpoints)).toEqual(['1:S1', '2:S1,2']);
        expect(checkpoints[1]!.fingerprint).toBe(runsFingerprints(runs)[1]!);
    });

    test('keeping more runs folds a shorter summary from an earlier one, or from the first run', async () => {
        const runs = runsOf(8);
        const { summarize } = fakeSummarizer();
        const stored = [checkpointOf(runs, 2, 'S1,2'), checkpointOf(runs, 6, 'S1,2,3,4,5,6')];

        expect(covering(await foldCheckpoints(runs, stored, 4, summarize, async () => {})))
            .toEqual(['2:S1,2', '3:S1,2,3', '6:S1,2,3,4,5,6']);
        expect(covering(await foldCheckpoints(runs, [stored[1]!], 6, summarize, async () => {})))
            .toEqual(['1:1', '6:S1,2,3,4,5,6']);
    });

    test('a long backlog folds a few calls per run, finishing the run it is in', async () => {
        const runs = runsOf(9, 50_000);
        const { queries, summarize } = fakeSummarizer();

        const checkpoints = await foldCheckpoints(runs, [], 0, summarize, async () => {});
        expect(checkpoints.at(-1)!.runs).toBe(4);
        expect(queries.length).toBeGreaterThanOrEqual(4);
    });

    test('a failed call keeps what was folded before it', async () => {
        const runs = runsOf(30, 50_000);
        let calls = 0;
        const summarize = async () => (++calls === 3 ? undefined : `S${calls}`);

        const checkpoints = await foldCheckpoints(runs, [], 0, summarize, async () => {});
        expect(checkpoints.map(cp => cp.runs)).toEqual([1, 2]);
    });
});
