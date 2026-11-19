/**
 * The rolling summary of a summarized routine's older runs.
 *
 * Before a run, the runs it leaves out that no valid checkpoint covers yet are folded
 * in, given the latest checkpoint that still matches the history, or none, and every
 * step after it in full. Only a fold that returns a summary records a checkpoint, so a
 * failed one leaves the run's notice saying which runs are not summarized yet. The fold
 * goes to the model the run itself uses, so history sent to a user's own key is never
 * sent to the platform.
 */

import { eq } from 'drizzle-orm';
import { db, getChatModelById, getDefaultChatModel } from '../db';
import { Conversation, type User } from '../db/schema';
import type { ATIFStep } from '../processor/conversation/atif/atif.types';
import { sendMessageToFastModel, sendMessageToModel } from '../processor/conversation';
import { CLOCK_KIND, formatExactLocalDateTime } from '../processor/clock';
import { MCP_INVENTORY_KIND } from '../processor/actor/search_tools';
import { MEMORY_STATE_KIND, MEMORY_UPDATE_KIND } from '../memory';
import { createChildLogger } from '../logger';
import { MAX_ROUTINE_HISTORY_RUNS } from '../../shared';
import { latestValidCheckpoint, readSummaryCheckpoints, runsFingerprints, splitRoutineRuns, ROUTINE_SUMMARY_KEY, type SummaryCheckpoint } from './history';

const log = createChildLogger({ component: 'routine-summary' });

/** Enough to go back as far as the largest recent-run count */
const MAX_CHECKPOINTS = MAX_ROUTINE_HISTORY_RUNS + 1;

const SUMMARIZER_PROMPT = `You keep the running summary of a routine's earlier runs. A routine is a task Pipali runs on a schedule or trigger, in one conversation the user can also reply in. Its next runs read this summary in place of the runs it covers.

You are given the summary so far, which may be empty, and the runs that follow it. Write one concise handoff covering everything given, in plain text, with no preamble. Keep:
- Instructions, preferences and corrections the user gave, in their own words where short
- Findings, figures and decisions later runs may build on, with their dates
- What was already reported, so it is not reported again
- Work left unfinished or promised
Where runs disagree, the later run holds. Leave out what a later run cannot use, like greetings and how tools were called.`;

const SKIPPED_SYSTEM_KINDS = new Set([CLOCK_KIND, MCP_INVENTORY_KIND, MEMORY_STATE_KIND, MEMORY_UPDATE_KIND]);

function resultText(content: string | Array<{ type: string; [key: string]: string }>): string {
    return typeof content === 'string'
        ? content
        : content.map(part => typeof part.text === 'string' ? part.text : `[${part.type}]`).join('\n');
}

function stepText(step: ATIFStep): string[] {
    if (step.source === 'system') {
        return SKIPPED_SYSTEM_KINDS.has(step.extra?.kind as string) ? [] : [`System: ${step.message ?? ''}`];
    }
    // A platform compaction is derived from steps the summarizer reads itself, and may still
    // carry ones deleted since: the originals are what the summary is built from
    if (step.extra?.is_compaction === true) return [];
    if (step.source === 'user') return [`User: ${step.message ?? ''}`];
    return [
        ...(step.message ? [`Pipali: ${step.message}`] : []),
        ...(step.tool_calls ?? []).map(call => `Tool call: ${call.function_name} ${JSON.stringify(call.arguments)}`),
        ...(step.observation?.results ?? []).map(result => `Tool result: ${resultText(result.content)}`),
    ];
}

/** A run as the summarizer reads it, in full: a part per step, the first headed with the run's number and time */
export function renderRun(run: ATIFStep[], number: number): string[] {
    const steps = run.map(step => stepText(step).join('\n')).filter(Boolean);
    const header = `## Run ${number}, ${formatExactLocalDateTime(new Date(run[0]!.timestamp))}`;
    return steps.length ? [`${header}\n${steps[0]}`, ...steps.slice(1)] : [header];
}

/** Folds runs, given as parts, into the summary so far */
type Summarize = (previous: string, parts: string[]) => Promise<string | undefined>;

const withPrevious = (previous: string, parts: string[]) => [`<previous_summary>\n${previous}\n</previous_summary>`, ...parts];

/**
 * Summarize with the run's own model, in one request with each part a message of its own.
 * A platform model folds with the platform's fast model, where the run's history goes
 * anyway; any other model folds with itself.
 */
async function summarizerFor(user: typeof User.$inferSelect, chatModelId: number | undefined): Promise<Summarize> {
    const model = (chatModelId ? await getChatModelById(chatModelId) : undefined) ?? await getDefaultChatModel(user);
    if (model?.aiModelApi?.name === 'Pipali') {
        return async (previous, parts) =>
            (await sendMessageToFastModel(withPrevious(previous, parts), SUMMARIZER_PROMPT))?.message?.trim();
    }
    return async (previous, parts) => (await sendMessageToModel(withPrevious(previous, parts), undefined,
        SUMMARIZER_PROMPT, undefined, 'auto', false, false, user, model?.chatModel.id))?.message?.trim();
}

/** Checkpoints to keep: the latest that the next runs can start from, then later ones while there is room */
function retained(checkpoints: SummaryCheckpoint[], target: number): SummaryCheckpoint[] {
    const sorted = [...checkpoints].sort((a, b) => a.runs - b.runs);
    return [...sorted.filter(cp => cp.runs <= target).slice(-MAX_CHECKPOINTS), ...sorted.filter(cp => cp.runs > target)]
        .slice(0, MAX_CHECKPOINTS);
}

/**
 * The checkpoints once the runs left out by keeping `keep` are folded in, voided ones
 * dropped, or undefined when a valid checkpoint already covers them.
 */
export async function foldCheckpoints(
    runs: ATIFStep[][],
    stored: SummaryCheckpoint[],
    keep: number,
    summarize: Summarize,
): Promise<SummaryCheckpoint[] | undefined> {
    const target = runs.length - 1 - keep;
    const fingerprints = runsFingerprints(runs);
    const checkpoints = stored.filter(cp => fingerprints[cp.runs - 1] === cp.fingerprint);
    const start = latestValidCheckpoint(runs, checkpoints, target);
    if (target <= 0 || start?.runs === target) return undefined;

    const from = start?.runs ?? 0;
    const summary = await summarize(start?.text ?? '',
        runs.slice(from, target).flatMap((run, index) => renderRun(run, from + index + 1)));
    if (!summary) throw new Error('The summarizer returned no summary');

    const checkpoint = { text: summary, runs: target, fingerprint: fingerprints[target - 1]! };
    return retained([...checkpoints.filter(cp => cp.runs !== target), checkpoint], target);
}

/**
 * Fold a summarized routine conversation's runs with the run's own model, saving the
 * checkpoints to its `extra`, and return that extra as it now stands. A failed call
 * saves nothing; the run's notice then says which runs are not summarized yet.
 */
export async function foldRoutineHistory(args: {
    conversationId: string;
    steps: ATIFStep[];
    extra: Record<string, unknown> | undefined;
    keep: number;
    user: typeof User.$inferSelect;
    chatModelId?: number;
}): Promise<Record<string, unknown> | undefined> {
    const { conversationId, extra } = args;
    try {
        const summarize = await summarizerFor(args.user, args.chatModelId);
        const checkpoints = await foldCheckpoints(splitRoutineRuns(args.steps).runs, readSummaryCheckpoints(extra), args.keep, summarize);
        if (!checkpoints) return extra;

        const saved = { ...extra, [ROUTINE_SUMMARY_KEY]: { checkpoints } };
        await db.update(Conversation).set({ extra: saved }).where(eq(Conversation.id, conversationId));
        log.info({ conversationId, checkpoints: checkpoints.map(cp => cp.runs) }, 'Folded routine runs into its summary');
        return saved;
    } catch (error) {
        log.warn({ err: error, conversationId }, 'Could not fold routine runs into its summary');
        return extra;
    }
}
