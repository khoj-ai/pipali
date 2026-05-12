/**
 * Confirmation Response Handler
 *
 * Handles confirmation responses from the client.
 * Routes through the ConversationEventBus.
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, ConfirmationResponseCommand } from '../message-types';
import { getBus } from '../../../events/conversation-event-bus';
import { handleConfirmationResponse } from '../confirmation-manager';
import { createChildLogger } from '../../../logger';
import { confirmationResponseSchema } from '../../../processor/confirmation';

const log = createChildLogger({ component: 'confirmation-response' });

export const ConfirmationResponseHandler: Command<ConfirmationResponseCommand> = {
    matches(message: ClientMessage): message is ConfirmationResponseCommand {
        return message.type === 'confirmation_response';
    },

    async execute(ctx: CommandContext, message: ConfirmationResponseCommand): Promise<void> {
        const { conversationId, runId, data: rawResponse } = message;

        const parsed = confirmationResponseSchema.safeParse(rawResponse);
        if (!parsed.success) {
            log.warn({
                conversationId,
                runId,
                issues: parsed.error.issues,
            }, 'Confirmation response failed schema validation');
            ctx.sendError('Invalid confirmation response payload', conversationId);
            return;
        }
        const response = parsed.data;

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

        const resolvedIds = handleConfirmationResponse(runHandle, response);
        for (const requestId of resolvedIds) {
            bus.publish({
                type: 'confirmation_resolved',
                conversationId,
                runId: runHandle.runId,
                data: {
                    requestId,
                    selectedOptionId: response.selectedOptionId,
                    timestamp: response.timestamp,
                },
            });
        }
    },
};
