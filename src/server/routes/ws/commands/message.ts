/**
 * Message Command Handler
 *
 * Handles new messages from the client.
 * - If no active run: starts a new run
 * - If active run: queues as soft interrupt
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, MessageCommand, QueuedMessage } from '../message-types';
import {
    type Session,
    createSession,
    createRunningState,
    hasActiveRun,
    applyTransition,
    getActiveRun,
} from '../session-state';
import { createEmptyPreferences } from '../../../processor/confirmation';
import { db, getDefaultChatModel } from '../../../db';
import { Conversation } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { atifConversationService } from '../../../processor/conversation/atif/atif.service';
import { createChildLogger } from '../../../logger';
import { rejectAllConfirmations } from '../confirmation-manager';

const log = createChildLogger({ component: 'message-command' });

export const MessageCommandHandler: Command<MessageCommand> = {
    matches(message: ClientMessage): message is MessageCommand {
        return message.type === 'message';
    },

    async execute(ctx: CommandContext, message: MessageCommand): Promise<void> {
        const sessions = ctx.getSessions();
        const { message: userQuery, conversationId, clientMessageId, runId } = message;

        if (!userQuery) {
            log.warn('Received message without content');
            return;
        }

        log.info({
            query: userQuery.slice(0, 100),
            conversationId: conversationId || 'new',
            runId,
        }, 'New message received');

        // Check if there's an active session for this conversation
        const existingSession = conversationId ? sessions.get(conversationId) : null;

        if (existingSession && hasActiveRun(existingSession)) {
            const activeRun = getActiveRun(existingSession);
            if (!activeRun) return;

            // Soft interrupt: queue the message
            log.info({
                conversationId,
                runId,
            }, 'Soft interrupt: queuing message');

            const queuedMessage: QueuedMessage = {
                runId,
                clientMessageId,
                message: userQuery,
            };

            let updatedSession = applyTransition(existingSession, {
                type: 'SOFT_INTERRUPT',
                message: queuedMessage,
            });

            // If blocked waiting for confirmation, we cannot complete the current step.
            // Cancel like a hard stop, but keep the queued message and mark the stop as a soft interrupt.
            if (activeRun.pendingConfirmations.size > 0) {
                updatedSession = applyTransition(updatedSession, {
                    type: 'HARD_STOP',
                    reason: 'soft_interrupt',
                    clearQueue: false,
                });
                sessions.set(conversationId!, updatedSession);

                const updatedRun = getActiveRun(updatedSession);
                if (updatedRun) {
                    updatedRun.abortController.abort();
                    rejectAllConfirmations(updatedRun, 'Research interrupted');
                }
                return;
            }

            sessions.set(conversationId!, updatedSession);
            return;
        }

        // Get user
        const user = await ctx.getUser();
        if (!user) {
            ctx.sendError('User not found');
            return;
        }

        // Get model info for logging
        const chatModelWithApi = await getDefaultChatModel(user);
        if (chatModelWithApi) {
            log.info({
                model: chatModelWithApi.chatModel.name,
                provider: chatModelWithApi.aiModelApi?.name || 'Unknown',
            }, 'Using model');
        }

        // Get or create conversation
        let conversation;
        if (conversationId) {
            const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
            conversation = results[0];
        } else {
            const modelName = chatModelWithApi?.chatModel.name || 'unknown';
            conversation = await atifConversationService.createConversation(
                user,
                'pipali-agent',
                '1.0.0',
                modelName
            );
        }

        if (!conversation) {
            ctx.sendError('Failed to create or find conversation');
            return;
        }

        // Send conversation_created if new
        if (!conversationId) {
            ctx.send({ type: 'conversation_created' }, conversation.id);
        }

        // Create session with initial run state
        const session = createSession(
            conversation.id,
            user,
            createEmptyPreferences(),
            userQuery
        );

        // Start the run
        session.runState = createRunningState(runId, clientMessageId);
        sessions.set(conversation.id, session);

        // Note: Actual research execution and run_started emission is handled by the run executor.
    },
};
