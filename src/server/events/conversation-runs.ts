/**
 * Conversation Run Helpers
 *
 * Shared start/stop paths for conversation runs, so the WebSocket commands and the
 * agent's delegation tools reuse the same run tooling.
 */

import { eq } from 'drizzle-orm';
import { db, getChatModelById, getDefaultChatModel } from '../db';
import { Conversation, User } from '../db/schema';
import type { ChatModelWithApi } from '../db/schema';
import { atifConversationService } from '../processor/conversation/atif/atif.service';
import { createEmptyPreferences, type ConfirmationPreferences } from '../processor/confirmation';
import { rejectAllConfirmations } from '../routes/ws/confirmation-manager';
import type { QueuedMessage } from '../routes/ws/message-types';
import { setSessionInactive } from '../sessions/activeSessionsStore';
import {
    getBus,
    getOrCreateBus,
    type ConversationEvent,
    type ConversationEventBus,
} from './conversation-event-bus';
import { executeRun } from './run-executor';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'conversation-runs' });

/**
 * Resolve which chat model a run should use, persisting the choice on the conversation.
 *
 * An explicit `chatModelId` wins; otherwise the conversation's own model, then the user
 * default. The resolved model is backfilled onto the conversation row so later runs and
 * the model picker agree.
 */
export async function resolveChatModelForRun(
    user: typeof User.$inferSelect,
    conversationId?: string,
    chatModelId?: number,
): Promise<ChatModelWithApi | undefined> {
    if (chatModelId !== undefined) {
        const selected = await getChatModelById(chatModelId);
        if (!selected) return undefined;
        if (conversationId) {
            await db.update(Conversation).set({ chatModelId }).where(eq(Conversation.id, conversationId));
        }
        return selected;
    }

    let resolved: ChatModelWithApi | undefined;
    if (conversationId) {
        const [conversation] = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
        resolved = conversation?.chatModelId
            ? await getChatModelById(conversation.chatModelId) ?? await getDefaultChatModel(user)
            : await getDefaultChatModel(user);

        if (conversation && !conversation.chatModelId && resolved) {
            await db.update(Conversation)
                .set({ chatModelId: resolved.chatModel.id })
                .where(eq(Conversation.id, conversationId));
        }
    } else {
        resolved = await getDefaultChatModel(user);
    }
    return resolved;
}

/**
 * Queue a message onto a conversation's in-flight run as a soft interrupt.
 * Returns false when there is no active run, meaning the caller should start one.
 */
export function queueMessageOnActiveRun(conversationId: string, queued: QueuedMessage): boolean {
    const bus = getBus(conversationId);
    if (!bus?.activeRun) return false;

    const runHandle = bus.activeRun;
    runHandle.queuedMessages.push(queued);
    runHandle.stopMode = 'soft';
    runHandle.stopReason = 'soft_interrupt';

    // A run blocked on a confirmation can't reach the soft-interrupt checkpoint,
    // so unblock it hard and let the queued message start the next run.
    if (runHandle.pendingConfirmations.size > 0) {
        runHandle.stopMode = 'hard';
        runHandle.abortController.abort();
        rejectAllConfirmations(runHandle, 'Research interrupted');
    }

    return true;
}

export interface StartConversationRunOptions {
    user: typeof User.$inferSelect;
    /**
     * Omit to continue an existing conversation from what is already in its history —
     * used when waking a conversation after an update was appended to it.
     */
    message?: string;
    /** Omit to create a new conversation. */
    conversationId?: string;
    chatModelId?: number;
    /** Row-less platform alias used for this run without persisting a fake model row. */
    chatModelAlias?: string;
    /** Title for a newly created conversation. */
    title?: string;
    /** Marks a new conversation as delegated from this parent. */
    parentConversationId?: string;
    confirmationPreferences?: ConfirmationPreferences;
    /** Subscribed to the bus before the run starts, so no events are missed. */
    onEvent?: (event: ConversationEvent) => void;
}

export interface StartConversationRunResult {
    conversationId: string;
    runId: string;
    /** True when an in-flight run was soft-interrupted instead of a new run starting. */
    queued: boolean;
}

/**
 * Start a run on a conversation, creating it first when no id is given.
 *
 * If the target is already running, the message is queued as a soft interrupt and the
 * existing run chains into it — the same semantics as sending from the UI mid-run.
 */
export async function startConversationRun(
    options: StartConversationRunOptions,
): Promise<StartConversationRunResult> {
    const { user, message, title, parentConversationId, onEvent } = options;
    const runId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();

    let conversationId = options.conversationId;
    const chatModelWithApi = await resolveChatModelForRun(user, conversationId, options.chatModelId);

    if (!conversationId) {
        const created = await atifConversationService.createConversation(
            user,
            'pipali-agent',
            '1.0.0',
            chatModelWithApi?.chatModel.name ?? 'unknown',
            title,
            chatModelWithApi?.chatModel.id,
        );
        conversationId = created.id;

        if (parentConversationId) {
            await db.update(Conversation)
                .set({ parentConversationId })
                .where(eq(Conversation.id, conversationId));
        }
    }

    if (message && queueMessageOnActiveRun(conversationId, {
        runId,
        clientMessageId,
        message,
        chatModelId: chatModelWithApi?.chatModel.id,
        chatModelAlias: options.chatModelAlias,
    })) {
        log.info({ conversationId, runId }, 'Queued message on active run');
        return { conversationId, runId, queued: true };
    }

    const bus = getOrCreateBus(conversationId);
    bus.user = user;
    bus.confirmationPreferences = options.confirmationPreferences ?? createEmptyPreferences();
    bus.chatModelId = chatModelWithApi?.chatModel.id;

    if (onEvent) bus.subscribe(onEvent);

    // Fire and forget: the run outlives this call and reports through the bus.
    void executeRun({
        bus,
        conversationId,
        user,
        userMessage: message,
        runId,
        clientMessageId,
        confirmationPreferences: bus.confirmationPreferences,
        chatModelId: chatModelWithApi?.chatModel.id,
        chatModelAlias: options.chatModelAlias,
    }).catch(error => {
        log.error({ err: error, conversationId, runId }, 'Run failed');
    });

    return { conversationId, runId, queued: false };
}

/**
 * Hard stop a conversation's run: abort it, drop queued messages, reject confirmations.
 * Idempotent - the run executor calls the same teardown when it catches the abort.
 */
export function stopConversationRun(conversationId: string, reason: 'user_stop' = 'user_stop'): boolean {
    const bus: ConversationEventBus | undefined = getBus(conversationId);
    if (!bus?.activeRun) return false;

    const runHandle = bus.activeRun;
    runHandle.stopMode = 'hard';
    runHandle.stopReason = reason;
    runHandle.queuedMessages = [];
    runHandle.abortController.abort();
    rejectAllConfirmations(runHandle, 'Research stopped');

    // Mark inactive immediately so a refresh/observe sees no active run.
    setSessionInactive(conversationId);
    bus.activeRun = null;
    return true;
}

/**
 * Hard stop every delegated child of a conversation that is still running.
 *
 * Driven from the DB rather than run-scoped state so children spawned during an
 * earlier run are still reachable. Returns the ids actually stopped.
 */
export async function stopDelegatedChildren(parentConversationId: string): Promise<string[]> {
    const children = await db
        .select({ id: Conversation.id })
        .from(Conversation)
        .where(eq(Conversation.parentConversationId, parentConversationId));

    const stopped: string[] = [];
    for (const child of children) {
        if (stopConversationRun(child.id)) stopped.push(child.id);
    }
    return stopped;
}
