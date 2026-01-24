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
import type { Message, Thought, ConversationState, ConfirmationRequest, BillingError } from '../types';
import { formatToolCallsForSidebar } from '../utils/formatting';

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
    | { type: 'STEP_START'; conversationId: string; runId: string; thought?: string; message?: string; toolCalls: any[] }
    | { type: 'STEP_END'; conversationId: string; runId: string; toolResults: any[]; stepId: number }
    | { type: 'CONFIRMATION_REQUEST'; conversationId: string; runId: string; request: ConfirmationRequest }
    | { type: 'CONFIRMATION_RESPONDED'; conversationId: string; requestId: string }
    | { type: 'DISMISS_CONFIRMATION'; conversationId: string; requestId: string }
    | { type: 'USER_STEP_SAVED'; conversationId: string; runId: string; clientMessageId: string; stepId: number }
    | { type: 'BILLING_ERROR'; conversationId?: string; runId?: string; error: BillingError }
    | { type: 'CLEAR_CONVERSATION' }
    | { type: 'SYNC_CONVERSATION_STATE'; conversationId: string; messages: Message[] }
    | { type: 'REMOVE_CONVERSATION_STATE'; conversationId: string }
    | { type: 'CLEAR_CONFIRMATIONS'; conversationId: string };

export interface SendMessageOptions {
    clientMessageId?: string;
    runId?: string;
    optimistic?: boolean;
}

export interface StopOptions {
    optimistic?: boolean;
    reason?: StopReason;
}

// ============================================================================
// Helpers
// ============================================================================

function generateUUID(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
}

function findRunAssistantIndex(messages: Message[], runId: string): number {
    return messages.findIndex(m => m.role === 'assistant' && m.stableId === runId);
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

// ============================================================================
// Reducer
// ============================================================================

function chatReducer(state: ChatState, action: ChatAction): ChatState {
    switch (action.type) {
        case 'CONNECTION_OPENED':
            return { ...state, isConnected: true };

        case 'CONNECTION_CLOSED':
            return { ...state, isConnected: false };

        case 'SET_CONVERSATION_ID':
            return { ...state, conversationId: action.id };

        case 'SET_MESSAGES':
            return { ...state, messages: action.messages };

        case 'ADD_USER_MESSAGE':
            return (() => {
                const targetConversationId = action.conversationId ?? state.conversationId;
                const isCurrentConversation = !!targetConversationId && targetConversationId === state.conversationId;

                // Always append to the current messages list if:
                // - this message is for the current conversation, or
                // - we don't yet have a conversationId (new chat bootstrap)
                const nextMessages =
                    (isCurrentConversation || state.conversationId === undefined)
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

            const nextMessages = isCurrentConversation ? insertAssistant(state.messages) : state.messages;

            const conversationStates = new Map(state.conversationStates);
            if (targetConversationId) {
                const existing = conversationStates.get(targetConversationId);
                const baseMessages = existing?.messages || (isCurrentConversation ? nextMessages : []);
                conversationStates.set(targetConversationId, {
                    isProcessing: true,
                    isStopped: false,
                    latestReasoning: existing?.latestReasoning,
                    messages: isCurrentConversation ? nextMessages : insertAssistant(baseMessages),
                });
            }

            return {
                ...state,
                runStatus: isCurrentConversation ? 'running' : state.runStatus,
                currentRunId: isCurrentConversation ? runId : state.currentRunId,
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
            let messages = isCurrentConversation ? state.messages : (existing?.messages || []);

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
                const assistant: Message = {
                    id: runId,
                    stableId: runId,
                    role: 'assistant',
                    content: '',
                    isStreaming: true,
                    thoughts: [],
                };

                const userIndex = messages.findIndex(m => m.role === 'user' && (m.id === clientMessageId || m.stableId === clientMessageId));
                messages = userIndex === -1
                    ? [...messages, assistant]
                    : [...messages.slice(0, userIndex + 1), assistant, ...messages.slice(userIndex + 1)];
            }

            conversationStates.set(conversationId, {
                isProcessing: true,
                isStopped: false,
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
            const { conversationId, runId, reason } = action;
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

            const finalizeStopped = (msgs: Message[]): Message[] => {
                const interrupted = markInterrupted(msgs);
                // Only force-stop all streaming indicators when we can't reliably
                // target a run (disconnect/error), otherwise preserve streaming for
                // any new optimistic run started by soft interrupt.
                if (!runId || reason === 'disconnect' || reason === 'error') {
                    return stopAllStreamingAssistants(interrupted);
                }
                return interrupted;
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    isProcessing: false,
                    isStopped: reason === 'user_stop',
                    messages: finalizeStopped(existing.messages),
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
                messages: isCurrentConversation ? finalizeStopped(state.messages) : state.messages,
                conversationStates,
                pendingConfirmations,
            };
        }

        case 'RUN_COMPLETE': {
            const { conversationId, runId, response, stepId } = action;
            const isCurrentConversation = conversationId === state.conversationId;
            const messageId = String(stepId);

            const finalizeMessages = (msgs: Message[]): Message[] => {
                const filteredMsgs = msgs.filter(msg => !msg.billingInfo);
                const idx = findRunAssistantIndex(filteredMsgs, runId);
                if (idx === -1) {
                    const next = [
                        ...filteredMsgs,
                        {
                            id: messageId,
                            stableId: runId,
                            role: 'assistant' as const,
                            content: response,
                            isStreaming: false,
                        },
                    ];
                    return dropEmptyStreamingPlaceholders(stopAllStreamingAssistants(next), runId);
                }
                const updated = filteredMsgs.map((msg, i) => {
                    if (i !== idx) return msg;
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

        case 'STEP_START': {
            const { conversationId, runId, thought, message: reasoning, toolCalls } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            const newThoughts: Thought[] = [];

            // Add reasoning thought if present
            if (reasoning && toolCalls?.length > 0) {
                newThoughts.push({ id: generateUUID(), type: 'thought', content: reasoning });
            } else if (thought) {
                newThoughts.push({ id: generateUUID(), type: 'thought', content: thought, isInternalThought: true });
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
                });
            }

            const updateMessagesWithThoughts = (msgs: Message[]): Message[] => {
                const idx = findRunAssistantIndex(msgs, runId);
                if (idx === -1) return msgs;
                return msgs.map((msg, i) => {
                    if (i !== idx) return msg;
                    return { ...msg, thoughts: [...(msg.thoughts || []), ...newThoughts] };
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

            const updateUserMessageId = (msgs: Message[]): Message[] => {
                // Find the message that matches the clientMessageId
                return msgs.map(msg => {
                    if (msg.role === 'user' && msg.id === clientMessageId) {
                        return { ...msg, id: stepIdStr };
                    }
                    return msg;
                });
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    messages: updateUserMessageId(existing.messages),
                });
            }

            return {
                ...state,
                messages: isCurrentConversation ? updateUserMessageId(state.messages) : state.messages,
                conversationStates,
            };
        }

        case 'BILLING_ERROR': {
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
                latestReasoning: existing?.latestReasoning,
                messages,
            });
            return { ...state, conversationStates };
        }

        case 'REMOVE_CONVERSATION_STATE': {
            const conversationStates = new Map(state.conversationStates);
            conversationStates.delete(action.conversationId);
            return { ...state, conversationStates };
        }

        case 'CLEAR_CONFIRMATIONS': {
            const pendingConfirmations = new Map(state.pendingConfirmations);
            pendingConfirmations.delete(action.conversationId);
            return { ...state, pendingConfirmations };
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

// ============================================================================
// Hook
// ============================================================================

export interface UseWebSocketChatOptions {
    wsUrl: string;
    onConversationCreated?: (conversationId: string, history?: any[]) => void;
    onConfirmationRequest?: (request: ConfirmationRequest, conversationId: string, runId: string) => void;
    onTaskComplete?: (request: string | undefined, response: string, conversationId: string) => void;
    onBillingError?: (error: BillingError, conversationId?: string) => void;
    onError?: (error: string, conversationId?: string) => void;
    shouldActivateConversationOnCreate?: (conversationId: string, history?: any[]) => boolean;
}

export function useWebSocketChat(options: UseWebSocketChatOptions) {
    const {
        wsUrl,
        onConversationCreated,
        onConfirmationRequest,
        onTaskComplete,
        onBillingError,
        onError,
        shouldActivateConversationOnCreate,
    } = options;

    const [state, dispatch] = useReducer(chatReducer, initialState);
    const wsRef = useRef<WebSocket | null>(null);

    const callbacksRef = useRef<Pick<
        UseWebSocketChatOptions,
        | 'onConversationCreated'
        | 'onConfirmationRequest'
        | 'onTaskComplete'
        | 'onBillingError'
        | 'onError'
        | 'shouldActivateConversationOnCreate'
    >>({
        onConversationCreated,
        onConfirmationRequest,
        onTaskComplete,
        onBillingError,
        onError,
        shouldActivateConversationOnCreate,
    });

    useEffect(() => {
        callbacksRef.current = {
            onConversationCreated,
            onConfirmationRequest,
            onTaskComplete,
            onBillingError,
            onError,
            shouldActivateConversationOnCreate,
        };
    }, [
        onConversationCreated,
        onConfirmationRequest,
        onTaskComplete,
        onBillingError,
        onError,
        shouldActivateConversationOnCreate,
    ]);

    // Handle incoming messages
    const handleMessage = useCallback((message: any) => {
        const {
            onConversationCreated: onConversationCreatedCb,
            onConfirmationRequest: onConfirmationRequestCb,
            onTaskComplete: onTaskCompleteCb,
            onBillingError: onBillingErrorCb,
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
                break;

            case 'run_stopped':
                dispatch({
                    type: 'RUN_STOPPED',
                    conversationId: convId,
                    runId,
                    reason: message.reason,
                    error: message.error,
                });
                if (message.reason === 'error' && message.error) {
                    onErrorCb?.(message.error, convId);
                }
                break;

            case 'run_complete':
                dispatch({
                    type: 'RUN_COMPLETE',
                    conversationId: convId,
                    runId,
                    response: message.data.response,
                    stepId: message.data.stepId,
                });
                onTaskCompleteCb?.(undefined, message.data.response, convId);
                break;

            case 'step_start':
                dispatch({
                    type: 'STEP_START',
                    conversationId: convId,
                    runId,
                    thought: message.data.thought,
                    message: message.data.message,
                    toolCalls: message.data.toolCalls || [],
                });
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

            case 'user_step_saved':
                dispatch({
                    type: 'USER_STEP_SAVED',
                    conversationId: convId,
                    runId,
                    clientMessageId: message.clientMessageId,
                    stepId: message.stepId,
                });
                break;

            case 'billing_error':
                dispatch({ type: 'BILLING_ERROR', conversationId: convId, runId, error: message.error });
                onBillingErrorCb?.(message.error, convId);
                break;
        }
    }, []);

    // Connect to WebSocket
    const connect = useCallback(() => {
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            dispatch({ type: 'CONNECTION_OPENED' });
        };

        ws.onclose = () => {
            dispatch({ type: 'CONNECTION_CLOSED' });
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

        if (options?.optimistic) {
            dispatch({
                type: 'RUN_STOPPED',
                conversationId,
                runId: runId || state.currentRunId || '',
                reason: options.reason ?? 'user_stop',
            });
            dispatch({ type: 'CLEAR_CONFIRMATIONS', conversationId });
        }

        wsRef.current.send(JSON.stringify({
            type: 'stop',
            conversationId,
            runId,
        }));
    }, [state.currentRunId]);

    const respondToConfirmation = useCallback((
        conversationId: string,
        runId: string,
        requestId: string,
        optionId: string,
        guidance?: string
    ) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        dispatch({ type: 'CONFIRMATION_RESPONDED', conversationId, requestId });

        wsRef.current.send(JSON.stringify({
            type: 'confirmation_response',
            conversationId,
            runId,
            data: {
                requestId,
                selectedOptionId: optionId,
                guidance,
                timestamp: new Date().toISOString(),
            },
        }));
    }, []);

    const fork = useCallback((message: string, sourceConversationId: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const clientMessageId = generateUUID();
        const runId = generateUUID();

        wsRef.current.send(JSON.stringify({
            type: 'fork',
            message,
            sourceConversationId,
            clientMessageId,
            runId,
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

    const dismissConfirmation = useCallback((conversationId: string, requestId: string) => {
        dispatch({ type: 'DISMISS_CONFIRMATION', conversationId, requestId });
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
        setConversationId,
        setMessages,
        clearConversation,
        syncConversationState,
        removeConversationState,
        clearConfirmations,
        dismissConfirmation,

        // Refs
        wsRef,
    };
}
