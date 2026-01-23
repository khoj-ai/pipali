/**
 * Stop Command Handler
 *
 * Handles hard stop requests from the client.
 * - Aborts the current run
 * - Clears the queue
 * - Rejects pending confirmations
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, StopCommand } from '../message-types';
import { applyTransition, getActiveRun } from '../session-state';
import { rejectAllConfirmations } from '../confirmation-manager';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'stop-command' });

export const StopCommandHandler: Command<StopCommand> = {
    matches(message: ClientMessage): message is StopCommand {
        return message.type === 'stop';
    },

    async execute(ctx: CommandContext, message: StopCommand): Promise<void> {
        const sessions = ctx.getSessions();
        const { conversationId, runId } = message;

        const session = sessions.get(conversationId);
        if (!session) {
            log.warn({ conversationId }, 'Stop for unknown session');
            return;
        }

        const activeRun = getActiveRun(session);
        if (!activeRun) {
            log.warn({ conversationId }, 'Stop with no active run');
            return;
        }

        // Optional: verify runId matches
        if (runId && activeRun.runId !== runId) {
            log.warn({
                conversationId,
                expectedRunId: runId,
                actualRunId: activeRun.runId,
            }, 'Stop for wrong run');
            return;
        }

        log.info({
            conversationId,
            runId: activeRun.runId,
        }, 'Hard stop requested');

        // Apply hard stop transition
        const updatedSession = applyTransition(session, { type: 'HARD_STOP', reason: 'user_stop', clearQueue: true });
        sessions.set(conversationId, updatedSession);

        const updatedRun = getActiveRun(updatedSession);
        if (updatedRun) {
            updatedRun.abortController.abort();
            rejectAllConfirmations(updatedRun, 'Research stopped');
        }

        // Note: run_stopped is emitted by the run executor when it observes the abort.
    },
};
