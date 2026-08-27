/**
 * Confirmation Response Handler
 *
 * Handles confirmation responses from the client.
 * Routes through the ConversationEventBus.
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, ConfirmationResponseCommand } from '../message-types';
import { getBus } from '../../../events/conversation-event-bus';
import { resolveConfirmationOnBus } from '../confirmation-manager';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'confirmation-response' });

export const ConfirmationResponseHandler: Command<ConfirmationResponseCommand> = {
    matches(message: ClientMessage): message is ConfirmationResponseCommand {
        return message.type === 'confirmation_response';
    },

    async execute(ctx: CommandContext, message: ConfirmationResponseCommand): Promise<void> {
        const { conversationId, runId, data: response } = message;

        const bus = getBus(conversationId);
        if (!bus?.activeRun) {
            log.warn({ conversationId }, 'Confirmation for unknown or inactive run');
            return;
        }

        const runHandle = bus.activeRun;

        if (runId && runHandle.runId !== runId) {
            log.warn({
                conversationId,
                expectedRunId: runId,
                actualRunId: runHandle.runId,
            }, 'Confirmation for wrong run');
            return;
        }

        resolveConfirmationOnBus(bus, runHandle, response);
    },
};
