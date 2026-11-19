/**
 * What a routine's run is given of its earlier runs.
 *
 * A routine keeps one conversation and every run stays in it. The history mode only
 * decides what the model is sent, so any mode can be switched back without loss:
 *
 *     all         base prompt, every run
 *     summarized  base prompt, summary of older runs, latest N runs whole, this run
 *     fresh       base prompt, this run
 *
 * A run starts at the routine's prompt and holds everything up to the next one, the
 * user's follow-ups and delegated results included, so a run is always kept whole.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { Automation } from '../db/schema';
import type { ATIFStep } from '../processor/conversation/atif/atif.types';
import { COMPACTION_SOURCE_STEPS_KEY } from '../processor/conversation/utils';
import { formatExactLocalDateTime } from '../processor/clock';
import { MEMORY_STATE_KIND, MEMORY_UPDATE_KIND } from '../memory';
import { ROUTINE_HISTORY_MODES, type RoutineHistoryMode } from '../../shared';

const isCompaction = (step: ATIFStep) => step.extra?.is_compaction === true;

/**
 * Whether a platform compaction still describes the history before it: no step it
 * summarized has been deleted since. One made before the count was recorded holds while
 * the step ids before it run unbroken from 1, as ids only gain gaps when steps are deleted.
 */
function compactionHolds(step: ATIFStep, stepsBefore: number): boolean {
    const recorded = step.extra?.[COMPACTION_SOURCE_STEPS_KEY];
    return stepsBefore === (typeof recorded === 'number' ? recorded : step.step_id - 1);
}

/** Set on a routine's prompt step to the execution it started */
export const ROUTINE_EXECUTION_KEY = 'routine_execution_id';

/** Prompt steps from before runs were marked carried their trigger in front of the prompt */
const UNMARKED_RUN_PROMPT = /^\[(Scheduled execution at |Triggered by file |Triggered externally via )/;

export interface RoutineHistoryPolicy {
    mode: RoutineHistoryMode;
    runs: number;
}

/**
 * The rolling summary of a routine conversation's older runs, kept in its `extra` as
 * checkpoints: the summary as it stood after each fold, with the runs it covers and a
 * fingerprint of their steps. Keeping a few lets a run that keeps more runs go back to
 * a shorter summary, and an edit to covered history voids only the checkpoints after it.
 */
export interface SummaryCheckpoint {
    text: string;
    /** How many runs, from the first, the summary covers */
    runs: number;
    /** runsFingerprint of those runs when they were summarized */
    fingerprint: string;
}

export const ROUTINE_SUMMARY_KEY = 'routine_summary';

export function readSummaryCheckpoints(extra: Record<string, unknown> | undefined): SummaryCheckpoint[] {
    const stored = (extra?.[ROUTINE_SUMMARY_KEY] as { checkpoints?: unknown } | undefined)?.checkpoints;
    return Array.isArray(stored)
        ? stored.filter((cp): cp is SummaryCheckpoint =>
            typeof cp?.text === 'string' && typeof cp.runs === 'number' && typeof cp.fingerprint === 'string')
        : [];
}

/**
 * A fingerprint of each leading stretch of runs: entry k covers runs 1 to k+1. Chained run
 * by run, so a long history is read once however many checkpoints are checked against it.
 */
export function runsFingerprints(runs: ATIFStep[][]): string[] {
    let chain = '';
    return runs.map(run => {
        // Compaction steps are derived from the others, so do not count as history of their own
        const content = JSON.stringify(run.filter(step => !isCompaction(step)).map(step =>
            [step.step_id, step.source, step.message ?? '', step.tool_calls ?? null, step.observation ?? null]));
        chain = Bun.hash(chain + content).toString(36);
        return chain;
    });
}

/**
 * The latest checkpoint that still matches the runs it covers and covers at most
 * `maxRuns`. One whose runs were edited, deleted or merged since no longer matches.
 */
export function latestValidCheckpoint(runs: ATIFStep[][], checkpoints: SummaryCheckpoint[], maxRuns: number): SummaryCheckpoint | undefined {
    const fingerprints = runsFingerprints(runs);
    return checkpoints
        .filter(cp => cp.runs >= 1 && cp.runs <= maxRuns && fingerprints[cp.runs - 1] === cp.fingerprint)
        .sort((a, b) => b.runs - a.runs)[0];
}

/** The history policy of the routine this conversation belongs to, if it is a routine's */
export async function routineHistoryPolicy(conversationId: string): Promise<RoutineHistoryPolicy | undefined> {
    const [routine] = await db.select({ mode: Automation.historyMode, runs: Automation.historyRuns })
        .from(Automation)
        .where(eq(Automation.conversationId, conversationId));
    return routine && ROUTINE_HISTORY_MODES.includes(routine.mode) ? routine : undefined;
}

function startsRun(step: ATIFStep): boolean {
    if (step.source !== 'user' || step.extra?.is_compaction === true) return false;
    return typeof step.extra?.[ROUTINE_EXECUTION_KEY] === 'string' || UNMARKED_RUN_PROMPT.test(step.message ?? '');
}

/**
 * The base system steps, then the conversation cut into runs. Anything said before the
 * first routine prompt counts as a run of its own, so it is summarized like the rest.
 */
export function splitRoutineRuns(steps: ATIFStep[]): { base: ATIFStep[]; runs: ATIFStep[][] } {
    const firstSaid = steps.findIndex(step => step.source !== 'system');
    if (firstSaid === -1) return { base: steps, runs: [] };

    const runs: ATIFStep[][] = [];
    for (const step of steps.slice(firstSaid)) {
        if (runs.length === 0 || startsRun(step)) runs.push([]);
        runs.at(-1)!.push(step);
    }
    return { base: steps.slice(0, firstSaid), runs };
}

const runRange = (from: number, to: number) => from === to ? `run ${from}` : `runs ${from}-${to}`;
const capitalize = (text: string) => text[0]!.toUpperCase() + text.slice(1);
/** "run 3 is" or "runs 1-3 are", for whichever verb the range takes */
const runsVerb = (from: number, to: number, one: string, many: string) =>
    `${runRange(from, to)} ${from === to ? one : many}`;

function summaryMessage(runs: ATIFStep[][], left: number, summary: SummaryCheckpoint | undefined): string {
    const total = runs.length;
    const lines = ['# Earlier runs of this routine'];
    const leftOut = capitalize(runsVerb(1, left, 'is', 'are'));
    if (!summary) {
        lines.push(`${leftOut} not in this context and not summarized yet.`);
    } else {
        const lastCovered = new Date(runs[summary.runs - 1]![0]!.timestamp);
        lines.push(`${leftOut} not in this context. `
            + `Summary of ${runRange(1, summary.runs)}, the last from ${formatExactLocalDateTime(lastCovered)}`
            + (summary.runs < left ? ` (${runsVerb(summary.runs + 1, left, 'is', 'are')} not in it yet):` : ':'));
    }
    lines.push(left < total - 1
        ? `${capitalize(runsVerb(left + 1, total - 1, 'follows', 'follow'))} in full, then run ${total}, this one.`
        : `Run ${total}, this one, follows.`);
    if (summary) lines.push('', summary.text);
    return lines.join('\n');
}

const announcesMemory = (step: ATIFStep) =>
    step.source === 'system' && (step.extra?.kind === MEMORY_STATE_KIND || step.extra?.kind === MEMORY_UPDATE_KIND);


/**
 * The steps a run is given under a history policy. Behind a compaction boundary - older
 * runs left out, or a platform compaction of an overflowing context - the prompt lists
 * the memory catalogue as it is now, so the catalogue announcements made against an
 * earlier baseline are left out: `freshCatalogue` says so.
 */
export function routineHistoryView(
    steps: ATIFStep[],
    policy: RoutineHistoryPolicy,
    /** The conversation's extra, which holds its summary checkpoints */
    extra?: Record<string, unknown>,
): { steps: ATIFStep[]; freshCatalogue: boolean } {
    // A compaction whose history has since lost a step may carry what was removed, so the
    // run is given the steps it summarized instead, and the platform compacts them afresh
    const current = steps.filter((step, index) => !isCompaction(step) || compactionHolds(step, index));
    const { base, runs } = splitRoutineRuns(current);
    const kept = policy.mode === 'fresh' ? 0 : policy.runs;
    const left = policy.mode === 'all' ? 0 : runs.length - 1 - kept;

    let view = current;
    if (left > 0) {
        const shown = runs.slice(left).flat();
        const notice: ATIFStep[] = policy.mode === 'summarized' ? [{
            step_id: 0,
            timestamp: shown[0]!.timestamp,
            source: 'user',
            message: summaryMessage(runs, left, latestValidCheckpoint(runs, readSummaryCheckpoints(extra), left)),
            extra: { is_compaction: true },
        }] : [];
        view = [...base, ...notice, ...shown];
    }

    const freshCatalogue = left > 0 || view.some(isCompaction);
    return { steps: freshCatalogue ? view.filter(step => !announcesMemory(step)) : view, freshCatalogue };
}
