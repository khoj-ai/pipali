/**
 * Stop Command Handler
 *
 * Handles hard stop requests from the client.
 * Routes through the ConversationEventBus.
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, StopCommand } from '../message-types';
import { getBus } from '../../../events/conversation-event-bus';
import { stopConversationRun, stopDelegatedChildren } from '../../../events/conversation-runs';
import { stopBackgroundProcessesFor } from '../../../events/background-processes';
import { suspendAutoStart } from '../../../events/parent-inbox';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'stop-command' });

export const StopCommandHandler: Command<StopCommand> = {
    matches(message: ClientMessage): message is StopCommand {
        return message.type === 'stop';
    },

    async execute(ctx: CommandContext, message: StopCommand): Promise<void> {
        const { conversationId, runId } = message;

        const bus = getBus(conversationId);
        if (!bus?.activeRun) {
            log.warn({ conversationId }, 'Stop with no active run');
            return;
        }

        const runHandle = bus.activeRun;

        // Optional: verify runId matches
        if (runId && runHandle.runId !== runId) {
            log.warn({
                conversationId,
                expectedRunId: runId,
                actualRunId: runHandle.runId,
            }, 'Stop for wrong run');
            return;
        }

        log.info({
            conversationId,
            runId: runHandle.runId,
        }, 'Hard stop requested');

        // Before stopping: the cascade below makes each child report that it did not
        // finish, and an unattended conversation wakes to relay that.
        suspendAutoStart(conversationId);
        stopConversationRun(conversationId);

        // Stopping is the user's only handle on work Pipali started on its own, so it
        // reaches delegated children too. Soft interrupts and normal completion do not.
        const stoppedChildren = await stopDelegatedChildren(conversationId);
        if (stoppedChildren.length > 0) {
            log.info({ conversationId, stoppedChildren }, 'Stopped delegated children');
        }

        const stoppedProcesses = stopBackgroundProcessesFor(conversationId);
        if (stoppedProcesses.length > 0) {
            log.info({ conversationId, stoppedProcesses }, 'Stopped background commands');
        }
    },
};
