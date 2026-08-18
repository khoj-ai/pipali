/**
 * Parent Inbox
 *
 * Delivers the result of a long-running operation back into the conversation that
 * started it. Delegated conversations are the first consumer; a backgrounded command
 * tool would use the same entry point.
 *
 * Updates arrive as `system` steps. Those reach the model inline (see
 * generateChatmlMessagesWithContext) but are invisible to the conversation preview,
 * search, and the client's message list — so nothing needs to filter them out.
 */

import { atifConversationService } from '../processor/conversation/atif/atif.service';
import type { User } from '../db/schema';
import { getBus } from './conversation-event-bus';
import { startConversationRun } from './conversation-runs';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'parent-inbox' });

/**
 * Several tasks finishing together should wake the parent once, not once each.
 */
const COALESCE_MS = 1_000;

/**
 * `maxIterations` bounds a single run, not a chain of them: the parent could wake,
 * delegate, get a completion, wake again, forever. Depth is reset by any real user
 * message, so this only limits unattended chains.
 */
const MAX_AUTO_START_DEPTH = 3;

const autoStartDepth = new Map<string, number>();
const pendingWakeups = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Updates a run never read, in delivery order. They are moved back to the end of the
 * conversation before the wake runs, so the woken turn is answering them.
 */
const unreadUpdates = new Map<string, number[]>();
const suppressed = new Map<string, number>();
const stoppedByUser = new Set<string>();

/**
 * Called when the user hard stops a conversation. Stopping cascades to delegated tasks,
 * and each one reports back that it did not finish — which would otherwise wake the
 * conversation to narrate the stop the user just asked for.
 */
export function suspendAutoStart(conversationId: string): void {
    stoppedByUser.add(conversationId);
}

/** Called when the user sends a message, which makes the conversation attended again. */
export function resumeAutoStart(conversationId: string): void {
    autoStartDepth.delete(conversationId);
    stoppedByUser.delete(conversationId);
}

/**
 * Stop delivering updates to a conversation while its agent is explicitly waiting on
 * them. The waiting tool hands the results to the model itself, so appending them again
 * and waking the conversation afterwards would duplicate the work.
 *
 * Returns a release function; always call it in a finally.
 */
export function suppressDeliveries(conversationId: string): () => void {
    suppressed.set(conversationId, (suppressed.get(conversationId) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = (suppressed.get(conversationId) ?? 1) - 1;
        if (next <= 0) suppressed.delete(conversationId);
        else suppressed.set(conversationId, next);
    };
}

export interface DeliverToParentOptions {
    parentConversationId: string;
    user: typeof User.$inferSelect;
    /** Written verbatim as a system step, so make it self-contained. */
    message: string;
    /** Names the kind of operation reporting in, for anything reading steps back. */
    kind?: string;
}

/**
 * Append an update to a conversation and make sure the agent acts on it.
 *
 * If a run is in flight the update joins it; otherwise the conversation is woken so
 * the user hears about the result without having to ask.
 */
export async function deliverToParent(options: DeliverToParentOptions): Promise<void> {
    const { parentConversationId, user, message, kind = 'delegated_task_update' } = options;

    if (suppressed.has(parentConversationId)) {
        log.debug({ parentConversationId }, 'Delivery suppressed - the agent is waiting on this itself');
        return;
    }

    const step = await atifConversationService.addStep(
        parentConversationId,
        'system',
        message,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { kind },
    );

    const bus = getBus(parentConversationId);
    if (bus?.activeRun) {
        const run = bus.activeRun;
        run.injectedSteps.push(step);

        // The run picks the update up at its next iteration, but it may already be past
        // its last one, so wake the conversation once the run settles. A run that ended
        // in an error is left alone — re-running would just hit the same wall.
        const unsubscribe = bus.subscribe(event => {
            if (event.type === 'run_complete' || event.type === 'run_stopped') {
                unsubscribe();
                if (event.type === 'run_stopped' && event.reason === 'error') return;
                // Claimed here too: the first subscriber to fire takes what the run left,
                // so a second delivery's subscriber finds nothing to wake for.
                const unread = run.injectedSteps.splice(0);
                if (unread.length === 0) return;
                unreadUpdates.set(parentConversationId, [
                    ...(unreadUpdates.get(parentConversationId) ?? []),
                    ...unread.map(unreadStep => unreadStep.step_id),
                ]);
                scheduleWakeup(parentConversationId, user);
            } else if (event.type === 'billing_error' || event.type === 'auth_error') {
                unsubscribe();
            }
        });
        return;
    }

    scheduleWakeup(parentConversationId, user);
}

function scheduleWakeup(conversationId: string, user: typeof User.$inferSelect): void {
    if (pendingWakeups.has(conversationId)) return;

    const timer = setTimeout(() => {
        pendingWakeups.delete(conversationId);
        void wake(conversationId, user);
    }, COALESCE_MS);

    pendingWakeups.set(conversationId, timer);
}

async function wake(conversationId: string, user: typeof User.$inferSelect): Promise<void> {
    // Taken on every path, including the ones that start no turn: an update only has to
    // be last for a turn that resumes on it.
    const unread = unreadUpdates.get(conversationId) ?? [];
    unreadUpdates.delete(conversationId);

    if (getBus(conversationId)?.activeRun) {
        // Something started in the meantime; it will read the update from history.
        return;
    }

    if (stoppedByUser.has(conversationId)) {
        // The update stays in history for the user's next message; it just may not
        // start a turn on its own. Stop has to mean stop.
        log.info({ conversationId }, 'Not waking a conversation the user stopped');
        return;
    }

    const depth = (autoStartDepth.get(conversationId) ?? 0) + 1;
    if (depth > MAX_AUTO_START_DEPTH) {
        log.warn({ conversationId, depth }, 'Auto-start depth exceeded, waiting for the user');
        return;
    }
    autoStartDepth.set(conversationId, depth);

    // The run that was in flight buried the update under its own steps. The woken turn
    // has no user message of its own, so the update has to be the last thing said for
    // the turn to be answering it.
    try {
        const moved = await atifConversationService.moveStepsToEnd(conversationId, unread);
        if (moved.length > 0) log.debug({ conversationId, count: moved.length }, 'Moved unread updates to the end');
    } catch (error) {
        // The turn still runs: better a request the provider refuses out loud than an
        // update the conversation never mentions.
        log.warn({ err: error, conversationId }, 'Failed to move unread updates to the end');
    }

    try {
        // No user message: the run continues from the update already in history.
        await startConversationRun({ conversationId, user });
        log.info({ conversationId, depth }, 'Woke conversation after delegated update');
    } catch (error) {
        log.error({ err: error, conversationId }, 'Failed to wake conversation');
    }
}

/** For tests: drop pending timers and depth counters. */
export function clearInboxState(): void {
    for (const timer of pendingWakeups.values()) clearTimeout(timer);
    pendingWakeups.clear();
    autoStartDepth.clear();
    stoppedByUser.clear();
    unreadUpdates.clear();
}
