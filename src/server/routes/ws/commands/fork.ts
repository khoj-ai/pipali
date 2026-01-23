/**
 * Fork Command Handler
 *
 * Handles fork requests to create background tasks with chat history.
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, ForkCommand } from '../message-types';
import { createSession, createRunningState } from '../session-state';
import { createEmptyPreferences } from '../../../processor/confirmation';
import { atifConversationService } from '../../../processor/conversation/atif/atif.service';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'fork-command' });

export const ForkCommandHandler: Command<ForkCommand> = {
    matches(message: ClientMessage): message is ForkCommand {
        return message.type === 'fork';
    },

    async execute(ctx: CommandContext, message: ForkCommand): Promise<void> {
        const sessions = ctx.getSessions();
        const { message: userQuery, sourceConversationId, clientMessageId, runId } = message;

        if (!userQuery) {
            log.warn('Received fork request without message');
            return;
        }

        log.info({
            query: userQuery.slice(0, 100),
            sourceConversationId,
            runId,
        }, 'Fork request received');

        // Get user
        const user = await ctx.getUser();
        if (!user) {
            ctx.sendError('User not found');
            return;
        }

        // Fork the conversation
        const forkedConversation = await atifConversationService.forkConversation(
            sourceConversationId,
            user
        );

        // Send conversation_created with full history
        ctx.send({ type: 'conversation_created', history: forkedConversation.trajectory.steps }, forkedConversation.id);

        // Create session for this fork
        const session = createSession(
            forkedConversation.id,
            user,
            createEmptyPreferences(),
            userQuery
        );

        // Start the run
        session.runState = createRunningState(runId, clientMessageId);
        sessions.set(forkedConversation.id, session);

        // Note: Actual research execution is handled by the run executor
    },
};
