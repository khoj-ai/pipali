/**
 * Observe Command Handler
 *
 * Subscribes a WS connection to a conversation's event bus.
 * Replays recent events for mid-run catch-up.
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, ObserveCommand } from '../message-types';
import type { ConversationEvent } from '../../../events/conversation-event-bus';
import { getOrCreateBus } from '../../../events/conversation-event-bus';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'observe-command' });

export const ObserveCommandHandler: Command<ObserveCommand> = {
    matches(message: ClientMessage): message is ObserveCommand {
        return message.type === 'observe';
    },

    async execute(ctx: CommandContext, message: ObserveCommand): Promise<void> {
        const { conversationId } = message;

        const bus = getOrCreateBus(conversationId);

        // Ensure replay events are delivered before any live events for this subscriber.
        let replayComplete = false;
        const bufferedLive: ConversationEvent[] = [];

        const { unsubscribe, replay } = bus.subscribeWithReplay(event => {
            if (!replayComplete) {
                bufferedLive.push(event);
                return;
            }
            ctx.send(event as unknown as Record<string, unknown>, conversationId);
        });

        // Track subscription for cleanup on disconnect
        ctx.addSubscription(conversationId, unsubscribe);

        // Tell the client there's an active run before replaying events
        const hasActiveRun = !!bus.activeRun;
        ctx.send({
            type: 'observe_status',
            conversationId,
            hasActiveRun,
            runId: bus.activeRun?.runId,
            clientMessageId: bus.activeRun?.clientMessageId,
            startedAt: bus.activeRun ? new Date(bus.activeRun.startedAt).toISOString() : undefined,
        }, conversationId);

        // Replay recent events for catch-up
        for (const event of replay) {
            ctx.send(event as unknown as Record<string, unknown>, conversationId);
        }

        replayComplete = true;
        for (const event of bufferedLive) {
            ctx.send(event as unknown as Record<string, unknown>, conversationId);
        }

        log.info({ conversationId, hasActiveRun, replayCount: replay.length }, 'Client observing conversation');
    },
};
