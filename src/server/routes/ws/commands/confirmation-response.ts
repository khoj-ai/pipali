/**
 * Confirmation Response Handler
 *
 * Handles confirmation responses from the client.
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, ConfirmationResponseCommand } from '../message-types';
import { getActiveRun } from '../session-state';
import { handleConfirmationResponse } from '../confirmation-manager';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'confirmation-response' });

export const ConfirmationResponseHandler: Command<ConfirmationResponseCommand> = {
    matches(message: ClientMessage): message is ConfirmationResponseCommand {
        return message.type === 'confirmation_response';
    },

    async execute(ctx: CommandContext, message: ConfirmationResponseCommand): Promise<void> {
        const sessions = ctx.getSessions();
        const { conversationId, runId, data: response } = message;

        const session = sessions.get(conversationId);
        if (!session) {
            log.warn({ conversationId }, 'Confirmation for unknown session');
            return;
        }

        const activeRun = getActiveRun(session);
        if (!activeRun) {
            log.warn({ conversationId }, 'Confirmation with no active run');
            return;
        }

        // Verify runId matches
        if (runId && activeRun.runId !== runId) {
            log.warn({
                conversationId,
                expectedRunId: runId,
                actualRunId: activeRun.runId,
            }, 'Confirmation for wrong run');
            return;
        }

        handleConfirmationResponse(activeRun, response);
    },
};
