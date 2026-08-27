/**
 * Dream to consolidate memories
 *
 * A periodic pass dedicated to dedupe, arrange, discard and consolidate memories.
 * Reads what happened since the last dream pass and folds it back into the store.
 * Reconciles duplicate, stale or contradictory memories, adds new or enriches existing memories.
 * Ensures the store stays compact and organized, so relevant memories are easier to find.
 *
 * The dream phase consists of a hidden Skill, run as an Automation.
 * Users can manage, tune, view and pause it like any other routine.
 */

import path from 'path';
import { and, count, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { Automation, AutomationExecution, Conversation, User } from '../db/schema';
import { getSkillsDir } from '../paths';
import { deleteSkill, resetBuiltinSkill } from '../skills';
import { createChildLogger } from '../logger';
import { loadMemorySettings } from './settings';
import type { TriggerEventData } from '../automation/types';

const log = createChildLogger({ component: 'memory-dream' });

/** Name of the skill and its install directory */
const DREAM_SKILL = 'memory-dream';

/**
 * Both gates have to open: hours alone would consolidate a quiet week that has
 * nothing to consolidate, and conversations alone would fire mid-afternoon on a
 * heavy day and then again an hour later.
 */
const DREAM_MIN_HOURS = 12;
const DREAM_MIN_CONVERSATIONS = 5;

/** A dream that keeps failing should stop retrying rather than run all day */
const DREAM_MAX_PER_DAY = 2;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Executions that stand for a dream. A failed or cancelled one left its window
 * unreviewed, so the next pass still covers it.
 */
const DREAMT_STATUSES = ['pending', 'running', 'awaiting_confirmation', 'completed'] as const;

/**
 * The dream's automation row, addressed by an id derived from the user.
 *
 * Derived rather than stored, so no column to sync and no way to end up with
 * duplicate routines, even if the user has renamed the routine.
 *
 * The routine is recreated even if it was deleted; pausing it is what turns the dream off.
 */
export function dreamAutomationId(userId: number): string {
    const hash = Buffer.from(new Bun.CryptoHasher('sha1').update(`pipali-memory-dream:${userId}`).digest());
    hash[6] = (hash[6]! & 0x0f) | 0x50; // UUID version 5
    hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
    const hex = hash.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The window a dream would review, or undefined for nothing worth consolidating yet.
 *
 * Until a dream has run, the routine's own creation opens the window - so the first
 * one reviews the days since memory started, not all of history.
 *
 * The count is taken as a thunk because it costs a query and the time gate closes on
 * almost every call.
 */
export async function dreamWindow(
    routineCreatedAt: Date,
    lastDreamAt: Date | undefined,
    conversationsSince: (since: Date) => Promise<number>,
    now: Date = new Date(),
): Promise<Date | undefined> {
    const since = lastDreamAt ?? routineCreatedAt;
    if (now.getTime() - since.getTime() < DREAM_MIN_HOURS * HOUR_MS) {
        return undefined;
    }
    return (await conversationsSince(since)) >= DREAM_MIN_CONVERSATIONS ? since : undefined;
}

/**
 * Conversations the user held themselves since a cutoff.
 *
 * Routine and delegated conversations are left out: they are Pipali talking to
 * itself, and counting them would let a nightly routine alone open the gate.
 */
async function countConversationsSince(userId: number, since: Date): Promise<number> {
    const [row] = await db.select({ total: count() })
        .from(Conversation)
        .where(and(
            eq(Conversation.userId, userId),
            gt(Conversation.updatedAt, since),
            isNull(Conversation.automationId),
            isNull(Conversation.parentConversationId),
        ));
    return Number(row?.total ?? 0);
}

/**
 * When the last dream started, read from the execution log rather than
 * `Automation.lastExecutedAt` - the executor stamps that column once the run returns,
 * and a returning run is what calls back in here. The execution row is written when
 * the dream is queued, so it is already in place by then.
 *
 * A dream still in flight needs no separate check: it started recently, and a recent
 * start holds the time gate shut on its own.
 */
async function lastDreamStartedAt(automationId: string): Promise<Date | undefined> {
    const [row] = await db.select({ createdAt: AutomationExecution.createdAt })
        .from(AutomationExecution)
        .where(and(
            eq(AutomationExecution.automationId, automationId),
            inArray(AutomationExecution.status, [...DREAMT_STATUSES]),
        ))
        .orderBy(desc(AutomationExecution.createdAt))
        .limit(1);
    return row?.createdAt;
}

/** Where the dream skill is installed */
function dreamSkillPath(): string {
    return path.join(getSkillsDir(), DREAM_SKILL, 'SKILL.md');
}

/**
 * The recurring prompt stays one line: the procedure is several hundred lines and
 * belongs in the skill, where it loads only for this run.
 */
function dreamPrompt(): string {
    return `Consolidate your memories. Follow the procedure in ${dreamSkillPath()}.`;
}

/**
 * Put the procedure back if the skill is gone.
 *
 * It sits in the user's skills directory, where it can be deleted like any other, and
 * the prompt is only a pointer at it. Installing costs a stat call on the way into a
 * dream and saves a run that would otherwise open a file that is not there.
 *
 * This is the only thing that installs it: startup leaves it alone, so a user who has
 * memory off never has it on disk.
 */
async function ensureDreamSkill(): Promise<boolean> {
    if (await Bun.file(dreamSkillPath()).exists()) return true;

    log.info('Memory dream skill is missing, installing it');
    return (await resetBuiltinSkill(DREAM_SKILL)).success;
}

/**
 * The dream's routine, created on first use.
 *
 * Created lazily rather than at startup so a user who has never chatted is not
 * shown a routine for tidying memories they do not have yet.
 *
 * The routine is where the user says whether and how often to dream: paused or active,
 * renamed, rescheduled. The prompt is not theirs to hold - it is a pointer at the
 * skill, and the skill is where a dream is tuned - so it is rewritten to match this
 * release, which is what lets the pointer move.
 */
async function ensureDreamAutomation(userId: number): Promise<typeof Automation.$inferSelect | undefined> {
    const id = dreamAutomationId(userId);
    const load = async () => (await db.select().from(Automation).where(eq(Automation.id, id)))[0];

    const existing = await load();
    if (existing) {
        const prompt = dreamPrompt();
        if (existing.prompt === prompt) return existing;
        await db.update(Automation).set({ prompt }).where(eq(Automation.id, id));
        return { ...existing, prompt };
    }

    await db.insert(Automation)
        .values({
            id,
            userId,
            name: 'Memory Dream',
            description: 'Reviews recent chats and tidies the memory store. Pause it to stop automatic memory consolidation.',
            prompt: dreamPrompt(),
            status: 'active',
            maxExecutionsPerDay: DREAM_MAX_PER_DAY,
        })
        .onConflictDoNothing();

    log.info({ id }, 'Created the memory consolidation dream routine');
    return load();
}

/**
 * Consolidate memories if it is time to, called when a run settles.
 *
 * Never throws and never blocks the turn it was called from: a skipped dream costs
 * a day of tidying, and the store stays readable and writable either way.
 */
export async function maybeDream(user: typeof User.$inferSelect): Promise<void> {
    try {
        const { memoriesEnabled } = await loadMemorySettings(user.id);
        if (!memoriesEnabled) return;

        const automation = await ensureDreamAutomation(user.id);
        if (!automation || automation.status !== 'active') return;
        if (!(await ensureDreamSkill())) {
            log.warn('Could not restore the memory dream skill, skipping this one');
            return;
        }

        const since = await dreamWindow(
            automation.createdAt,
            await lastDreamStartedAt(automation.id),
            reviewFrom => countConversationsSince(user.id, reviewFrom),
        );
        if (!since) return;

        const triggerData: TriggerEventData = {
            type: 'external',
            timestamp: new Date().toISOString(),
            external: { source: 'script', metadata: { review_since: since.toISOString() } },
        };

        const { queueExecution } = await import('../automation/executor');
        const queued = await queueExecution(automation.id, triggerData);
        if (queued) {
            log.info({ since: since.toISOString(), executionId: queued.executionId }, 'Dreaming');
        }
    } catch (err) {
        log.warn({ err }, 'Could not start memory consolidation, skipping this one');
    }
}

/**
 * Take the dream off the machine, called when the user turns memory off.
 *
 * Both halves are derived - `maybeDream` recreates the routine and installs the skill
 * the next time it runs - so removing them costs nothing to restore and leaves no
 * active routine or runnable procedure behind for a feature the user has switched off.
 *
 * The routine's conversation is left in place: it is the record of what the dream did,
 * and that is the user's to read or delete.
 */
export async function stopDreaming(userId: number): Promise<void> {
    const id = dreamAutomationId(userId);
    try {
        // A dream in flight is consolidating memories the user has just switched off,
        // and a rescheduled one has a cron job outliving the row.
        const { deactivateAutomation } = await import('../automation');
        await deactivateAutomation(id);
        await db.delete(Automation).where(eq(Automation.id, id));
    } catch (err) {
        log.warn({ err }, 'Could not remove the memory dream routine');
    }
    await deleteSkill(DREAM_SKILL);
}
