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
    pendingConfirmations: Map<string, ConfirmationRequest[]>;
}

export type ChatAction =
    | { type: 'CONNECTION_OPENED' }
    | { type: 'CONNECTION_CLOSED' }
    | { type: 'SET_CONVERSATION_ID'; id: string | undefined }
    | { type: 'SET_MESSAGES'; messages: Message[] }
    | { type: 'ADD_USER_MESSAGE'; message: Message }
    | { type: 'CONVERSATION_CREATED'; conversationId: string; history?: any[] }
    | { type: 'RUN_STARTED'; conversationId: string; runId: string; clientMessageId: string }
    | { type: 'RUN_STOPPED'; conversationId: string; runId: string; reason: StopReason; error?: string }
    | { type: 'RUN_COMPLETE'; conversationId: string; runId: string; response: string; stepId: number }
    | { type: 'STEP_START'; conversationId: string; runId: string; thought?: string; message?: string; toolCalls: any[] }
    | { type: 'STEP_END'; conversationId: string; runId: string; toolResults: any[]; stepId: number }
    | { type: 'CONFIRMATION_REQUEST'; conversationId: string; runId: string; request: ConfirmationRequest }
    | { type: 'CONFIRMATION_RESPONDED'; conversationId: string; requestId: string }
    | { type: 'USER_STEP_SAVED'; conversationId: string; runId: string; clientMessageId: string; stepId: number }
    | { type: 'BILLING_ERROR'; conversationId?: string; runId?: string; error: BillingError }
    | { type: 'CLEAR_CONVERSATION' }
    | { type: 'SYNC_CONVERSATION_STATE'; conversationId: string; messages: Message[] };

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
            return { ...state, messages: [...state.messages, action.message] };

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

            return {
                ...state,
                conversationId,
                messages,
            };
        }

        case 'RUN_STARTED': {
            const { conversationId, runId, clientMessageId } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            // Update conversation states
            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            let messages = existing?.messages || (isCurrentConversation ? state.messages : []);

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
                messages,
            });

            return {
                ...state,
                runStatus: isCurrentConversation ? 'running' : state.runStatus,
                currentRunId: isCurrentConversation ? runId : state.currentRunId,
                messages: isCurrentConversation ? messages : state.messages,
                conversationStates,
            };
        }

        case 'RUN_STOPPED': {
            const { conversationId, runId, reason } = action;
            const isCurrentConversation = conversationId === state.conversationId;

            // Mark pending tool calls as interrupted
            const markInterrupted = (msgs: Message[]): Message[] => {
                return msgs.map(msg => {
                    if (msg.role === 'assistant' && msg.stableId === runId && msg.thoughts?.some(t => t.isPending)) {
                        const updatedThoughts = msg.thoughts!.map(thought => {
                            if (thought.type === 'tool_call' && thought.isPending) {
                                return { ...thought, isPending: false, toolResult: '[interrupted]' };
                            }
                            return thought;
                        });
                        return { ...msg, thoughts: updatedThoughts, isStreaming: false };
                    }
                    return msg;
                });
            };

            const conversationStates = new Map(state.conversationStates);
            const existing = conversationStates.get(conversationId);
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    isProcessing: false,
                    isStopped: reason === 'user_stop',
                    messages: markInterrupted(existing.messages),
                });
            }

            return {
                ...state,
                runStatus: isCurrentConversation ? 'stopped' : state.runStatus,
                currentRunId: isCurrentConversation ? undefined : state.currentRunId,
                messages: isCurrentConversation ? markInterrupted(state.messages) : state.messages,
                conversationStates,
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
                    return [
                        ...filteredMsgs,
                        {
                            id: messageId,
                            stableId: runId,
                            role: 'assistant' as const,
                            content: response,
                            isStreaming: false,
                        },
                    ];
                }
                return filteredMsgs.map((msg, i) => {
                    if (i !== idx) return msg;
                    return { ...msg, id: messageId, content: response, isStreaming: false };
                });
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
            const { conversationId, request } = action;

            const pendingConfirmations = new Map(state.pendingConfirmations);
            const existing = pendingConfirmations.get(conversationId) || [];
            if (!existing.some(c => c.requestId === request.requestId)) {
                pendingConfirmations.set(conversationId, [...existing, request]);
            }

            return { ...state, pendingConfirmations };
        }

        case 'CONFIRMATION_RESPONDED': {
            const { conversationId, requestId } = action;

            const pendingConfirmations = new Map(state.pendingConfirmations);
            const existingQueue = pendingConfirmations.get(conversationId) || [];
            const remainingQueue = existingQueue.filter(c => c.requestId !== requestId);
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
            if (existing) {
                conversationStates.set(conversationId, {
                    ...existing,
                    messages,
                });
            }
            return { ...state, conversationStates };
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
}

export function useWebSocketChat(options: UseWebSocketChatOptions) {
    const { wsUrl, onConversationCreated, onConfirmationRequest, onTaskComplete, onBillingError, onError } = options;

    const [state, dispatch] = useReducer(chatReducer, initialState);
    const wsRef = useRef<WebSocket | null>(null);
    const conversationIdRef = useRef<string | undefined>(undefined);

    // Keep ref in sync
    useEffect(() => {
        conversationIdRef.current = state.conversationId;
    }, [state.conversationId]);

    // Handle incoming messages
    const handleMessage = useCallback((message: any) => {
        const convId = message.conversationId;
        const runId = message.runId;

        switch (message.type) {
            case 'conversation_created':
                dispatch({ type: 'CONVERSATION_CREATED', conversationId: message.conversationId, history: message.history });
                onConversationCreated?.(message.conversationId, message.history);
                break;

            case 'run_started':
                dispatch({
                    type: 'RUN_STARTED',
                    conversationId: convId,
                    runId,
                    clientMessageId: message.clientMessageId,
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
                    onError?.(message.error, convId);
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
                onTaskComplete?.(undefined, message.data.response, convId);
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
                onConfirmationRequest?.(message.data, convId, runId);
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
                onBillingError?.(message.error, convId);
                break;
        }
    }, [onConversationCreated, onConfirmationRequest, onTaskComplete, onBillingError, onError]);

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
    const sendMessage = useCallback((content: string, conversationId?: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const clientMessageId = generateUUID();
        const runId = generateUUID();

        // Add user message optimistically
        dispatch({ type: 'ADD_USER_MESSAGE', message: {
            id: clientMessageId,
            stableId: clientMessageId,
            role: 'user',
            content,
        }});

        // Send to server
        wsRef.current.send(JSON.stringify({
            type: 'message',
            message: content,
            conversationId,
            clientMessageId,
            runId,
        }));
    }, []);

    const stop = useCallback((conversationId: string, runId?: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({
            type: 'stop',
            conversationId,
            runId,
        }));
    }, []);

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

    return {
        // State
        ...state,
        isProcessing: state.runStatus === 'running',
        isStopped: state.runStatus === 'stopped',

        // Actions
        sendMessage,
        stop,
        respondToConfirmation,
        fork,
        setConversationId,
        setMessages,
        clearConversation,
        syncConversationState,

        // Refs
        wsRef,
    };
}
