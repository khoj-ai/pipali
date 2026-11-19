import { describe, expect, test } from 'bun:test';
import { runsFingerprints, splitRoutineRuns, type SummaryCheckpoint } from '../../src/server/automation/history';
import { foldCheckpoints, renderRun } from '../../src/server/automation/summary';
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
    const requests: string[][] = [];
    const summarize = async (previous: string, parts: string[]) => {
        requests.push(parts);
        const runs = parts.flatMap(part => [...part.matchAll(/^## Run (\d+)/g)].map(match => match[1])).join(',');
        return [previous, runs].filter(Boolean).join(',');
    };
    return { requests, summarize };
}
const checkpointOf = (runs: ATIFStep[][], covered: number, text: string): SummaryCheckpoint =>
    ({ text, runs: covered, fingerprint: runsFingerprints(runs)[covered - 1]! });
const covering = (checkpoints: SummaryCheckpoint[]) => checkpoints.map(cp => `${cp.runs}:${cp.text}`);

describe('renderRun', () => {
    test('gives the summarizer what was said, done and recalled, a part per step, not bookkeeping or derived summaries', () => {
        nextId = 1;
        const parts = renderRun([
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

        expect(parts.map(part => part.slice(0, 60))).toEqual([
            '## Run 4, Sunday, 2026-11-01 09:01\nUser: Brief me',
            'System: # Routine run\nTrigger: schedule',
            'System: # Memory recalled\nThe user reads at 7am',
            'Tool call: search_web {"query":"news"}',
            `Tool result: ${'y'.repeat(47)}`,
            'Pipali: Nothing urgent',
        ]);
        expect(parts[4]).toBe(`Tool result: ${'y'.repeat(5_000)}`);
    });
});

describe('foldCheckpoints', () => {
    test('folds the runs left out on top of the summary that covers the runs before them', async () => {
        const runs = runsOf(7);
        const { requests, summarize } = fakeSummarizer();

        const checkpoints = await foldCheckpoints(runs, [checkpointOf(runs, 1, 'S1')], 3, summarize);
        expect(covering(checkpoints!)).toEqual(['1:S1', '3:S1,2,3']);
        expect(requests).toHaveLength(1);
        expect(await foldCheckpoints(runs, checkpoints!, 3, summarize)).toBeUndefined();
    });

    test('an edit in summarized runs rebuilds from the last summary before it', async () => {
        const runs = runsOf(6);
        const stored = [checkpointOf(runs, 1, 'S1'), checkpointOf(runs, 2, 'S1,2')];
        runs[1]![1] = { ...runs[1]![1]!, message: 'Report 2, corrected' };
        const { requests, summarize } = fakeSummarizer();

        const checkpoints = await foldCheckpoints(runs, stored, 3, summarize);
        expect(covering(checkpoints!)).toEqual(['1:S1', '2:S1,2']);
        expect(checkpoints![1]!.fingerprint).toBe(runsFingerprints(runs)[1]!);
        expect(requests[0]).toContain('Pipali: Report 2, corrected');
    });

    test('keeping more runs folds a shorter summary from an earlier one, or from the first run', async () => {
        const runs = runsOf(8);
        const { summarize } = fakeSummarizer();
        const stored = [checkpointOf(runs, 2, 'S1,2'), checkpointOf(runs, 6, 'S1,2,3,4,5,6')];

        expect(covering((await foldCheckpoints(runs, stored, 4, summarize))!))
            .toEqual(['2:S1,2', '3:S1,2,3', '6:S1,2,3,4,5,6']);
        expect(covering((await foldCheckpoints(runs, [stored[1]!], 6, summarize))!))
            .toEqual(['1:1', '6:S1,2,3,4,5,6']);
    });

    test('a long backlog goes in one request, every step of it whole', async () => {
        const runs = runsOf(9, 50_000);
        const { requests, summarize } = fakeSummarizer();

        const checkpoints = await foldCheckpoints(runs, [], 0, summarize);
        expect(covering(checkpoints!)).toEqual(['8:1,2,3,4,5,6,7,8']);
        expect(requests).toHaveLength(1);
        for (let run = 1; run <= 8; run++) {
            expect(requests[0]).toContain(`Tool result: <output of run ${run}>${'x'.repeat(50_000)}</output of run ${run}>`);
        }
    });

    test('a call that returns no summary throws', async () => {
        const runs = runsOf(5);
        await expect(foldCheckpoints(runs, [checkpointOf(runs, 1, 'S1')], 0, async () => undefined)).rejects.toThrow('no summary');
    });
});
