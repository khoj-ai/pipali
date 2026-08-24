/**
 * useWebSocketChat Hook
 *
 * Encapsulates WebSocket connection and chat state management.
 * Uses a reducer pattern for predictable state updates.
 *
 * Run-based Protocol:
 * - Client sends: message, stop, fork, confirmation_response
 * - Server sends: conversation_created, run_started, run_stopped, run_complete,
 *                 step_start, step_end, confirmation_request, user_step_saved,
 *                 billing_error
 *
 * State Machine:
 * - idle: No active run
 * - running: Run in progress
 * - stopped: Run stopped
 */

import { useReducer, useRef, useCallback, useEffect } from 'react';
import type { Message, Thought, ConversationState, ConfirmationRequest, ConfirmationResponseAttachment, BillingError, AuthError } from '../types';
import { acquireWakeLock, releaseWakeLock } from '../utils/tauri';
import { formatToolCallsForSidebar, generateUUID, generateDeterministicId } from '../utils/formatting';
import { trimHistoryTailAfterUser, mergeHistoryWithLive } from '../utils/chat-messages';
import { useReadableTextStream } from './useReadableTextStream';

// ============================================================================
// Types
// ============================================================================

export type RunStatus = 'idle' | 'running' | 'stopped';
export type StopReason = 'user_stop' | 'soft_interrupt' | 'disconnect' | 'error';

export type ChatPendingConfirmation = { runId: string; request: ConfirmationRequest };

export interface ChatState {
    // Connection
    isConnected: boolean;

    // Current conversation
    conversationId: string | undefined;
    messages: Message[];
    runStatus: RunStatus;
    currentRunId: string | undefined;

    // Multi-conversation tracking
    conversationStates: Map<string, ConversationState>;

    // Confirmations
    pendingConfirmations: Map<string, ChatPendingConfirmation[]>;
}

export type ChatAction =
    | { type: 'CONNECTION_OPENED' }
    | { type: 'CONNECTION_CLOSED' }
    | { type: 'SET_CONVERSATION_ID'; id: string | undefined }
    | { type: 'SET_MESSAGES'; messages: Message[] }
    | { type: 'ADD_USER_MESSAGE'; message: Message; conversationId?: string }
    | { type: 'OPTIMISTIC_RUN_STARTED'; conversationId?: string; runId: string; clientMessageId: string }
    | { type: 'CONVERSATION_CREATED'; conversationId: string; history?: any[]; activate: boolean }
    | { type: 'RUN_STARTED'; conversationId: string; runId: string; clientMessageId: string; suggestedRunId?: string }
    | { type: 'RUN_STOPPED'; conversationId: string; runId: string; reason: StopReason; error?: string }
    | { type: 'RUN_COMPLETE'; conversationId: string; runId: string; response: string; stepId: number }
    | { type: 'TEXT_DELTA'; conversationId: string; runId: string; delta: string }
    | { type: 'STEP_START'; conversationId: string; runId: string; thought?: string; message?: string; toolCalls: any[] }
    | { type: 'STEP_END'; conversationId: string; runId: string; toolResults: any[]; stepId: number }
    | { type: 'CONFIRMATION_REQUEST'; conversationId: string; runId: string; request: ConfirmationRequest }
    | { type: 'CONFIRMATION_RESPONDED'; conversationId: string; requestId: string }
    | { type: 'DISMISS_CONFIRMATION'; conversationId: string; requestId: string }
    | { type: 'MESSAGE_DELETED'; conversationId: string; role: 'user' | 'assistant'; stepId: number }
    | { type: 'USER_STEP_SAVED'; conversationId: string; runId: string; clientMessageId: string; stepId: number; message?: string }
    | { type: 'BILLING_ERROR'; conversationId?: string; runId?: string; error: BillingError }
    | { type: 'AUTH_ERROR'; conversationId?: string; runId?: string; error: AuthError }
    | { type: 'COMPACTION'; conversationId: string; runId: string; summary: string }
    | { type: 'CLEAR_CONVERSATION' }
    | { type: 'SYNC_CONVERSATION_STATE'; conversationId: string; messages: Message[] }
    | { type: 'REMOVE_CONVERSATION_STATE'; conversationId: string }
    | { type: 'CLEAR_CONFIRMATIONS'; conversationId: string }
    | { type: 'CLEAR_COMPLETED'; conversationId: string }
    | { type: 'CLEAR_STOPPED'; conversationId: string }
    | { type: 'OBSERVE_ACTIVE_RUN'; conversationId: string; runId?: string; clientMessageId?: string }
    | { type: 'OBSERVE_IDLE'; conversationId: string }
    | { type: 'MERGE_HISTORY'; conversationId: string; historyMessages: Message[] };

export interface SendMessageOptions {
    clientMessageId?: string;
    runId?: string;
    optimistic?: boolean;
    chatModelId?: number;
}

export interface StopOptions {
    optimistic?: boolean;
    reason?: StopReason;
}

// ============================================================================
// Helpers
// ============================================================================

const CONVERSATION_STATE_STORAGE_KEY = 'pipali.conversationStates.v1';
const PENDING_CONFIRMATIONS_STORAGE_KEY = 'pipali.pendingConfirmations.v1';
const MAX_PERSISTED_CONVERSATIONS = 25;
const MAX_PERSISTED_MESSAGES_PER_CONVERSATION = 50;
const MAX_PERSISTED_CONFIRMATIONS_PER_CONVERSATION = 10;

type PersistedConversationState = {
    isProcessing: boolean;
    isStopped: boolean;
    isCompleted: boolean;
    latestReasoning?: string;
    messages: Message[];
};

type PersistedPayloadV1 = {
    v: 1;
    savedAt: number;
    entries: Array<[string, PersistedConversationState]>;
};

type PersistedPendingConfirmationsV1 = {
    v: 1;
    savedAt: number;
    entries: Array<[string, ChatPendingConfirmation[]]>;
};

function loadConversationStatesFromStorage(): Map<string, ConversationState> {
    if (typeof window === 'undefined') return new Map();
    try {
        const raw = window.localStorage.getItem(CONVERSATION_STATE_STORAGE_KEY);
        if (!raw) return new Map();

        const parsed = JSON.parse(raw) as PersistedPayloadV1;
        if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.entries)) return new Map();

        const conversationStates = new Map<string, ConversationState>();
        for (const entry of parsed.entries) {
            if (!Array.isArray(entry) || entry.length !== 2) continue;
            const [conversationId, state] = entry;
            if (typeof conversationId !== 'string' || !state) continue;
            if (!Array.isArray(state.messages)) continue;

            conversationStates.set(conversationId, {
                isProcessing: !!state.isProcessing,
                isStopped: !!state.isStopped,
                isCompleted: !!state.isCompleted,
                latestReasoning: typeof state.latestReasoning === 'string' ? state.latestReasoning : undefined,
                messages: state.messages,
            });
        }
        return conversationStates;
    } catch {
        return new Map();
    }
}

function loadPendingConfirmationsFromStorage(): Map<string, ChatPendingConfirmation[]> {
    if (typeof window === 'undefined') return new Map();
    try {
        const raw = window.localStorage.getItem(PENDING_CONFIRMATIONS_STORAGE_KEY);
        if (!raw) return new Map();

        const parsed = JSON.parse(raw) as PersistedPendingConfirmationsV1;
        if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.entries)) return new Map();

        const pending = new Map<string, ChatPendingConfirmation[]>();
        for (const entry of parsed.entries) {
            if (!Array.isArray(entry) || entry.length !== 2) continue;
            const [conversationId, queue] = entry;
            if (typeof conversationId !== 'string') continue;
            if (!Array.isArray(queue)) continue;

            const sanitized: ChatPendingConfirmation[] = [];
            for (const item of queue) {
                const runId = (item as any)?.runId;
                const request = (item as any)?.request;
                const requestId = request?.requestId;
                if (typeof runId !== 'string') continue;
                if (!request || typeof request !== 'object') continue;
                if (typeof requestId !== 'string') continue;
                sanitized.push({ runId, request });
                if (sanitized.length >= MAX_PERSISTED_CONFIRMATIONS_PER_CONVERSATION) break;
            }

            if (sanitized.length > 0) pending.set(conversationId, sanitized);
        }
        return pending;
    } catch {
        return new Map();
    }
}

function persistConversationStatesToStorage(conversationStates: Map<string, ConversationState>): void {
    if (typeof window === 'undefined') return;
    try {
        const entries: Array<[string, PersistedConversationState]> = [];
        for (const [conversationId, state] of conversationStates.entries()) {
            const shouldPersist = state.isProcessing || state.isStopped || state.isCompleted;
            if (!shouldPersist) continue;

            // Strip isQueued: a reload can't tell whether the server still has the message
            // queued. RUN_STARTED will reinstate the placeholder if/when the run begins.
            const persistedMessages = state.messages
                .slice(-MAX_PERSISTED_MESSAGES_PER_CONVERSATION)
                .map(m => (m.isQueued ? { ...m, isQueued: false } : m));

            entries.push([
                conversationId,
                {
                    isProcessing: state.isProcessing,
                    isStopped: state.isStopped,
                    isCompleted: state.isCompleted,
                    latestReasoning: state.latestReasoning,
                    messages: persistedMessages,
                },
            ]);
        }

        const trimmed = entries.slice(-MAX_PERSISTED_CONVERSATIONS);
        const payload: PersistedPayloadV1 = { v: 1, savedAt: Date.now(), entries: trimmed };
        window.localStorage.setItem(CONVERSATION_STATE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // ignore storage failures (quota/private mode)
    }
}

function persistPendingConfirmationsToStorage(pendingConfirmations: Map<string, ChatPendingConfirmation[]>): void {
    if (typeof window === 'undefined') return;
    try {
        const entries: Array<[string, ChatPendingConfirmation[]]> = [];

        for (const [conversationId, queue] of pendingConfirmations.entries()) {
            if (!Array.isArray(queue) || queue.length === 0) continue;
            entries.push([conversationId, queue.slice(-MAX_PERSISTED_CONFIRMATIONS_PER_CONVERSATION)]);
        }

        const trimmed = entries.slice(-MAX_PERSISTED_CONVERSATIONS);
        const payload: PersistedPendingConfirmationsV1 = { v: 1, savedAt: Date.now(), entries: trimmed };
        window.localStorage.setItem(PENDING_CONFIRMATIONS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // ignore storage failures
    }
}

function findRunAssistantIndex(messages: Message[], runId: string): number {
    return messages.findIndex(m => m.role === 'assistant' && m.stableId === runId);
}

function findStreamingRunId(messages: Message[]): string | undefined {
    // Streaming assistant placeholders use stableId=runId (UUID) and isStreaming=true.
    return messages.findLast(m => m.role === 'assistant' && m.isStreaming)?.stableId;
}

function stopAllStreamingAssistants(messages: Message[]): Message[] {
    let changed = false;
    const next = messages.map(m => {
        if (m.role !== 'assistant' || !m.isStreaming) return m;
        changed = true;
        return { ...m, isStreaming: false };
    });
    return changed ? next : messages;
}

function dropEmptyStreamingPlaceholders(messages: Message[], keepRunId?: string): Message[] {
    const next = messages.filter(m => {
        if (m.role !== 'assistant' || !m.isStreaming) return true;
        if (keepRunId && m.stableId === keepRunId) return true;
        const hasContent = (m.content ?? '').trim().length > 0;
        const hasThoughts = (m.thoughts?.length ?? 0) > 0;
        return hasContent || hasThoughts;
    });
    return next.length === messages.length ? messages : next;
}

function appendRunErrorMessage(messages: Message[], runId: string, error: string): Message[] {
    const messageId = `run-error-${runId}`;
    if (messages.some(m => m.stableId === messageId)) return messages;

    return [
        ...messages,
        {
            id: messageId,
            stableId: messageId,
            role: 'assistant' as const,
            content: '',
            runErrorInfo: { message: error },
        },
    ];
}

function dropEmptyAssistantForRun(messages: Message[], runId: string): Message[] {
    return messages.filter(m => {
        if (m.role !== 'assistant' || m.stableId !== runId) return true;
        const hasContent = (m.content ?? '').trim().length > 0;
        const hasThoughts = (m.thoughts?.length ?? 0) > 0;
        const hasSpecialContent = !!m.billingInfo || !!m.authInfo || !!m.runErrorInfo;
        return hasContent || hasThoughts || hasSpecialContent;
    });
}

function deleteTurnFromMessages(messages: Message[], stepId: number): Message[] {
    const idx = messages.findIndex(m => m.role === 'user' && m.id === String(stepId));
    if (idx === -1) return messages;

    let endIdx = idx;
    for (let i = idx + 1; i < messages.length; i++) {
        if (messages[i]?.role === 'assistant') {
            endIdx = i;
            break;
        }
    }
    return [...messages.slice(0, idx), ...messages.slice(endIdx + 1)];
}

function deleteAssistantMessageFromMessages(messages: Message[], stepId: number): Message[] {
    const stepIdStr = String(stepId);
    const next = messages.filter(m => !(m.role === 'assistant' && m.id === stepIdStr));
    return next.length === messages.length ? messages : next;
}

// ============================================================================
// Reducer
// ============================================================================

function chatReducer(state: ChatState, action: ChatAction): ChatState {
    switch (action.type) {
        case 'CONNECTION_OPENED':
            return { ...state, isConnected: true };

        case 'CONNECTION_CLOSED':
            return { ...state, isConnected: false };

        case 'SET_CONVERSATION_ID': {
            const id = action.id;
            if (!id) {
                return {
                    ...state,
                    conversationId: undefined,
                    messages: [],
                    runStatus: 'idle',
                    currentRunId: undefined,
                };
            }

            // Always switch the visible message list to the target conversation.
            // If we don't yet have cached state for it, show an empty list until history loads.
            const targetState = state.conversationStates.get(id);
            const targetMessages = targetState?.messages ?? [];

            const newRunStatus: RunStatus = targetState?.isStopped
                ? 'stopped'
                : targetState?.isProcessing
                    ? 'running'
                    : 'idle';

            const inferredRunId = targetState?.isProcessing ? findStreamingRunId(targetMessages) : undefined;

            const conversationStates = new Map(state.conversationStates);
            conversationStates.set(id, {
                isProcessing: targetState?.isProcessing ?? false,
                isStopped: targetState?.isStopped ?? false,
                isCompleted: targetState?.isCompleted ?? false,
                latestReasoning: targetState?.latestReasoning,
                messages: targetMessages,
            });

            return {
                ...state,
                conversationId: id,
                messages: targetMessages,
                runStatus: newRunStatus,
                currentRunId: inferredRunId,
                conversationStates,
            };
        }

        case 'SET_MESSAGES':
            return { ...state, messages: action.messages };

        case 'ADD_USER_MESSAGE':
            return (() => {
                const targetConversationId = action.conversationId ?? state.conversationId;
                const isCurrentConversation = !!targetConversationId && targetConversationId === state.conversationId;

                // Append to the current messages list if:
                // - this message is for the current conversation, or
                // - we're bootstrapping a new chat (no current conv AND no target conv specified)
                // Don't add if explicitly targeting a different conversation (e.g., background task)
                const isBootstrapping = state.conversationId === undefined && !action.conversationId;
                const nextMessages =
                    (isCurrentConversation || isBootstrapping)
                        ? [...state.messages, action.message]
                        : state.messages;

                // Also keep conversationStates in sync so RUN_STARTED doesn't read stale messages.
                if (!targetConversationId) {
                    return { ...state, messages: nextMessages };
                }

                const conversationStates = new Map(state.conversationStates);
                const existing = conversationStates.get(targetConversationId);

                const baseMessages =
                    isCurrentConversation
                        ? nextMessages
                        : (existing?.messages || []);

                conversationStates.set(targetConversationId, {
                    isProcessing: existing?.isProcessing ?? false,
                    isStopped: existing?.isStopped ?? false,
                    isCompleted: existing?.isCompleted ?? false,
                    latestReasoning: existing?.latestReasoning,
                    messages: isCurrentConversation ? baseMessages : [...baseMessages, action.message],
                });

                return {
                    ...state,
                    messages: nextMessages,
                    conversationStates,
                };
            })();

        case 'OPTIMISTIC_RUN_STARTED': {
            const { conversationId, runId, clientMessageId } = action;
            const targetConversationId = conversationId ?? state.conversationId;
            const isCurrentConversation = targetConversationId === state.conversationId || (state.conversationId === undefined && !conversationId);

            // Soft interrupt: a second streaming placeholder while one is already in flight
            // produces two competing 3-dot animations. Flag the user message as queued instead.
            const targetState = targetConversationId ? state.conversationStates.get(targetConversationId) : undefined;
            const isSoftInterrupt = isCurrentConversation
                ? state.runStatus === 'running'
                : !!targetState?.isProcessing;

            const markUserQueued = (msgs: Message[]): Message[] => {
                return msgs.map(m => {
                    if (m.role === 'user' && (m.id === clientMessageId || m.stableId === clientMessageId)) {
                        return { ...m, isQueued: true };
                    }
                    return m;
                });
            };

            const insertAssistant = (msgs: Message[]): Message[] => {
                if (findRunAssistantIndex(msgs, runId) !== -1) return msgs;
                const assistant: Message = {
                    id: runId,
                    stableId: runId,
                    role: 'assistant',
                    content: '',
                    isStreaming: true,
                    thoughts: [],
                };
                const userIndex = msgs.findIndex(m => m.role === 'user' && (m.id === clientMessageId || m.stableId === clientMessageId));
                return userIndex === -1
                    ? [...msgs, assistant]
                    : [...msgs.slice(0, userIndex + 1), assistant, ...msgs.slice(userIndex + 1)];
            };

            const transform = isSoftInterrupt ? markUserQueued : insertAssistant;
            const nextMessages = isCurrentConversation ? transform(state.messages) : state.messages;

            const conversationStates = new Map(state.conversationStates);
            if (targetConversationId) {
                const existing = conversationStates.get(targetConversationId);
                const baseMessages = existing?.messages || (isCurrentConversation ? nextMessages : []);
                conversationStates.set(targetConversationId, {
                    isProcessing: true,
                    isStopped: false,
                    isCompleted: false,
                    latestReasoning: existing?.latestReasoning,
                    messages: isCurrentConversation ? nextMessages : transform(baseMessages),
                });
            }

            // Only update currentRunId if we're not already running.
            // When already running, this is a soft interrupt - keep the original run's ID
            // so that stop commands target the correct active run on the server.
            const shouldUpdateCurrentRun = isCurrentConversation && state.runStatus !== 'running';

            return {
                ...state,
                runStatus: isCurrentConversation ? 'running' : state.runStatus,
                currentRunId: shouldUpdateCurrentRun ? runId : state.currentRunId,
                messages: nextMessages,
                conversationStates,
            };
        }

        case 'CONVERSATION_CREATED': {
            const { conversationId, history } = action;

            // Parse history if provided
            let messages: Message[] = [];
            if (history && Array.isArray(history)) {
                messages = history
                    // Filter out compaction steps (they're rendered as agent thoughts, not messages)
                    .filter(step =>
                        (step.source === 'user' || step.source === 'agent')
                        && !(step.extra?.is_compaction === true)
                    )
                    .map(step => ({
                        id: String(step.step_id || generateUUID()),
                        stableId: String(step.step_id || generateUUID()),
                        role: (step.source === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
                        content: step.message || '',
                    }))
                    .filter(m => m.content);
            }

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);

            const canAutoActivate = action.activate && (state.conversationId === undefined || state.conversationId === conversationId);

            const messagesForConversation =
                (canAutoActivate && state.conversationId === undefined && state.messages.length > 0)
                    ? state.messages
                    : (existing?.messages && existing.messages.length > 0)
                        ? existing.messages
                        : messages;

            conversationStates.set(conversationId, {
                isProcessing: canAutoActivate ? state.runStatus === 'running' : (existing?.isProcessing ?? false),
                isStopped: existing?.isStopped ?? false,
                isCompleted: existing?.isCompleted ?? false,
                latestReasoning: existing?.latestReasoning,
                messages: messagesForConversation,
            });

            return {
                ...state,
                conversationId: canAutoActivate ? conversationId : state.conversationId,
                messages: canAutoActivate ? messagesForConversation : state.messages,
                conversationStates,
            };
        }

        case 'RUN_STARTED': {
            const { conversationId, runId, clientMessageId, suggestedRunId } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            // Update conversation states
            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);

            // Deduplicate: global broadcast + per-conversation bus can both deliver
            // run_started for the same run. Skip if already processing this run.
            if (existing?.isProcessing && findRunAssistantIndex(existing.messages || [], runId) !== -1) {
                return state;
            }

            let messages = isCurrentConversation ? state.messages : (existing?.messages || []);

            // If history was loaded mid-run, we may have an extra history-derived assistant tail
            // (thoughts-only, no content). Trim it before we add/update the live run placeholder.
            messages = trimHistoryTailAfterUser(messages);

            // If server overrode the runId, re-key the optimistic streaming assistant placeholder.
            if (suggestedRunId && suggestedRunId !== runId) {
                const rekey = (msgs: Message[]): Message[] => {
                    let changed = false;
                    const next = msgs.map(m => {
                        if (m.role !== 'assistant') return m;
                        if (m.stableId !== suggestedRunId && m.id !== suggestedRunId) return m;
                        changed = true;
                        return { ...m, id: runId, stableId: runId };
                    });
                    return changed ? next : msgs;
                };
                messages = rekey(messages);
            }

            if (findRunAssistantIndex(messages, runId) === -1) {
                // If we have a synthetic history "assistant-with-only-thoughts" tail, drop it so
                // the live run placeholder + replayed events become the single source of truth.
                messages = trimHistoryTailAfterUser(messages);

                const assistant: Message = {
                    id: runId,
                    stableId: runId,
                    role: 'assistant',
                    content: '',
                    isStreaming: true,
                    thoughts: [],
                };

                const userIndex = messages.findIndex(m => m.role === 'user' && (m.id === clientMessageId || m.stableId === clientMessageId));
                if (userIndex === -1) {
                    messages = [...messages, assistant];
                } else {
                    // Clear any queued flag — the run for this user message has actually started.
                    const userMsg = messages[userIndex]!;
                    const clearedUser = userMsg.isQueued ? { ...userMsg, isQueued: false } : userMsg;
                    messages = [
                        ...messages.slice(0, userIndex),
                        clearedUser,
                        assistant,
                        ...messages.slice(userIndex + 1),
                    ];
                }
            }

            conversationStates.set(conversationId, {
                isProcessing: true,
                isStopped: false,
                isCompleted: false,
                latestReasoning: existing?.latestReasoning,
                messages: dropEmptyStreamingPlaceholders(messages, runId),
            });

            return {
                ...state,
                runStatus: isCurrentConversation ? 'running' : state.runStatus,
                currentRunId: isCurrentConversation ? runId : state.currentRunId,
                messages: isCurrentConversation ? dropEmptyStreamingPlaceholders(messages, runId) : state.messages,
                conversationStates,
            };
        }

        case 'RUN_STOPPED': {
            const { conversationId, runId, reason, error } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            // Mark pending tool calls as interrupted
            const markInterrupted = (msgs: Message[]): Message[] => {
                return msgs.map(msg => {
                    if (msg.role !== 'assistant' || !msg.thoughts) return msg;

                    const isTargetRun = runId ? msg.stableId === runId : msg.thoughts.some(t => t.type === 'tool_call' && t.isPending);
                    if (!isTargetRun) return msg;

                    if (msg.thoughts?.some(t => t.isPending)) {
                        const updatedThoughts = msg.thoughts!.map(thought => {
                            if (thought.type === 'tool_call' && thought.isPending) {
                                return { ...thought, isPending: false, toolResult: '[interrupted]' };
                            }
                            return thought;
                        });
                        return { ...msg, thoughts: updatedThoughts, isStreaming: false };
                    }
                    return { ...msg, isStreaming: false };
                });
            };

            const clearQueuedFlags = (msgs: Message[]): Message[] => {
                return msgs.map(m => (m.isQueued ? { ...m, isQueued: false } : m));
            };

            const finalizeStopped = (msgs: Message[]): Message[] => {
                // Clear isQueued for any reason: user_stop drops the queue, error/disconnect
                // leave it in an unknown state. RUN_STARTED will reinstate if the server picks up.
                const interrupted = clearQueuedFlags(markInterrupted(msgs));
                // For user_stop, drop orphaned optimistic placeholders from queued messages
                // that were cleared by the server. These are empty streaming assistants
                // that will never receive a run_started from the server.
                if (reason === 'user_stop') {
                    return dropEmptyStreamingPlaceholders(interrupted, runId);
                }
                // For disconnect/error, stop all streaming indicators
                if (!runId || reason === 'disconnect' || reason === 'error') {
                    return stopAllStreamingAssistants(interrupted);
                }
                return interrupted;
            };

            const finalizeRunError = (msgs: Message[]): Message[] => {
                if (reason !== 'error' || !error) return finalizeStopped(msgs);
                const finalized = dropEmptyAssistantForRun(finalizeStopped(msgs), runId);
                return appendRunErrorMessage(finalized, runId, error);
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    isProcessing: false,
                    // Only involuntary stops surface on home, and only if the user wasn't
                    // viewing it. User-initiated stop acks can arrive after the user has
                    // navigated home — exclude them outright to avoid a late re-surface.
                    isStopped: (reason === 'disconnect' || reason === 'error') && !isCurrentConversation,
                    isCompleted: false,
                    messages: finalizeRunError(existing.messages),
                });
            }

            const pendingConfirmations = new Map(state.pendingConfirmations);
            const existingConfirmations = pendingConfirmations.get(conversationId) || [];
            const remainingConfirmations = runId
                ? existingConfirmations.filter(c => c.runId !== runId)
                : [];
            if (remainingConfirmations.length > 0) pendingConfirmations.set(conversationId, remainingConfirmations);
            else pendingConfirmations.delete(conversationId);

            return {
                ...state,
                runStatus: isCurrentConversation ? 'stopped' : state.runStatus,
                currentRunId: isCurrentConversation ? undefined : state.currentRunId,
                messages: isCurrentConversation ? finalizeRunError(state.messages) : state.messages,
                conversationStates,
                pendingConfirmations,
            };
        }

        case 'RUN_COMPLETE': {
            const { conversationId, runId, response, stepId } = action;
            const isCurrentConversation = conversationId === state.conversationId;
            const messageId = String(stepId);

            const finalizeMessages = (msgs: Message[]): Message[] => {
                const filteredMsgs = msgs.filter(msg => !msg.billingInfo && !msg.authInfo);

                // Silent completion (e.g. research terminated by repeated warnings) —
                // no final assistant message to show, just clean up streaming state
                if (!response) {
                    return dropEmptyStreamingPlaceholders(stopAllStreamingAssistants(filteredMsgs), runId);
                }

                const idx = findRunAssistantIndex(filteredMsgs, runId);
                if (idx === -1) {
                    // Idempotency: observe replay or reconnects can deliver RUN_COMPLETE multiple times.
                    // If we've already finalized this assistant message (keyed by persisted stepId),
                    // update in place instead of appending a duplicate.
                    const alreadyFinalizedIdx = filteredMsgs.findIndex(m =>
                        m.role === 'assistant' && (m.id === messageId || m.stableId === messageId)
                    );
                    if (alreadyFinalizedIdx !== -1) {
                        const updated = filteredMsgs.map((msg, i) => {
                            if (i !== alreadyFinalizedIdx) return msg;
                            // Preserve stableId for the same reason as the main completion case:
                            // avoid remounting the assistant message UI on duplicate RUN_COMPLETE deliveries.
                            return { ...msg, id: messageId, content: response, isStreaming: false };
                        });
                        return dropEmptyStreamingPlaceholders(stopAllStreamingAssistants(updated), runId);
                    }

                    const next = [
                        ...filteredMsgs,
                        {
                            id: messageId,
                            // After completion, treat the persisted step_id as the stable identifier.
                            // This prevents "runId-based" assistant messages from sticking around and
                            // duplicating history when reloading or viewing from another tab.
                            stableId: messageId,
                            role: 'assistant' as const,
                            content: response,
                            isStreaming: false,
                        },
                    ];
                    return dropEmptyStreamingPlaceholders(stopAllStreamingAssistants(next), runId);
                }
                const updated = filteredMsgs.map((msg, i) => {
                    if (i !== idx) return msg;
                    // Preserve stableId to avoid remounting the message UI (e.g., ThoughtsSection expansion state)
                    // when the server provides the persisted stepId on completion.
                    return { ...msg, id: messageId, content: response, isStreaming: false };
                });
                return dropEmptyStreamingPlaceholders(stopAllStreamingAssistants(updated), runId);
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    isProcessing: false,
                    isStopped: false,
                    // If the user is viewing this conversation when it completes,
                    // they've already seen the result — skip the home-page card.
                    isCompleted: !isCurrentConversation,
                    messages: finalizeMessages(existing.messages),
                });
            }

            // Clear confirmations for completed conversation
            const pendingConfirmations = new Map(state.pendingConfirmations);
            pendingConfirmations.delete(conversationId);

            return {
                ...state,
                runStatus: isCurrentConversation ? 'idle' : state.runStatus,
                currentRunId: isCurrentConversation ? undefined : state.currentRunId,
                messages: isCurrentConversation ? finalizeMessages(state.messages) : state.messages,
                conversationStates,
                pendingConfirmations,
            };
        }

        case 'TEXT_DELTA': {
            const { conversationId, runId, delta } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            const updateMessagesWithDelta = (msgs: Message[]): Message[] => {
                const idx = findRunAssistantIndex(msgs, runId);
                if (idx === -1) return msgs;

                const assistant = msgs[idx];
                if (!assistant) return msgs;

                return msgs.map((msg, i) => {
                    if (i !== idx) return msg;
                    return { ...msg, content: (msg.content || '') + delta };
                });
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    messages: updateMessagesWithDelta(existing.messages),
                });
            }

            return {
                ...state,
                messages: isCurrentConversation ? updateMessagesWithDelta(state.messages) : state.messages,
                conversationStates,
            };
        }

        case 'STEP_START': {
            const { conversationId, runId, thought, message: reasoning, toolCalls } = action;
            const isCurrentConversation = conversationId === state.conversationId;
            const stepGroupId = toolCalls?.[0]?.tool_call_id || generateUUID();

            const newThoughts: Thought[] = [];

            // Add reasoning thought if present
            if (reasoning && toolCalls?.length > 0) {
                newThoughts.push({ id: generateDeterministicId('thought', reasoning), type: 'thought', content: reasoning, stepGroupId });
            } else if (thought) {
                newThoughts.push({ id: generateDeterministicId('thought', thought), type: 'thought', content: thought, isInternalThought: true, stepGroupId });
            }

            // Add pending tool calls
            for (const tc of toolCalls || []) {
                newThoughts.push({
                    id: tc.tool_call_id || generateUUID(),
                    type: 'tool_call',
                    content: '',
                    toolName: tc.function_name,
                    toolArgs: tc.arguments,
                    isPending: true,
                    stepGroupId,
                });
            }

            const updateMessagesWithThoughts = (msgs: Message[]): Message[] => {
                const idx = findRunAssistantIndex(msgs, runId);
                if (idx === -1) return msgs;
                const assistant = msgs[idx];
                if (!assistant) return msgs;

                // Dedupe thoughts and tool calls by stable ID to avoid duplicating
                // history-loaded steps when the server replays events after a reload.
                const existingThoughtIds = new Set((assistant.thoughts || []).map(t => t.id));
                const dedupedNewThoughts = newThoughts.filter(t => !existingThoughtIds.has(t.id));

                const shouldClearStreamedContent = !!reasoning && (toolCalls?.length ?? 0) > 0 && !!assistant.content;
                if (dedupedNewThoughts.length === 0 && !shouldClearStreamedContent) return msgs;

                return msgs.map((msg, i) => {
                    if (i !== idx) return msg;
                    return {
                        ...msg,
                        content: shouldClearStreamedContent ? '' : msg.content,
                        thoughts: [...(msg.thoughts || []), ...dedupedNewThoughts],
                    };
                });
            };

            // Determine reasoning for sidebar
            let latestReasoning: string | undefined;
            if (reasoning && toolCalls?.length > 0) {
                latestReasoning = reasoning;
            } else if (thought) {
                latestReasoning = thought;
            } else if (toolCalls?.length > 0) {
                latestReasoning = formatToolCallsForSidebar(toolCalls);
            }

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    latestReasoning: latestReasoning || existing.latestReasoning,
                    messages: updateMessagesWithThoughts(existing.messages),
                });
            }

            return {
                ...state,
                messages: isCurrentConversation ? updateMessagesWithThoughts(state.messages) : state.messages,
                conversationStates,
            };
        }

        case 'STEP_END': {
            const { conversationId, runId, toolResults } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            const updateMessagesWithResults = (msgs: Message[]): Message[] => {
                const idx = findRunAssistantIndex(msgs, runId);
                if (idx === -1) return msgs;

                const assistant = msgs[idx];
                if (!assistant) return msgs;
                const updatedThoughts = (assistant.thoughts || []).map(thought => {
                    if (thought.type === 'tool_call' && thought.isPending) {
                        const result = toolResults.find((tr: any) => tr.source_call_id === thought.id)?.content;
                        if (result !== undefined) {
                            const resultStr = typeof result !== 'string' ? JSON.stringify(result) : result;
                            return { ...thought, toolResult: resultStr, isPending: false };
                        }
                    }
                    return thought;
                });

                return msgs.map((msg, i) => (i === idx ? { ...msg, thoughts: updatedThoughts } : msg));
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    messages: updateMessagesWithResults(existing.messages),
                });
            }

            return {
                ...state,
                messages: isCurrentConversation ? updateMessagesWithResults(state.messages) : state.messages,
                conversationStates,
            };
        }

        case 'COMPACTION': {
            const { conversationId, runId, summary } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            // Add compaction as an internal thought to the current assistant message
            const content = `**Compact Context.**\n${summary}`;
            const compactionThought: Thought = {
                id: generateDeterministicId('compaction', content),
                type: 'thought',
                content: content,
                isInternalThought: true,
            };

            const updateMessagesWithCompaction = (msgs: Message[]): Message[] => {
                const idx = findRunAssistantIndex(msgs, runId);
                if (idx === -1) return msgs;
                return msgs.map((msg, i) => {
                    if (i !== idx) return msg;
                    // Dedupe compaction summary by stable ID
                    const existingThoughtIds = new Set((msg.thoughts || []).map(t => t.id));
                    if (existingThoughtIds.has(compactionThought.id)) return msg;
                    return { ...msg, thoughts: [...(msg.thoughts || []), compactionThought] };
                });
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    messages: updateMessagesWithCompaction(existing.messages),
                });
            }

            return {
                ...state,
                messages: isCurrentConversation ? updateMessagesWithCompaction(state.messages) : state.messages,
                conversationStates,
            };
        }

        case 'CONFIRMATION_REQUEST': {
            const { conversationId, request, runId } = action;

            const pendingConfirmations = new Map(state.pendingConfirmations);
            const existing = pendingConfirmations.get(conversationId) || [];
            if (!existing.some(c => c.request.requestId === request.requestId)) {
                pendingConfirmations.set(conversationId, [...existing, { runId, request }]);
            }

            return { ...state, pendingConfirmations };
        }

        case 'CONFIRMATION_RESPONDED': {
            const { conversationId, requestId } = action;

            const pendingConfirmations = new Map(state.pendingConfirmations);
            const existingQueue = pendingConfirmations.get(conversationId) || [];
            const remainingQueue = existingQueue.filter(c => c.request.requestId !== requestId);
            if (remainingQueue.length > 0) {
                pendingConfirmations.set(conversationId, remainingQueue);
            } else {
                pendingConfirmations.delete(conversationId);
            }

            return { ...state, pendingConfirmations };
        }

        case 'DISMISS_CONFIRMATION': {
            const { conversationId, requestId } = action;

            const pendingConfirmations = new Map(state.pendingConfirmations);
            const existingQueue = pendingConfirmations.get(conversationId) || [];
            const remainingQueue = existingQueue.filter(c => c.request.requestId !== requestId);
            if (remainingQueue.length > 0) {
                pendingConfirmations.set(conversationId, remainingQueue);
            } else {
                pendingConfirmations.delete(conversationId);
            }

            return { ...state, pendingConfirmations };
        }

        case 'USER_STEP_SAVED': {
            const { conversationId, clientMessageId, stepId } = action;
            const isCurrentConversation = conversationId === state.conversationId;
            const stepIdStr = String(stepId);

            const updateOrCreateUserMessage = (msgs: Message[]): Message[] => {
                // If we already have the persisted user step in history, don't duplicate it.
                const alreadyHasPersisted = msgs.some(msg => msg.role === 'user' && (msg.id === stepIdStr || msg.stableId === stepIdStr));
                if (alreadyHasPersisted) {
                    if (!action.message) return msgs;
                    const messageText = action.message;
                    return msgs.map(msg => {
                        if (msg.role !== 'user') return msg;
                        if (msg.id !== stepIdStr && msg.stableId !== stepIdStr) return msg;
                        if (msg.content) return msg;
                        return { ...msg, content: messageText };
                    });
                }

                const found = msgs.some(msg => msg.role === 'user' && msg.id === clientMessageId);
                if (found) {
                    // Optimistic message exists — remap its ID to the persisted stepId
                    return msgs.map(msg => {
                        if (msg.role === 'user' && msg.id === clientMessageId) {
                            return { ...msg, id: stepIdStr };
                        }
                        return msg;
                    });
                }
                // Observer that missed the optimistic ADD_USER_MESSAGE — create it from the event
                if (action.message) {
                    const userMessage: Message = {
                        id: stepIdStr,
                        // Use clientMessageId as a stable React key so that RUN_STARTED can
                        // place the streaming assistant right after this message (observer case).
                        stableId: clientMessageId,
                        role: 'user' as const,
                        content: action.message,
                    };

                    // Insert before the run's assistant placeholder (if present) to preserve turn order.
                    const assistantIdx = findRunAssistantIndex(msgs, action.runId);
                    if (assistantIdx === -1) return [...msgs, userMessage];
                    return [...msgs.slice(0, assistantIdx), userMessage, ...msgs.slice(assistantIdx)];
                }
                return msgs;
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    messages: updateOrCreateUserMessage(existing.messages),
                });
            }

            return {
                ...state,
                messages: isCurrentConversation ? updateOrCreateUserMessage(state.messages) : state.messages,
                conversationStates,
            };
        }

        case 'BILLING_ERROR':
        case 'AUTH_ERROR': {
            const { conversationId } = action;
            const isCurrentConversation = !conversationId || conversationId === state.conversationId;

            if (conversationId) {
                const conversationStates = new Map(state.conversationStates);
                const existing = conversationStates.get(conversationId);
                if (existing) {
                    conversationStates.set(conversationId, {
                        ...existing,
                        isProcessing: false,
                    });
                }
                return {
                    ...state,
                    runStatus: isCurrentConversation ? 'idle' : state.runStatus,
                    currentRunId: isCurrentConversation ? undefined : state.currentRunId,
                    conversationStates,
                };
            }

            return {
                ...state,
                runStatus: isCurrentConversation ? 'idle' : state.runStatus,
                currentRunId: isCurrentConversation ? undefined : state.currentRunId,
            };
        }

        case 'CLEAR_CONVERSATION':
            return {
                ...state,
                conversationId: undefined,
                messages: [],
                runStatus: 'idle',
                currentRunId: undefined,
            };

        case 'SYNC_CONVERSATION_STATE': {
            const { conversationId, messages } = action;
            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            conversationStates.set(conversationId, {
                isProcessing: existing?.isProcessing ?? false,
                isStopped: existing?.isStopped ?? false,
                isCompleted: existing?.isCompleted ?? false,
                latestReasoning: existing?.latestReasoning,
                messages,
            });
            return { ...state, conversationStates };
        }

        case 'REMOVE_CONVERSATION_STATE': {
            const conversationStates = new Map(state.conversationStates);
            conversationStates.delete(action.conversationId);
            const pendingConfirmations = new Map(state.pendingConfirmations);
            pendingConfirmations.delete(action.conversationId);
            return { ...state, conversationStates, pendingConfirmations };
        }

        case 'CLEAR_COMPLETED': {
            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(action.conversationId);
            if (existing?.isCompleted) {
                conversationStates.set(action.conversationId, { ...existing, isCompleted: false });
            }
            return { ...state, conversationStates };
        }

        case 'CLEAR_STOPPED': {
            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(action.conversationId);
            if (existing?.isStopped) {
                conversationStates.set(action.conversationId, { ...existing, isStopped: false });
            }
            return { ...state, conversationStates };
        }

        case 'CLEAR_CONFIRMATIONS': {
            const pendingConfirmations = new Map(state.pendingConfirmations);
            pendingConfirmations.delete(action.conversationId);
            return { ...state, pendingConfirmations };
        }

        case 'MERGE_HISTORY': {
            // Merge server-persisted history with the current reducer state.
            // This runs INSIDE the reducer so it always sees the latest state.messages,
            // avoiding the stale-ref race where messagesRef.current lags behind
            // because it's only updated in a useEffect (after render).
            const { conversationId, historyMessages } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            const currentMessages = isCurrentConversation
                ? state.messages
                : (state.conversationStates.get(conversationId)?.messages ?? []);

            const hasActiveRunPlaceholder = currentMessages.some(m =>
                m.role === 'assistant' && m.isStreaming
            );

            let mergedMessages: Message[];
            if (hasActiveRunPlaceholder) {
                // A streaming placeholder exists. Check if history already has the
                // completed run — this happens when localStorage has a stale streaming
                // placeholder but the server finalized the run before this fetch returned.
                const lastHistory = historyMessages[historyMessages.length - 1];
                const historyRunComplete = lastHistory?.role === 'assistant'
                    && !!lastHistory.content
                    && !lastHistory.isStreaming;

                if (historyRunComplete) {
                    mergedMessages = historyMessages;
                } else {
                    // Genuine active run — strip history assistants after the last user
                    // to avoid duplicates (history may capture the completed run in the
                    // narrow window between DB persistence and bus cleanup).
                    const lastUserIdx = historyMessages.findLastIndex(m => m.role === 'user');
                    const prunedHistory = lastUserIdx === -1 ? [] : historyMessages.slice(0, lastUserIdx + 1);
                    mergedMessages = mergeHistoryWithLive(prunedHistory, currentMessages);
                }
            } else {
                // When there's no active run, check if WebSocket events delivered
                // a more complete message set than the (potentially stale) HTTP response.
                const countThoughts = (msgs: Message[]) =>
                    msgs.reduce((n, m) => n + (m.thoughts?.length ?? 0), 0);
                mergedMessages = countThoughts(currentMessages) > countThoughts(historyMessages)
                    ? currentMessages
                    : historyMessages;
            }

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            conversationStates.set(conversationId, {
                isProcessing: existing?.isProcessing ?? false,
                isStopped: existing?.isStopped ?? false,
                isCompleted: existing?.isCompleted ?? false,
                latestReasoning: existing?.latestReasoning,
                messages: mergedMessages,
            });

            return {
                ...state,
                messages: isCurrentConversation ? mergedMessages : state.messages,
                conversationStates,
            };
        }

        case 'OBSERVE_ACTIVE_RUN': {
            const { conversationId, runId, clientMessageId } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);

            const baseMessages = trimHistoryTailAfterUser(existing?.messages || (isCurrentConversation ? state.messages : []));

            // Insert a streaming assistant placeholder if we have a runId and none exists yet
            let updatedMessages = baseMessages;
            const needsPlaceholder = !!runId && findRunAssistantIndex(baseMessages, runId) === -1;
            if (needsPlaceholder && runId) {
                const assistant: Message = {
                    id: runId,
                    stableId: runId,
                    role: 'assistant',
                    content: '',
                    isStreaming: true,
                    thoughts: [],
                };
                if (clientMessageId) {
                    const userIndex = baseMessages.findIndex(m => m.role === 'user' && (m.id === clientMessageId || m.stableId === clientMessageId));
                    updatedMessages = userIndex === -1
                        ? [...baseMessages, assistant]
                        : [...baseMessages.slice(0, userIndex + 1), assistant, ...baseMessages.slice(userIndex + 1)];
                } else {
                    updatedMessages = [...baseMessages, assistant];
                }
            }

            const prevMessages = existing?.messages || (isCurrentConversation ? state.messages : []);
            const didChangeMessages = updatedMessages !== prevMessages;

            // Ensure conversation state reflects the active run.
            // The replay events (run_started, step_start, etc.) will fill in messages.
            if (!existing || !existing.isProcessing || didChangeMessages) {
                conversationStates.set(conversationId, {
                    isProcessing: true,
                    isStopped: false,
                    isCompleted: false,
                    latestReasoning: existing?.latestReasoning,
                    messages: updatedMessages,
                });

                return {
                    ...state,
                    runStatus: isCurrentConversation ? 'running' : state.runStatus,
                    currentRunId: isCurrentConversation && runId ? runId : state.currentRunId,
                    messages: isCurrentConversation ? updatedMessages : state.messages,
                    conversationStates,
                };
            }

            return state;
        }

        case 'OBSERVE_IDLE': {
            // Server reported no active run — clear stale isProcessing from localStorage.
            const { conversationId } = action;
            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (!existing?.isProcessing) return state;

            const messages = existing.messages.some(m => m.isStreaming)
                ? existing.messages.map(m => m.isStreaming ? { ...m, isStreaming: false } : m)
                : existing.messages;

            conversationStates.set(conversationId, {
                ...existing,
                isProcessing: false,
                messages,
            });

            const isCurrentConversation = conversationId === state.conversationId;
            return {
                ...state,
                messages: isCurrentConversation ? messages : state.messages,
                runStatus: isCurrentConversation ? 'idle' : state.runStatus,
                currentRunId: isCurrentConversation ? undefined : state.currentRunId,
                conversationStates,
            };
        }

        case 'MESSAGE_DELETED': {
            const { conversationId, role, stepId } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            const applyDeletion = (msgs: Message[]): Message[] => {
                if (role === 'assistant') return deleteAssistantMessageFromMessages(msgs, stepId);
                return deleteTurnFromMessages(msgs, stepId);
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    messages: applyDeletion(existing.messages),
                });
            }

            return {
                ...state,
                messages: isCurrentConversation ? applyDeletion(state.messages) : state.messages,
                conversationStates,
            };
        }

        default:
            return state;
    }
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: ChatState = {
    isConnected: false,
    conversationId: undefined,
    messages: [],
    runStatus: 'idle',
    currentRunId: undefined,
    conversationStates: new Map(),
    pendingConfirmations: new Map(),
};

interface ConfirmationResponseParams {
    conversationId: string;
    runId: string;
    requestId: string;
    optionId: string;
    guidance?: string;
    attachments?: ConfirmationResponseAttachment[];
}

function tryQueueConfirmationResponse(
    socket: WebSocket | null,
    params: ConfirmationResponseParams,
    onQueued: () => void,
): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
        socket.send(JSON.stringify({
            type: 'confirmation_response',
            conversationId: params.conversationId,
            runId: params.runId,
            data: {
                requestId: params.requestId,
                selectedOptionId: params.optionId,
                guidance: params.guidance,
                ...(params.attachments?.length ? { attachments: params.attachments } : {}),
                timestamp: new Date().toISOString(),
            },
        }));
    } catch {
        return false;
    }
    onQueued();
    return true;
}

// ============================================================================
// Hook
// ============================================================================

export interface UseWebSocketChatOptions {
    wsUrl: string;
    onConversationCreated?: (conversationId: string, history?: any[]) => void;
    onConfirmationRequest?: (request: ConfirmationRequest, conversationId: string, runId: string) => void;
    onConfirmationResolved?: (requestId: string, conversationId: string) => void;
    /** Fires for every run, including ones this client never started. */
    onRunStarted?: (conversationId: string, runId: string) => void;
    onTaskComplete?: (request: string | undefined, response: string, conversationId: string) => void;
    onStepStart?: (conversationId: string, runId: string) => void;
    onBillingError?: (error: BillingError, conversationId?: string) => void;
    onAuthError?: (error: AuthError, conversationId?: string) => void;
    onError?: (error: string, conversationId?: string) => void;
    shouldActivateConversationOnCreate?: (conversationId: string, history?: any[]) => boolean;
}

export function useWebSocketChat(options: UseWebSocketChatOptions) {
    const {
        wsUrl,
        onConversationCreated,
        onConfirmationRequest,
        onConfirmationResolved,
        onRunStarted,
        onTaskComplete,
        onStepStart,
        onBillingError,
        onAuthError,
        onError,
        shouldActivateConversationOnCreate,
    } = options;

    const [state, dispatch] = useReducer(
        chatReducer,
        initialState,
        (init) => ({
            ...init,
            conversationStates: loadConversationStatesFromStorage(),
            pendingConfirmations: loadPendingConfirmationsFromStorage(),
        }),
    );
    const wsRef = useRef<WebSocket | null>(null);
    const observedConversationsRef = useRef<Set<string>>(new Set());
    const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const dispatchTextDelta = useCallback((args: { conversationId: string; runId: string; delta: string }) => {
        dispatch({ type: 'TEXT_DELTA', ...args });
    }, []);
    const { enqueueDelta, flushRun, clearRun } = useReadableTextStream(dispatchTextDelta);

    const callbacksRef = useRef<Pick<
        UseWebSocketChatOptions,
        | 'onConversationCreated'
        | 'onConfirmationRequest'
        | 'onConfirmationResolved'
        | 'onRunStarted'
        | 'onTaskComplete'
        | 'onStepStart'
        | 'onBillingError'
        | 'onAuthError'
        | 'onError'
        | 'shouldActivateConversationOnCreate'
    >>({
        onConversationCreated,
        onConfirmationRequest,
        onConfirmationResolved,
        onRunStarted,
        onTaskComplete,
        onStepStart,
        onBillingError,
        onAuthError,
        onError,
        shouldActivateConversationOnCreate,
    });

    useEffect(() => {
        callbacksRef.current = {
            onConversationCreated,
            onConfirmationRequest,
            onConfirmationResolved,
            onRunStarted,
            onTaskComplete,
            onStepStart,
            onBillingError,
            onAuthError,
            onError,
            shouldActivateConversationOnCreate,
        };
    }, [
        onConversationCreated,
        onConfirmationRequest,
        onConfirmationResolved,
        onRunStarted,
        onTaskComplete,
        onStepStart,
        onBillingError,
        onAuthError,
        onError,
        shouldActivateConversationOnCreate,
    ]);

    useEffect(() => {
        if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current);
        persistTimeoutRef.current = setTimeout(() => {
            persistConversationStatesToStorage(state.conversationStates);
            persistPendingConfirmationsToStorage(state.pendingConfirmations);
        }, 250);

        return () => {
            if (persistTimeoutRef.current) {
                clearTimeout(persistTimeoutRef.current);
                persistTimeoutRef.current = null;
            }
        };
    }, [state.conversationStates, state.pendingConfirmations]);

    // Handle incoming messages
    const handleMessage = useCallback((message: any) => {
        const {
            onConversationCreated: onConversationCreatedCb,
            onConfirmationRequest: onConfirmationRequestCb,
            onConfirmationResolved: onConfirmationResolvedCb,
            onRunStarted: onRunStartedCb,
            onTaskComplete: onTaskCompleteCb,
            onStepStart: onStepStartCb,
            onBillingError: onBillingErrorCb,
            onAuthError: onAuthErrorCb,
            onError: onErrorCb,
            shouldActivateConversationOnCreate: shouldActivateConversationOnCreateCb,
        } = callbacksRef.current;

        const convId = message.conversationId;
        const runId = message.runId;

        switch (message.type) {
            case 'conversation_created':
                dispatch({
                    type: 'CONVERSATION_CREATED',
                    conversationId: message.conversationId,
                    history: message.history,
                    activate: shouldActivateConversationOnCreateCb?.(message.conversationId, message.history) ?? true,
                });
                onConversationCreatedCb?.(message.conversationId, message.history);
                break;

            case 'run_started':
                dispatch({
                    type: 'RUN_STARTED',
                    conversationId: convId,
                    runId,
                    clientMessageId: message.clientMessageId,
                    suggestedRunId: message.suggestedRunId,
                });
                acquireWakeLock();
                onRunStartedCb?.(convId, runId);
                break;

            case 'run_stopped':
                // Preserve useful partial output for visible stops/disconnects, but avoid
                // flashing delayed provider output immediately before an error card.
                if (message.reason === 'error') clearRun(convId, runId);
                else flushRun(convId, runId);
                dispatch({
                    type: 'RUN_STOPPED',
                    conversationId: convId,
                    runId,
                    reason: message.reason,
                    error: message.error,
                });
                releaseWakeLock();
                if (message.reason === 'error' && message.error) {
                    onErrorCb?.(message.error, convId);
                }
                break;

            case 'run_complete':
                flushRun(convId, runId);
                dispatch({
                    type: 'RUN_COMPLETE',
                    conversationId: convId,
                    runId,
                    response: message.data.response,
                    stepId: message.data.stepId,
                });
                releaseWakeLock();
                onTaskCompleteCb?.(undefined, message.data.response, convId);
                break;

            case 'text_delta':
                enqueueDelta(convId, runId, message.data.delta);
                break;

            case 'step_start':
                if (message.data.message && (message.data.toolCalls || []).length > 0) {
                    clearRun(convId, runId);
                }
                dispatch({
                    type: 'STEP_START',
                    conversationId: convId,
                    runId,
                    thought: message.data.thought,
                    message: message.data.message,
                    toolCalls: message.data.toolCalls || [],
                });
                onStepStartCb?.(convId, runId);
                break;

            case 'step_end':
                dispatch({
                    type: 'STEP_END',
                    conversationId: convId,
                    runId,
                    toolResults: message.data.toolResults || [],
                    stepId: message.data.stepId,
                });
                break;

            case 'confirmation_request':
                dispatch({
                    type: 'CONFIRMATION_REQUEST',
                    conversationId: convId,
                    runId,
                    request: message.data,
                });
                onConfirmationRequestCb?.(message.data, convId, runId);
                break;

            case 'confirmation_resolved':
                if (convId && typeof message.data?.requestId === 'string') {
                    dispatch({
                        type: 'CONFIRMATION_RESPONDED',
                        conversationId: convId,
                        requestId: message.data.requestId,
                    });
                    onConfirmationResolvedCb?.(message.data.requestId, convId);
                }
                break;

            case 'message_deleted':
                if (convId && message.data && typeof message.data.stepId === 'number') {
                    dispatch({
                        type: 'MESSAGE_DELETED',
                        conversationId: convId,
                        role: message.data.role === 'assistant' ? 'assistant' : 'user',
                        stepId: message.data.stepId,
                    });
                }
                break;

            case 'user_step_saved':
                dispatch({
                    type: 'USER_STEP_SAVED',
                    conversationId: convId,
                    runId,
                    clientMessageId: message.clientMessageId,
                    stepId: message.stepId,
                    message: message.message,
                });
                break;

            case 'billing_error':
                if (convId && runId) clearRun(convId, runId);
                dispatch({ type: 'BILLING_ERROR', conversationId: convId, runId, error: message.error });
                onBillingErrorCb?.(message.error, convId);
                break;

            case 'auth_error':
                if (convId && runId) clearRun(convId, runId);
                dispatch({ type: 'AUTH_ERROR', conversationId: convId, runId, error: message.error });
                onAuthErrorCb?.(message.error, convId);
                break;

            case 'compaction':
                dispatch({
                    type: 'COMPACTION',
                    conversationId: convId,
                    runId,
                    summary: message.data.summary,
                });
                break;

            case 'observe_status':
                if (!convId) break;
                if (message.hasActiveRun) {
                    // Server confirmed an active run — ensure our state reflects it
                    dispatch({
                        type: 'OBSERVE_ACTIVE_RUN',
                        conversationId: convId,
                        runId: message.runId,
                        clientMessageId: message.clientMessageId,
                    });
                } else {
                    // Server says no active run — clear stale processing state from localStorage
                    // and any persisted confirmations (only relevant while the run is active).
                    dispatch({ type: 'OBSERVE_IDLE', conversationId: convId });
                    dispatch({ type: 'CLEAR_CONFIRMATIONS', conversationId: convId });
                }
                break;
        }
    }, [clearRun, enqueueDelta, flushRun]);

    // Connect to WebSocket
    const connect = useCallback(() => {
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            dispatch({ type: 'CONNECTION_OPENED' });
        };

        ws.onclose = () => {
            dispatch({ type: 'CONNECTION_CLOSED' });
            observedConversationsRef.current.clear();
            setTimeout(connect, 3000);
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleMessage(message);
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        };

        wsRef.current = ws;
    }, [wsUrl, handleMessage]);

    // Initialize connection
    useEffect(() => {
        connect();
        return () => {
            wsRef.current?.close();
        };
    }, [connect]);

    // Auto-observe locally-known in-flight runs so reloads restore live updates
    // (including pending confirmation requests) without requiring navigation.
    useEffect(() => {
        if (!state.isConnected) return;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const candidates = new Set<string>();
        for (const [conversationId, convState] of state.conversationStates.entries()) {
            if (convState.isProcessing) candidates.add(conversationId);
        }
        for (const conversationId of state.pendingConfirmations.keys()) {
            candidates.add(conversationId);
        }

        for (const conversationId of candidates) {
            if (observedConversationsRef.current.has(conversationId)) continue;
            observedConversationsRef.current.add(conversationId);
            ws.send(JSON.stringify({ type: 'observe', conversationId }));
        }
    }, [state.isConnected, state.conversationStates, state.pendingConfirmations]);

    // Actions
    const sendMessage = useCallback((content: string, conversationId?: string, options?: SendMessageOptions) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const clientMessageId = options?.clientMessageId ?? generateUUID();
        const runId = options?.runId ?? generateUUID();
        const optimistic = options?.optimistic ?? true;

        if (optimistic) {
            dispatch({
                type: 'ADD_USER_MESSAGE',
                conversationId,
                message: {
                    id: clientMessageId,
                    stableId: clientMessageId,
                    role: 'user',
                    content,
                },
            });
            dispatch({ type: 'OPTIMISTIC_RUN_STARTED', conversationId, runId, clientMessageId });
        }

        // Send to server
        wsRef.current.send(JSON.stringify({
            type: 'message',
            message: content,
            conversationId,
            ...(options?.chatModelId !== undefined ? { chatModelId: options.chatModelId } : {}),
            clientMessageId,
            runId,
        }));
    }, []);

    const addOptimisticUserMessage = useCallback((message: Message, conversationId?: string) => {
        dispatch({ type: 'ADD_USER_MESSAGE', message, conversationId });
    }, []);

    const startOptimisticRun = useCallback((conversationId: string | undefined, runId: string, clientMessageId: string) => {
        dispatch({ type: 'OPTIMISTIC_RUN_STARTED', conversationId, runId, clientMessageId });
    }, []);

    const stop = useCallback((conversationId: string, runId?: string, options?: StopOptions) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const effectiveRunId = runId || state.currentRunId || '';

        if (options?.optimistic) {
            if (effectiveRunId) flushRun(conversationId, effectiveRunId);
            dispatch({
                type: 'RUN_STOPPED',
                conversationId,
                runId: effectiveRunId,
                reason: options.reason ?? 'user_stop',
            });
            dispatch({ type: 'CLEAR_CONFIRMATIONS', conversationId });
        }

        wsRef.current.send(JSON.stringify({
            type: 'stop',
            conversationId,
            runId,
        }));
    }, [flushRun, state.currentRunId]);

    const respondToConfirmation = useCallback((
        conversationId: string,
        runId: string,
        requestId: string,
        optionId: string,
        guidance?: string,
        attachments?: ConfirmationResponseAttachment[]
    ) => {
        return tryQueueConfirmationResponse(wsRef.current, {
            conversationId,
            runId,
            requestId,
            optionId,
            guidance,
            attachments,
        }, () => {
            dispatch({ type: 'CONFIRMATION_RESPONDED', conversationId, requestId });
        });
    }, []);

    const fork = useCallback((message: string, sourceConversationId: string, options?: { clientMessageId?: string; runId?: string; chatModelId?: number }) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const clientMessageId = options?.clientMessageId ?? generateUUID();
        const runId = options?.runId ?? generateUUID();

        wsRef.current.send(JSON.stringify({
            type: 'fork',
            message,
            sourceConversationId,
            ...(options?.chatModelId !== undefined ? { chatModelId: options.chatModelId } : {}),
            clientMessageId,
            runId,
        }));
    }, []);

    const observe = useCallback((conversationId: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        wsRef.current.send(JSON.stringify({
            type: 'observe',
            conversationId,
        }));
    }, []);

    const setConversationId = useCallback((id: string | undefined) => {
        dispatch({ type: 'SET_CONVERSATION_ID', id });
    }, []);

    const setMessages = useCallback((messages: Message[]) => {
        dispatch({ type: 'SET_MESSAGES', messages });
    }, []);

    const clearConversation = useCallback(() => {
        dispatch({ type: 'CLEAR_CONVERSATION' });
    }, []);

    const syncConversationState = useCallback((conversationId: string, messages: Message[]) => {
        dispatch({ type: 'SYNC_CONVERSATION_STATE', conversationId, messages });
    }, []);

    const removeConversationState = useCallback((conversationId: string) => {
        dispatch({ type: 'REMOVE_CONVERSATION_STATE', conversationId });
    }, []);

    const clearConfirmations = useCallback((conversationId: string) => {
        dispatch({ type: 'CLEAR_CONFIRMATIONS', conversationId });
    }, []);

    const clearCompleted = useCallback((conversationId: string) => {
        dispatch({ type: 'CLEAR_COMPLETED', conversationId });
    }, []);

    const clearStopped = useCallback((conversationId: string) => {
        dispatch({ type: 'CLEAR_STOPPED', conversationId });
    }, []);

    const dismissConfirmation = useCallback((conversationId: string, requestId: string) => {
        dispatch({ type: 'DISMISS_CONFIRMATION', conversationId, requestId });
    }, []);

    const mergeHistory = useCallback((conversationId: string, historyMessages: Message[]) => {
        dispatch({ type: 'MERGE_HISTORY', conversationId, historyMessages });
    }, []);

    return {
        // State
        ...state,
        isProcessing: state.runStatus === 'running',
        isStopped: state.runStatus === 'stopped',

        // Actions
        sendMessage,
        addOptimisticUserMessage,
        startOptimisticRun,
        stop,
        respondToConfirmation,
        fork,
        observe,
        setConversationId,
        setMessages,
        clearConversation,
        syncConversationState,
        removeConversationState,
        clearCompleted,
        clearStopped,
        clearConfirmations,
        dismissConfirmation,
        mergeHistory,

        // Refs
        wsRef,
    };
}

// Exposed for unit tests (reducer behavior is easier to validate directly).
export const __test__ = {
    chatReducer,
    initialState,
    tryQueueConfirmationResponse,
};
