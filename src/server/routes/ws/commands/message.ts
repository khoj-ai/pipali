/**
 * Message Command Handler
 *
 * Handles new messages from the client.
 * - If active run on bus: queues as soft interrupt on RunHandle
 * - Otherwise: creates session for the run executor to pick up
 */

import type { Command, CommandContext } from './index';
import type { ClientMessage, MessageCommand } from '../message-types';
import { createSession, createRunningState } from '../session-state';
import { createEmptyPreferences } from '../../../processor/confirmation';
import { db, getDefaultChatModel, getChatModelById } from '../../../db';
import { Conversation } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { atifConversationService } from '../../../processor/conversation/atif/atif.service';
import { getBus } from '../../../events/conversation-event-bus';
import { queueMessageOnActiveRun } from '../../../events/conversation-runs';
import { resumeAutoStart } from '../../../events/parent-inbox';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'message-command' });

export const MessageCommandHandler: Command<MessageCommand> = {
    matches(message: ClientMessage): message is MessageCommand {
        return message.type === 'message';
    },

    async execute(ctx: CommandContext, message: MessageCommand): Promise<void> {
        const sessions = ctx.getSessions();
        const { message: userQuery, conversationId, chatModelId, clientMessageId, runId } = message;

        if (!userQuery) {
            log.warn('Received message without content');
            return;
        }

        log.info({
            query: userQuery.slice(0, 100),
            conversationId: conversationId || 'new',
            runId,
        }, 'New message received');

        // The user is present again: unattended chains start over, and an earlier stop
        // no longer holds the conversation back.
        if (conversationId) resumeAutoStart(conversationId);

        // Check if there's an active run on the bus for this conversation
        if (conversationId && getBus(conversationId)?.activeRun) {
            log.info({ conversationId, runId }, 'Soft interrupt: queuing message on bus');

            if (chatModelId !== undefined) {
                const selectedModel = await getChatModelById(chatModelId);
                if (!selectedModel) {
                    ctx.sendError('Selected chat model not found', conversationId);
                    return;
                }
                await db.update(Conversation).set({ chatModelId }).where(eq(Conversation.id, conversationId));
            }

            queueMessageOnActiveRun(conversationId, { runId, clientMessageId, message: userQuery, chatModelId });
            return;
        }

        // No active run — start a new one
        const user = await ctx.getUser();
        if (!user) {
            ctx.sendError('User not found');
            return;
        }

        let conversation;
        let chatModelWithApi;

        if (conversationId) {
            const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
            conversation = results[0];

            if (chatModelId !== undefined) {
                chatModelWithApi = await getChatModelById(chatModelId);
                if (!chatModelWithApi) {
                    ctx.sendError('Selected chat model not found', conversationId);
                    return;
                }
                if (conversation) {
                    await db.update(Conversation).set({ chatModelId }).where(eq(Conversation.id, conversationId));
                    conversation.chatModelId = chatModelId;
                }
            } else if (conversation?.chatModelId) {
                chatModelWithApi = await getChatModelById(conversation.chatModelId) ?? await getDefaultChatModel(user);
            } else {
                chatModelWithApi = await getDefaultChatModel(user);
            }

            if (conversation && !conversation.chatModelId && chatModelWithApi) {
                await db.update(Conversation).set({ chatModelId: chatModelWithApi.chatModel.id }).where(eq(Conversation.id, conversationId));
                conversation.chatModelId = chatModelWithApi.chatModel.id;
            }
        } else {
            if (chatModelId !== undefined) {
                chatModelWithApi = await getChatModelById(chatModelId);
                if (!chatModelWithApi) {
                    ctx.sendError('Selected chat model not found');
                    return;
                }
            } else {
                chatModelWithApi = await getDefaultChatModel(user);
            }
            const modelName = chatModelWithApi?.chatModel.name || 'unknown';
            conversation = await atifConversationService.createConversation(
                user,
                'pipali-agent',
                '1.0.0',
                modelName,
                undefined,
                chatModelWithApi?.chatModel.id,
            );
        }

        if (chatModelWithApi) {
            log.info({
                model: chatModelWithApi.chatModel.name,
                provider: chatModelWithApi.aiModelApi?.name || 'Unknown',
            }, 'Using model');
        }

        if (!conversation) {
            ctx.sendError('Failed to create or find conversation');
            return;
        }

        if (!conversationId) {
            ctx.send({ type: 'conversation_created' }, conversation.id);
        }

        // Create session for the run executor to pick up
        const session = createSession(
            conversation.id,
            user,
            createEmptyPreferences(),
            userQuery,
            chatModelWithApi?.chatModel.id,
        );
        session.runState = createRunningState(runId, clientMessageId);
        sessions.set(conversation.id, session);
    },
};
