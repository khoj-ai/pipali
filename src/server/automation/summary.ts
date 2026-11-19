/**
 * The rolling summary of a summarized routine's older runs.
 *
 * Before a run, the runs it leaves out that no valid checkpoint covers yet are folded
 * in, oldest first, starting from the latest checkpoint that still matches the history,
 * or from the first run when none does. A fold is an ordinary model call given the
 * summary so far and the next runs in full; runs too long for one call are split across
 * several, so every original step reaches the summarizer. The call goes to the model the run
 * itself uses, so history sent to a user's own key is never sent to the platform.
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

const SUMMARY_MAX_CHARS = 6_000;
/** What one call is given of the runs it folds */
const FOLD_MAX_CHARS = 60_000;
/**
 * Fold calls a run starts after, each with up to one more to shorten its summary. The run
 * being folded when the limit is reached is finished, however many calls that takes, and
 * the rest of a longer backlog continues at the next run.
 */
const MAX_CALLS = 4;
/** Enough to go back as far as the largest recent-run count */
const MAX_CHECKPOINTS = MAX_ROUTINE_HISTORY_RUNS + 1;

const SUMMARIZER_PROMPT = `You keep the running summary of a routine's earlier runs. A routine is a task Pipali runs on a schedule or trigger, in one conversation the user can also reply in. Its next runs read this summary in place of the runs it covers.

You are given the summary so far, which may be empty, and the runs that follow it. A long run may arrive in parts over several requests. Write one summary covering everything given, in at most 600 words of plain text, with no preamble. Keep:
- Instructions, preferences and corrections the user gave, in their own words where short
- Findings, figures and decisions later runs may build on, with their dates
- What was already reported, so it is not reported again
- Work left unfinished or promised
Where runs disagree, the later run holds. Leave out what a later run cannot use, like greetings and how tools were called.`;

const SHORTEN_PROMPT = `You are given the running summary of a routine's earlier runs, which is over its length limit. Rewrite it in at most 500 words of plain text, with no preamble, keeping the user's instructions and corrections, the findings later runs may build on, what was already reported, and unfinished work.`;

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

/** A run as the summarizer reads it, in full */
export function renderRun(run: ATIFStep[], number: number): string {
    return [`## Run ${number}, ${formatExactLocalDateTime(new Date(run[0]!.timestamp))}`, ...run.flatMap(stepText)].join('\n');
}

/** Text cut into pieces that each fit a call, at a line end where one falls late enough, else mid-line */
function piecesOf(text: string, size: number): string[] {
    const pieces: string[] = [];
    let rest = text;
    while (rest.length > size) {
        const lineEnd = rest.lastIndexOf('\n', size);
        const cut = lineEnd > size / 2 ? lineEnd : size;
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(lineEnd > size / 2 ? cut + 1 : cut);
    }
    return [...pieces, rest];
}

export interface FoldCall {
    text: string;
    /** Set when the call ends a run: how many runs, from the first, the summary then covers */
    coversRuns?: number;
}

/**
 * The calls that fold runs `from` up to `to` (1-based, inclusive) into a summary, oldest
 * first: short runs share a call, and a long run is split across calls of its own in
 * labelled parts, so every run ends at the end of a call.
 */
export function planFolds(runs: ATIFStep[][], from: number, to: number): FoldCall[] {
    const calls: FoldCall[] = [];
    let current: FoldCall | undefined;
    for (let number = from; number <= to; number++) {
        const pieces = piecesOf(renderRun(runs[number - 1]!, number), FOLD_MAX_CHARS - 100);
        if (pieces.length > 1) current = undefined;
        pieces.forEach((piece, index) => {
            const text = pieces.length === 1 ? piece : `[Run ${number}, part ${index + 1} of ${pieces.length}]\n${piece}`;
            if (current && current.text.length + text.length + 2 > FOLD_MAX_CHARS) current = undefined;
            if (!current) calls.push(current = { text: '' });
            current.text = current.text ? `${current.text}\n\n${text}` : text;
            current.coversRuns = index === pieces.length - 1 ? number : undefined;
        });
        if (pieces.length > 1) current = undefined;
    }
    return calls;
}

type Summarize = (query: string, systemPrompt: string) => Promise<string | undefined>;

/**
 * Summarize with the run's own model. A platform model folds with the platform's fast
 * model, where the run's history goes anyway; any other model folds with itself.
 */
async function summarizerFor(user: typeof User.$inferSelect, chatModelId: number | undefined): Promise<Summarize> {
    const model = (chatModelId ? await getChatModelById(chatModelId) : undefined) ?? await getDefaultChatModel(user);
    if (model?.aiModelApi?.name === 'Pipali') {
        return async (query, systemPrompt) => (await sendMessageToFastModel(query, systemPrompt))?.message?.trim();
    }
    return async (query, systemPrompt) => (await sendMessageToModel(
        query, undefined, systemPrompt, undefined, 'auto', false, false, user, model?.chatModel.id,
    ))?.message?.trim();
}

/** A summary within its limit: shortened by one more call if over it, cut with a visible note if still over */
export async function boundSummary(text: string, summarize: Summarize): Promise<string> {
    if (text.length <= SUMMARY_MAX_CHARS) return text;
    const shorter = await summarize(`<summary>\n${text}\n</summary>`, SHORTEN_PROMPT) ?? text;
    return shorter.length <= SUMMARY_MAX_CHARS
        ? shorter
        : `${shorter.slice(0, SUMMARY_MAX_CHARS)}\n[The summary was over its ${SUMMARY_MAX_CHARS} character limit and is cut here.]`;
}

/** Checkpoints to keep: the latest that the next runs can start from, then later ones while there is room */
function retained(checkpoints: SummaryCheckpoint[], target: number): SummaryCheckpoint[] {
    const sorted = [...checkpoints].sort((a, b) => a.runs - b.runs);
    return [...sorted.filter(cp => cp.runs <= target).slice(-MAX_CHECKPOINTS), ...sorted.filter(cp => cp.runs > target)]
        .slice(0, MAX_CHECKPOINTS);
}

/**
 * Fold `runs` into checkpoints until they cover the runs a run keeping `keep` leaves
 * out, saving after each run folded, and return them. Voided checkpoints are dropped.
 * A failed call keeps what was folded so far; the run's notice says what is missing.
 */
export async function foldCheckpoints(
    runs: ATIFStep[][],
    stored: SummaryCheckpoint[],
    keep: number,
    summarize: Summarize,
    save: (checkpoints: SummaryCheckpoint[]) => Promise<unknown>,
): Promise<SummaryCheckpoint[]> {
    const target = runs.length - 1 - keep;
    const fingerprints = runsFingerprints(runs);
    let checkpoints = stored.filter(cp => fingerprints[cp.runs - 1] === cp.fingerprint);
    const start = latestValidCheckpoint(runs, checkpoints, target);
    if (target <= 0 || start?.runs === target) return checkpoints;

    try {
        let summary = start?.text ?? '';
        let made = 0;
        for (const call of planFolds(runs, (start?.runs ?? 0) + 1, target)) {
            const folded = await summarize(
                `<previous_summary>\n${summary}\n</previous_summary>\n\n<runs>\n${call.text}\n</runs>`, SUMMARIZER_PROMPT);
            if (!folded) throw new Error('The summarizer returned no summary');
            summary = await boundSummary(folded, summarize);
            made++;

            if (call.coversRuns) {
                const checkpoint = { text: summary, runs: call.coversRuns, fingerprint: fingerprints[call.coversRuns - 1]! };
                checkpoints = retained([...checkpoints.filter(cp => cp.runs !== checkpoint.runs), checkpoint], target);
                await save(checkpoints);
                if (made >= MAX_CALLS) break;
            }
        }
    } catch (error) {
        log.warn({ err: error }, 'Could not fold routine runs into its summary');
    }
    return checkpoints;
}

/**
 * Fold a summarized routine conversation's runs with the run's own model, saving the
 * checkpoints to its `extra`, and return that extra as saved: with every run folded, or
 * as far as a failed call let it get.
 */
export async function foldRoutineHistory(args: {
    conversationId: string;
    steps: ATIFStep[];
    extra: Record<string, unknown> | undefined;
    keep: number;
    user: typeof User.$inferSelect;
    chatModelId?: number;
}): Promise<Record<string, unknown> | undefined> {
    const { conversationId, user } = args;
    let extra = args.extra;
    try {
        const summarize = await summarizerFor(user, args.chatModelId);
        const { runs } = splitRoutineRuns(args.steps);
        await foldCheckpoints(runs, readSummaryCheckpoints(extra), args.keep, summarize, async checkpoints => {
            const saved = { ...extra, [ROUTINE_SUMMARY_KEY]: { checkpoints } };
            await db.update(Conversation).set({ extra: saved }).where(eq(Conversation.id, conversationId));
            extra = saved;
            log.info({ conversationId, runs: checkpoints.at(-1)?.runs }, 'Folded routine runs into its summary');
        });
    } catch (error) {
        log.warn({ err: error, conversationId }, 'Could not fold routine runs into its summary');
    }
    return extra;
}
