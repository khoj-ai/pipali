/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";

// Types
import type {
    Message,
    Thought,
    WebSocketMessage,
    ConfirmationRequest,
    ConversationSummary,
    ConversationState,
    ActiveTask,
    AuthStatus,
} from "./types";
import type { PendingConfirmation } from "./types/confirmation";

// Hooks
import { useFocusManagement, useModels, useSidecar } from "./hooks";

// Utils
import { formatToolCallsForSidebar } from "./utils/formatting";
import { setApiBaseUrl, apiFetch } from "./utils/api";

// Components
import { Header, Sidebar, InputArea } from "./components/layout";
import { MessageList } from "./components/messages";
import { ToastContainer } from "./components/confirmation/ToastContainer";
import { HomePage } from "./components/home";
import { SkillsPage } from "./components/skills";
import { AutomationsPage } from "./components/automations";
import { McpToolsPage } from "./components/mcp-tools";
import { LoginPage } from "./components/auth";
import type { AutomationPendingConfirmation } from "./types/automations";

// Page types
type PageType = 'home' | 'chat' | 'skills' | 'automations' | 'mcp-tools';

// UUID generator that works in non-secure contexts (e.g., HTTP on non-localhost)
function generateUUID(): string {
    try {
        return crypto.randomUUID();
    } catch {
        // Fallback for non-secure contexts where crypto.randomUUID throws
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
}

const App = () => {
    // Sidecar configuration (for Tauri desktop app)
    const { baseUrl, wsBaseUrl } = useSidecar();

    // Initialize API base URL on mount
    useEffect(() => {
        setApiBaseUrl(baseUrl);
    }, [baseUrl]);

    // Core state
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isConnected, setIsConnected] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [conversationId, setConversationId] = useState<string | undefined>(undefined);
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [exportingConversationId, setExportingConversationId] = useState<string | null>(null);
    const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
    // Current page state - determine from URL
    const [currentPage, setCurrentPage] = useState<PageType>(() => {
        const params = new URLSearchParams(window.location.search);
        // Show chat page if conversationId is present (takes priority over path)
        if (params.get('conversationId') || params.get('q')) return 'chat';
        const path = window.location.pathname;
        if (path === '/skills') return 'skills';
        if (path === '/automations') return 'automations';
        if (path === '/tools') return 'mcp-tools';
        return 'home';
    });

    // Multiple pending confirmations - queue per conversation (supports parallel tool calls)
    const [pendingConfirmations, setPendingConfirmations] = useState<Map<string, ConfirmationRequest[]>>(new Map());
    // Pending confirmations from automations
    const [automationConfirmations, setAutomationConfirmations] = useState<AutomationPendingConfirmation[]>([]);
    // Per-conversation state for tracking active tasks across all conversations
    const [conversationStates, setConversationStates] = useState<Map<string, ConversationState>>(new Map());

    // Refs
    const wsRef = useRef<WebSocket | null>(null);
    const prevConversationIdRef = useRef<string | undefined>(undefined);
    // Track current conversationId for WebSocket handler (avoids stale closure)
    const conversationIdRef = useRef<string | undefined>(undefined);
    // Track pending background task message (sent before conversation_created is received)
    const pendingBackgroundMessageRef = useRef<string | null>(null);
    // Track initial query from URL param (sent once when WebSocket connects or after history loads)
    const initialQueryRef = useRef<string | null>(
        new URLSearchParams(window.location.search).get('q')
    );
    // Track if we have a pending query that needs to wait for history to load
    const pendingQueryAfterHistoryRef = useRef<string | null>(null);

    // Hooks
    const { textareaRef, scheduleTextareaFocus } = useFocusManagement();
    const { models, selectedModel, selectModel, showModelDropdown, setShowModelDropdown } = useModels();

    // Initialize WebSocket and fetch data
    useEffect(() => {
        connectWebSocket();
        fetchConversations();
        fetchAutomationConfirmations();
        fetchAuthStatus();

        // Check URL for conversationId
        const params = new URLSearchParams(window.location.search);
        const cid = params.get('conversationId');
        if (cid) {
            setConversationId(cid);
        }

        // Poll for automation confirmations every 30 seconds
        const pollInterval = setInterval(fetchAutomationConfirmations, 30000);

        return () => {
            if (wsRef.current) {
                wsRef.current.close();
            }
            clearInterval(pollInterval);
        };
    }, []);

    // Keep conversationIdRef in sync with state (for WebSocket handler)
    useEffect(() => {
        conversationIdRef.current = conversationId;
    }, [conversationId]);

    // Focus textarea on various state changes
    useEffect(() => { scheduleTextareaFocus(); }, []);
    useEffect(() => { scheduleTextareaFocus(); }, [conversationId]);
    useEffect(() => {
        if (!isConnected) return;
        if (isProcessing) return;
        scheduleTextareaFocus();
    }, [isConnected, isProcessing]);

    // Fetch history if conversationId changes
    useEffect(() => {
        const prevId = prevConversationIdRef.current;

        // Update URL - when viewing a conversation, always use root path
        if (conversationId) {
            const url = new URL(window.location.href);
            url.pathname = '/';
            url.searchParams.set('conversationId', conversationId);
            window.history.pushState({}, '', url);
        } else {
            const url = new URL(window.location.href);
            url.searchParams.delete('conversationId');
            window.history.pushState({}, '', url);
        }

        // Skip clearing/fetching if this is just a new conversation getting its ID assigned
        const isNewConversationGettingId = prevId === undefined && conversationId !== undefined;
        if (isNewConversationGettingId) {
            setMessages(prev => {
                const hasStreamingOrJustCompleted = prev.some(m => m.role === 'assistant');
                if (hasStreamingOrJustCompleted) {
                    prevConversationIdRef.current = conversationId;
                    return prev;
                }
                fetchHistory(conversationId!);
                prevConversationIdRef.current = conversationId;
                return [];
            });
            return;
        }

        // Clear messages for conversation switches or new chat
        setMessages(_prev => {
            const convState = conversationStates.get(conversationId || '');
            if (convState?.messages && convState.messages.length > 0) {
                prevConversationIdRef.current = conversationId;
                return convState.messages;
            }
            if (conversationId) {
                fetchHistory(conversationId);
            }
            prevConversationIdRef.current = conversationId;
            return [];
        });
    }, [conversationId]);

    // Global Escape key listener for pausing research
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isProcessing && !isPaused && isConnected && conversationId) {
                e.preventDefault();
                e.stopPropagation();
                wsRef.current?.send(JSON.stringify({ type: 'pause', conversationId }));
                textareaRef.current?.focus();
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [isProcessing, isPaused, isConnected, conversationId]);

    // ===== API Functions =====

    const fetchConversations = async () => {
        try {
            const res = await apiFetch('/api/conversations');
            if (res.ok) {
                const data = await res.json();
                setConversations(data.conversations);
            }
        } catch (e) {
            console.error("Failed to fetch conversations", e);
        }
    };

    const fetchAutomationConfirmations = async () => {
        try {
            const res = await apiFetch('/api/automations/confirmations/pending');
            if (res.ok) {
                const data = await res.json();
                setAutomationConfirmations(data.confirmations || []);
            }
        } catch (e) {
            console.error("Failed to fetch automation confirmations", e);
        }
    };

    const fetchAuthStatus = async () => {
        try {
            const res = await apiFetch('/api/auth/status');
            if (res.ok) {
                const data = await res.json();
                setAuthStatus(data);
            }
        } catch (e) {
            console.error("Failed to fetch auth status", e);
        }
    };

    const handleLogout = async () => {
        try {
            const res = await apiFetch('/api/auth/logout', { method: 'POST' });
            if (res.ok) {
                // Fetch auth status again - this will return authenticated: false
                // which will trigger the login page to show
                await fetchAuthStatus();
            }
        } catch (e) {
            console.error("Failed to logout", e);
        }
    };

    const respondToAutomationConfirmation = async (confirmationId: string, optionId: string, guidance?: string) => {
        try {
            const body: { selectedOptionId: string; guidance?: string } = { selectedOptionId: optionId };
            if (guidance) {
                body.guidance = guidance;
            }
            const res = await apiFetch(`/api/automations/confirmations/${confirmationId}/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                // Remove from local state
                setAutomationConfirmations(prev =>
                    prev.filter(c => c.id !== confirmationId)
                );
            }
        } catch (e) {
            console.error("Failed to respond to automation confirmation", e);
        }
    };

    const dismissAutomationConfirmation = (confirmationId: string) => {
        // Just remove from local state - doesn't actually respond
        setAutomationConfirmations(prev =>
            prev.filter(c => c.id !== confirmationId)
        );
    };

    const fetchHistory = async (id: string) => {
        try {
            const res = await apiFetch(`/api/chat/${id}/history`);
            if (!res.ok) return;
            const data = await res.json();
            const historyMessages: Message[] = [];
            let currentAgentMessage: Message | null = null;
            let thoughts: Thought[] = [];

            const finalizeCurrentAgent = () => {
                if (currentAgentMessage) {
                    if (thoughts.length > 0) {
                        currentAgentMessage.thoughts = thoughts;
                    }
                    historyMessages.push(currentAgentMessage);
                } else if (thoughts.length > 0) {
                    historyMessages.push({
                        role: 'assistant',
                        content: '',
                        thoughts: thoughts,
                        id: generateUUID(),
                    });
                }
                thoughts = [];
                currentAgentMessage = null;
            };

            for (const msg of data.history) {
                if (msg.source === 'user') {
                    finalizeCurrentAgent();
                    historyMessages.push({
                        role: 'user',
                        content: typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message),
                        id: msg.step_id,
                    });
                }

                if (msg.source === 'agent') {
                    let toolResultsMap: Map<string, string> = new Map();
                    const hasMessage = msg.message && msg.message.trim() !== '';

                    if (msg.reasoning_content) {
                        thoughts.push({
                            type: 'thought',
                            content: msg.reasoning_content,
                            id: generateUUID(),
                            isInternalThought: true,
                        });
                    }

                    // Build tool results map from observation if present
                    if (msg.observation && msg.observation.results) {
                        toolResultsMap = new Map(
                            msg.observation.results
                            .filter((res: any) => res.source_call_id && res.content)
                            .map((res: any) => [res.source_call_id, res.content])
                        );
                    }

                    // Add tool calls as thoughts (with results if available)
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        // If there's a message alongside tool calls, add it as a thought first
                        if (hasMessage) {
                            thoughts.push({
                                type: 'thought',
                                content: msg.message,
                                id: generateUUID(),
                            });
                        }
                        for (const tc of msg.tool_calls) {
                            thoughts.push({
                                type: 'tool_call',
                                toolName: tc.function_name,
                                toolArgs: tc.arguments,
                                toolResult: toolResultsMap.get(tc.tool_call_id),
                                content: '',
                                id: tc.tool_call_id,
                            });
                        }
                    } else if (hasMessage) {
                        // No tool calls, just a message - set as currentAgentMessage
                        currentAgentMessage = {
                            role: 'assistant',
                            content: msg.message,
                            id: msg.step_id,
                        };
                    }
                }
            }

            finalizeCurrentAgent();
            setMessages(historyMessages);

            // Check if there's a pending query to send after history loaded
            const pendingQuery = pendingQueryAfterHistoryRef.current;
            if (pendingQuery && wsRef.current?.readyState === WebSocket.OPEN) {
                pendingQueryAfterHistoryRef.current = null;

                // Add the new message to the loaded history
                const userMsg: Message = { id: generateUUID(), role: 'user', content: pendingQuery };
                const assistantMsg: Message = { id: generateUUID(), role: 'assistant', content: '', thoughts: [], isStreaming: true };
                setMessages(prev => [...prev, userMsg, assistantMsg]);
                setIsProcessing(true);
                wsRef.current.send(JSON.stringify({ message: pendingQuery, conversationId: id }));
            }
        } catch (e) {
            console.error("Failed to fetch history", e);
        }
    };

    const getFilenameFromContentDisposition = (headerValue: string | null): string | null => {
        if (!headerValue) return null;
        const filenameStarMatch = headerValue.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
        if (filenameStarMatch?.[1]) {
            try {
                return decodeURIComponent(filenameStarMatch[1].trim().replace(/^"|"$/g, ''));
            } catch { /* fall through */ }
        }
        const filenameMatch = headerValue.match(/filename=("[^"]+"|[^;]+)/i);
        if (filenameMatch?.[1]) {
            return filenameMatch[1].trim().replace(/^"|"$/g, '');
        }
        return null;
    };

    const exportConversationAsATIF = async (id: string) => {
        if (!id || exportingConversationId) return;
        setExportingConversationId(id);
        try {
            const res = await apiFetch(`/api/conversations/${id}/export/atif`);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(text || `Export failed (${res.status})`);
            }
            const blob = await res.blob();
            const filename = getFilenameFromContentDisposition(res.headers.get('Content-Disposition'))
                || `conversation_${id}.atif.json`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('Failed to export conversation as ATIF', e);
            alert(e instanceof Error ? e.message : 'Failed to export conversation');
        } finally {
            setExportingConversationId(null);
        }
    };

    // ===== WebSocket =====

    const connectWebSocket = () => {
        const wsUrl = `${wsBaseUrl}/ws/chat`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log("Connected to WebSocket");
            setIsConnected(true);

            // Auto-send initial query from URL param if present
            const initialQuery = initialQueryRef.current;
            if (initialQuery) {
                initialQueryRef.current = null; // Clear to prevent re-sending on reconnect

                // Clear query param from URL without page reload
                const url = new URL(window.location.href);
                url.searchParams.delete('q');
                window.history.replaceState({}, '', url);

                // Get conversationId from URL if present (to continue existing conversation)
                const urlConversationId = new URLSearchParams(window.location.search).get('conversationId') || undefined;

                if (urlConversationId) {
                    // If there's a conversationId, we need to wait for history to load first
                    // Store the query to be sent after history loads
                    pendingQueryAfterHistoryRef.current = initialQuery;
                    setCurrentPage('chat');
                } else {
                    // No conversationId, start fresh conversation immediately
                    const userMsg: Message = { id: generateUUID(), role: 'user', content: initialQuery };
                    const assistantMsg: Message = { id: generateUUID(), role: 'assistant', content: '', thoughts: [], isStreaming: true };
                    setMessages([userMsg, assistantMsg]);
                    setIsProcessing(true);
                    setCurrentPage('chat');
                    ws.send(JSON.stringify({ message: initialQuery }));
                }
            }
        };

        ws.onclose = () => {
            console.log("Disconnected from WebSocket");
            setIsConnected(false);
            setTimeout(connectWebSocket, 3000);
        };

        ws.onmessage = (event) => {
            try {
                const message: WebSocketMessage = JSON.parse(event.data);
                handleWebSocketMessage(message);
            } catch (e) {
                console.error("Failed to parse message:", e);
            }
        };

        wsRef.current = ws;
    };

    const handleWebSocketMessage = (message: WebSocketMessage) => {
        const msgConversationId = message.conversationId;

        if (message.type === 'error') {
            console.error("Server error:", message.error);
            if (msgConversationId) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    next.delete(msgConversationId);
                    return next;
                });
            }
            if (!msgConversationId || msgConversationId === conversationIdRef.current) {
                setIsProcessing(false);
                setIsPaused(false);
                setMessages(prev => [...prev, {
                    id: generateUUID(),
                    role: 'assistant',
                    content: `Error: ${message.error}`,
                }]);
            }
            return;
        }

        if (message.type === 'research') {
            if (msgConversationId) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(msgConversationId);
                    let msgs = existing?.messages || [];
                    const lastMsg = msgs[msgs.length - 1];
                    if (!lastMsg || !lastMsg.isStreaming) {
                        msgs = [...msgs, {
                            id: generateUUID(),
                            role: 'assistant' as const,
                            content: '',
                            isStreaming: true,
                            thoughts: [],
                        }];
                    }
                    next.set(msgConversationId, {
                        isProcessing: true,
                        isPaused: false, // Research is active, clear paused state
                        latestReasoning: existing?.latestReasoning,
                        messages: msgs,
                    });
                    return next;
                });
            }
            if (!msgConversationId || msgConversationId === conversationIdRef.current) {
                setIsProcessing(true);
                setIsPaused(false); // Research is active, clear paused state
            }
            return;
        }

        if (message.type === 'pause') {
            if (msgConversationId) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(msgConversationId);
                    next.set(msgConversationId, {
                        isProcessing: true,
                        isPaused: true,
                        latestReasoning: existing?.latestReasoning,
                        messages: existing?.messages || [],
                    });
                    return next;
                });
            }
            if (!msgConversationId || msgConversationId === conversationIdRef.current) {
                setIsPaused(true);
            }
            return;
        }

        if (message.type === 'conversation_created') {
            const newConvId = message.conversationId;
            const isBackgroundTask = pendingBackgroundMessageRef.current !== null;
            const pendingMsg = pendingBackgroundMessageRef.current;
            pendingBackgroundMessageRef.current = null; // Clear the pending message

            // For background tasks, don't switch to the new conversation
            if (!isBackgroundTask) {
                // Update ref immediately so subsequent WebSocket messages are processed correctly
                // (avoids race condition where messages arrive before useEffect updates the ref)
                conversationIdRef.current = newConvId;
                setConversationId(newConvId);
            }

            if (newConvId) {
                if (isBackgroundTask && pendingMsg) {
                    // For background task: create user message + streaming assistant message
                    const initialMessages = [
                        { id: generateUUID(), role: 'user' as const, content: pendingMsg },
                        { id: generateUUID(), role: 'assistant' as const, content: '', thoughts: [], isStreaming: true },
                    ];
                    setConversationStates(prevStates => {
                        const next = new Map(prevStates);
                        next.set(newConvId, {
                            isProcessing: true,
                            isPaused: false,
                            latestReasoning: undefined,
                            messages: initialMessages,
                        });
                        return next;
                    });
                } else {
                    // For foreground: use current messages state (via functional update to avoid stale closure)
                    // Don't overwrite messages - they were already set by sendMessage()
                    // Just sync conversationStates with current messages
                    setMessages(currentMessages => {
                        setConversationStates(prevStates => {
                            const next = new Map(prevStates);
                            next.set(newConvId, {
                                isProcessing: true,
                                isPaused: false,
                                latestReasoning: undefined,
                                messages: currentMessages,
                            });
                            return next;
                        });
                        return currentMessages; // Return unchanged - don't overwrite
                    });
                }
            }
            fetchConversations();
            return;
        }

        if (message.type === 'confirmation_request') {
            const confirmationData = message.data as ConfirmationRequest;
            if (msgConversationId) {
                setPendingConfirmations(prev => {
                    const next = new Map(prev);
                    const existing = next.get(msgConversationId) || [];
                    // Add to queue (avoid duplicates by checking requestId)
                    if (!existing.some(c => c.requestId === confirmationData.requestId)) {
                        next.set(msgConversationId, [...existing, confirmationData]);
                    }
                    return next;
                });
            }
            return;
        }

        // Handle tool call start - add pending tool calls before execution
        if (message.type === 'tool_call_start') {
            const { data } = message;

            const createPendingThoughts = (): Thought[] => {
                const newThoughts: Thought[] = [];
                // Add thought/message if present
                if (data.message && data.toolCalls?.length > 0) {
                    newThoughts.push({
                        id: generateUUID(),
                        type: 'thought',
                        content: data.message,
                    });
                } else if (data.thought) {
                    newThoughts.push({
                        id: generateUUID(),
                        type: 'thought',
                        content: data.thought,
                        isInternalThought: true,
                    });
                }

                // Add tool calls as pending (no results yet)
                for (const toolCall of data.toolCalls || []) {
                    newThoughts.push({
                        id: toolCall.tool_call_id || generateUUID(),
                        type: 'tool_call',
                        content: '',
                        toolName: toolCall.function_name,
                        toolArgs: toolCall.arguments,
                        isPending: true,
                    });
                }

                return newThoughts;
            };

            const updateMessagesWithPendingThoughts = (msgs: Message[]): Message[] => {
                const lastMsg = msgs[msgs.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                    const newThoughts = createPendingThoughts();
                    return msgs.map(msg =>
                        msg.id === lastMsg.id
                            ? { ...msg, thoughts: [...(msg.thoughts || []), ...newThoughts] }
                            : msg
                    );
                }
                return msgs;
            };

            const currentConvId = conversationIdRef.current;
            // Update the current view if:
            // 1. Message conversation matches current conversation, OR
            // 2. No message conversation ID and we have a current conversation (legacy)
            const isCurrentConversation =
                !msgConversationId || // Legacy case
                msgConversationId === currentConvId; // Matches current

            if (isCurrentConversation) {
                setMessages(prev => updateMessagesWithPendingThoughts(prev));
            }

            const targetConvId = msgConversationId || currentConvId;
            if (targetConvId) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(targetConvId);
                    const existingMessages = existing?.messages || [];

                    let newReasoning: string | undefined;
                    if (data.message && data.toolCalls?.length > 0) {
                        newReasoning = data.message;
                    } else if (data.thought) {
                        newReasoning = data.thought;
                    } else if (data.toolCalls?.length > 0) {
                        newReasoning = formatToolCallsForSidebar(data.toolCalls);
                    }

                    next.set(targetConvId, {
                        isProcessing: true,
                        isPaused: existing?.isPaused ?? false, // Preserve paused state
                        latestReasoning: newReasoning || existing?.latestReasoning,
                        messages: updateMessagesWithPendingThoughts(existingMessages),
                    });
                    return next;
                });
            }
            return;
        }

        // Handle iteration with results - update pending tool calls with results
        if (message.type === 'iteration') {
            const { data } = message;

            const updateMessagesWithResults = (msgs: Message[]): Message[] => {
                const lastMsg = msgs[msgs.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                    // Update existing pending tool calls with results
                    const updatedThoughts = (lastMsg.thoughts || []).map(thought => {
                        if (thought.type === 'tool_call' && thought.isPending) {
                            const toolResult = data.toolResults?.find(
                                (tr: any) => tr.source_call_id === thought.id
                            )?.content;
                            if (toolResult !== undefined) {
                                const matchingToolContent = typeof toolResult !== 'string' ? JSON.stringify(toolResult) : toolResult;
                                return { ...thought, toolResult: matchingToolContent, isPending: false };
                            }
                        }
                        return thought;
                    });
                    return msgs.map(msg =>
                        msg.id === lastMsg.id
                            ? { ...msg, thoughts: updatedThoughts }
                            : msg
                    );
                }
                return msgs;
            };

            const currentConvId = conversationIdRef.current;
            // Update the current view if:
            // 1. Message conversation matches current conversation, OR
            // 2. No message conversation ID and we have a current conversation (legacy)
            const isCurrentConversation =
                !msgConversationId || // Legacy case
                msgConversationId === currentConvId; // Matches current

            if (isCurrentConversation) {
                setMessages(prev => updateMessagesWithResults(prev));
            }

            const targetConvId = msgConversationId || currentConvId;
            if (targetConvId) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(targetConvId);
                    const existingMessages = existing?.messages || [];

                    next.set(targetConvId, {
                        isProcessing: true,
                        isPaused: false,
                        latestReasoning: existing?.latestReasoning,
                        messages: updateMessagesWithResults(existingMessages),
                    });
                    return next;
                });
            }
        }

        if (message.type === 'complete') {
            const { data } = message;
            const completedConvId = msgConversationId || data.conversationId;

            const finalizeMessages = (msgs: Message[]): Message[] => {
                const lastMsg = msgs[msgs.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                    return msgs.map(msg =>
                        msg.id === lastMsg.id
                            ? { ...msg, content: data.response, isStreaming: false }
                            : msg
                    );
                }
                return [...msgs, {
                    id: generateUUID(),
                    role: 'assistant' as const,
                    content: data.response,
                    isStreaming: false,
                }];
            };

            const currentConvId = conversationIdRef.current;
            // Update the current view if this message is for the current conversation.
            // When user clicks "New Chat" or goes home, we set conversationIdRef.current to undefined.
            // For normal new conversations, conversation_created updates the ref immediately,
            // so by the time complete arrives, both IDs should match.
            const isCurrentConversation =
                (!completedConvId && !currentConvId) || // Both undefined (legacy - no conversation tracking)
                completedConvId === currentConvId; // Matches current conversation

            if (isCurrentConversation) {
                setConversationId(data.conversationId);
                setIsProcessing(false);
                setIsPaused(false);
                setMessages(prev => finalizeMessages(prev));
            }

            if (completedConvId) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(completedConvId);
                    const existingMessages = existing?.messages || [];
                    next.set(completedConvId, {
                        isProcessing: false,
                        isPaused: false,
                        latestReasoning: existing?.latestReasoning,
                        messages: finalizeMessages(existingMessages),
                    });
                    return next;
                });

                // Clear confirmation queue for completed conversation
                setPendingConfirmations(prev => {
                    const next = new Map(prev);
                    next.delete(completedConvId);
                    return next;
                });
            }

            fetchConversations();
        }
    };

    // ===== Conversation Actions =====

    // Derive active tasks from conversationStates for home page display
    const getActiveTasks = (): ActiveTask[] => {
        const activeTasks: ActiveTask[] = [];

        conversationStates.forEach((state, convId) => {
            if (state.isProcessing) {
                const conv = conversations.find(c => c.id === convId);
                // Get latest user message from conversation messages or title
                const latestUserMessage = state.messages
                    .filter(m => m.role === 'user')
                    .pop()?.content || conv?.title || 'New task';

                // Count tool calls (steps) from the streaming assistant message
                const streamingMsg = state.messages.find(m => m.role === 'assistant' && m.isStreaming);
                const stepCount = streamingMsg?.thoughts?.filter(t => t.type === 'tool_call').length || 0;

                activeTasks.push({
                    conversationId: convId,
                    title: latestUserMessage,
                    reasoning: state.latestReasoning,
                    isPaused: state.isPaused,
                    stepCount,
                });
            }
        });

        return activeTasks;
    };

    const goToHomePage = () => {
        // Save current conversation state if needed
        if (conversationId) {
            const currentState = conversationStates.get(conversationId);
            if (currentState?.isProcessing) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(conversationId);
                    if (existing) {
                        next.set(conversationId, { ...existing, messages });
                    }
                    return next;
                });
            }
        }

        // Update ref immediately to prevent WebSocket messages from old conversation
        // being rendered in new chat (avoids race condition with useEffect)
        conversationIdRef.current = undefined;

        setCurrentPage('home');
        setConversationId(undefined);
        setMessages([]);
        setIsProcessing(false);
        setIsPaused(false);

        // Update URL to root
        window.history.pushState({}, '', '/');
    };

    const goToSkillsPage = () => {
        // Save current conversation state if needed
        if (conversationId) {
            const currentState = conversationStates.get(conversationId);
            if (currentState?.isProcessing) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(conversationId);
                    if (existing) {
                        next.set(conversationId, { ...existing, messages });
                    }
                    return next;
                });
            }
        }

        setCurrentPage('skills');
        setConversationId(undefined);
        setMessages([]);
        setIsProcessing(false);
        setIsPaused(false);

        // Update URL to /skills
        window.history.pushState({}, '', '/skills');
    };

    const goToAutomationsPage = () => {
        // Save current conversation state if needed
        if (conversationId) {
            const currentState = conversationStates.get(conversationId);
            if (currentState?.isProcessing) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(conversationId);
                    if (existing) {
                        next.set(conversationId, { ...existing, messages });
                    }
                    return next;
                });
            }
        }

        setCurrentPage('automations');
        setConversationId(undefined);
        setMessages([]);
        setIsProcessing(false);
        setIsPaused(false);

        // Update URL to /automations
        window.history.pushState({}, '', '/automations');
    };

    const goToMcpToolsPage = () => {
        // Save current conversation state if needed
        if (conversationId) {
            const currentState = conversationStates.get(conversationId);
            if (currentState?.isProcessing) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(conversationId);
                    if (existing) {
                        next.set(conversationId, { ...existing, messages });
                    }
                    return next;
                });
            }
        }

        setCurrentPage('mcp-tools');
        setConversationId(undefined);
        setMessages([]);
        setIsProcessing(false);
        setIsPaused(false);

        // Update URL to /tools
        window.history.pushState({}, '', '/tools');
    };

    const selectConversation = (id: string) => {
        // Save current conversation state if it's processing
        if (conversationId) {
            const currentState = conversationStates.get(conversationId);
            if (currentState?.isProcessing) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(conversationId);
                    if (existing) {
                        next.set(conversationId, { ...existing, messages });
                    }
                    return next;
                });
            }
        }

        setCurrentPage('chat');
        setConversationId(id);
        const convState = conversationStates.get(id);
        setIsProcessing(convState?.isProcessing ?? false);
        setIsPaused(convState?.isPaused ?? false);

        if (convState?.messages && convState.messages.length > 0) {
            setMessages(convState.messages);
        }
    };

    const startNewConversation = () => {
        // Update ref immediately to prevent WebSocket messages from old conversation
        // being rendered in new chat (avoids race condition with useEffect)
        conversationIdRef.current = undefined;

        setCurrentPage('chat');
        setConversationId(undefined);
        setMessages([]); // Clear messages for fresh new chat
        setIsProcessing(false);
        setIsPaused(false);
    };

    const deleteConversation = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            const res = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setConversations(prev => prev.filter(c => c.id !== id));
                if (conversationId === id) {
                    startNewConversation();
                }
            }
        } catch (e) {
            console.error("Failed to delete conversation", e);
        }
    };

    const deleteMessage = async (messageId: string, role: 'user' | 'assistant') => {
        if (!conversationId) return;

        try {
            const res = await apiFetch(`/api/conversations/${conversationId}/messages/${messageId}?role=${role}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                // Remove the message from local state
                setMessages(prev => prev.filter(m => m.id !== messageId));
                // Also update conversation states if needed
                setConversationStates(prev => {
                    const next = new Map(prev);
                    const existing = next.get(conversationId);
                    if (existing) {
                        next.set(conversationId, {
                            ...existing,
                            messages: existing.messages.filter(m => m.id !== messageId),
                        });
                    }
                    return next;
                });
            } else {
                const data = await res.json();
                console.error("Failed to delete message:", data.error);
            }
        } catch (e) {
            console.error("Failed to delete message", e);
        }
    };

    // ===== Message Sending =====

    const pauseResearch = () => {
        if (!isConnected || !isProcessing || isPaused || !conversationId) return;
        // Optimistically update UI immediately for better responsiveness
        setIsPaused(true);
        setConversationStates(prev => {
            const next = new Map(prev);
            const existing = next.get(conversationId);
            if (existing) {
                next.set(conversationId, { ...existing, isPaused: true });
            }
            return next;
        });
        wsRef.current?.send(JSON.stringify({ type: 'pause', conversationId }));
    };

    const resumeResearch = (withMessage?: string) => {
        if (!isConnected || !isPaused || !conversationId) return;
        // Optimistically update UI immediately for better responsiveness
        setIsPaused(false);
        setConversationStates(prev => {
            const next = new Map(prev);
            const existing = next.get(conversationId);
            if (existing) {
                next.set(conversationId, { ...existing, isPaused: false });
            }
            return next;
        });
        wsRef.current?.send(JSON.stringify({ type: 'resume', message: withMessage, conversationId }));
    };

    const sendConfirmationResponse = (convId: string, optionId: string, guidance?: string) => {
        const queue = pendingConfirmations.get(convId);
        const pendingConfirmation = queue?.[0]; // Get first in queue
        if (!pendingConfirmation || !isConnected) return;

        const response = {
            type: 'confirmation_response',
            conversationId: convId,
            data: {
                requestId: pendingConfirmation.requestId,
                selectedOptionId: optionId,
                guidance,
                timestamp: new Date().toISOString(),
            }
        };

        wsRef.current?.send(JSON.stringify(response));

        // Remove the responded confirmation from the queue
        setPendingConfirmations(prev => {
            const next = new Map(prev);
            const existingQueue = next.get(convId) || [];
            const remainingQueue = existingQueue.slice(1); // Remove first item
            if (remainingQueue.length > 0) {
                next.set(convId, remainingQueue);
            } else {
                next.delete(convId);
            }
            return next;
        });
    };

    const sendCurrentConfirmationResponse = (optionId: string, guidance?: string) => {
        if (conversationId) {
            sendConfirmationResponse(conversationId, optionId, guidance);
        }
    };

    // Transform chat confirmation to standard format
    const toChatConfirmation = useCallback((convId: string, request: ConfirmationRequest, convTitle: string): PendingConfirmation => ({
        key: `chat-${convId}-${request.requestId}`,
        request,
        source: { type: 'chat', conversationId: convId, conversationTitle: convTitle },
    }), []);

    // Transform automation confirmation to standard format
    const toAutomationConfirmation = useCallback((confirmation: AutomationPendingConfirmation): PendingConfirmation => ({
        key: `automation-${confirmation.id}`,
        request: confirmation.request,
        source: {
            type: 'automation',
            confirmationId: confirmation.id,
            automationId: confirmation.automationId,
            automationName: confirmation.automationName,
            executionId: confirmation.executionId,
            conversationId: confirmation.conversationId,
        },
        expiresAt: confirmation.expiresAt,
    }), []);

    // Compute list of all pending confirmations
    const allConfirmations = useMemo((): PendingConfirmation[] => {
        const chatConfirmations: PendingConfirmation[] = [];
        // Flatten the queue: for each conversation, take all confirmations in the queue
        for (const [convId, queue] of pendingConfirmations.entries()) {
            const conv = conversations.find(c => c.id === convId);
            const convTitle = conv?.title || 'Background Task';
            for (const request of queue) {
                chatConfirmations.push(toChatConfirmation(convId, request, convTitle));
            }
        }
        const automationConfirmationsList = automationConfirmations.map(toAutomationConfirmation);
        return [...chatConfirmations, ...automationConfirmationsList];
    }, [pendingConfirmations, automationConfirmations, conversations, toChatConfirmation, toAutomationConfirmation]);

    // Confirmation response handler
    const handleConfirmationResponse = (confirmation: PendingConfirmation, optionId: string, guidance?: string) => {
        if (confirmation.source.type === 'chat') {
            sendConfirmationResponse(confirmation.source.conversationId, optionId, guidance);
        } else {
            respondToAutomationConfirmation(confirmation.source.confirmationId, optionId, guidance);
        }
    };

    // Confirmation dismiss handler - removes specific confirmation from queue
    const handleConfirmationDismiss = (confirmation: PendingConfirmation) => {
        const { source } = confirmation;
        if (source.type === 'chat') {
            setPendingConfirmations(prev => {
                const next = new Map(prev);
                const existingQueue = next.get(source.conversationId) || [];
                const remainingQueue = existingQueue.filter(c => c.requestId !== confirmation.request.requestId);
                if (remainingQueue.length > 0) {
                    next.set(source.conversationId, remainingQueue);
                } else {
                    next.delete(source.conversationId);
                }
                return next;
            });
        } else {
            dismissAutomationConfirmation(source.confirmationId);
        }
    };

    const sendMessage = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!input.trim() || !isConnected) return;

        // Clear confirmation queue for current conversation when user sends a new message
        if (conversationId) {
            setPendingConfirmations(prev => {
                const next = new Map(prev);
                next.delete(conversationId);
                return next;
            });
        }

        // If paused, resume with the message
        if (isPaused) {
            const resumeMsg = input.trim();
            setInput("");

            const userMsg: Message = { id: generateUUID(), role: 'user', content: resumeMsg };
            const assistantMsg: Message = { id: generateUUID(), role: 'assistant', content: '', thoughts: [], isStreaming: true };

            const calcNewMessages = (prev: Message[]) => {
                const updated = prev.map(msg => msg.isStreaming ? { ...msg, isStreaming: false } : msg);
                return [...updated, userMsg, assistantMsg];
            };

            setMessages(prev => {
                const newMsgs = calcNewMessages(prev);
                if (conversationId) {
                    setConversationStates(prevStates => {
                        const next = new Map(prevStates);
                        const existing = next.get(conversationId);
                        next.set(conversationId, {
                            isProcessing: true,
                            isPaused: false,
                            latestReasoning: existing?.latestReasoning,
                            messages: newMsgs,
                        });
                        return next;
                    });
                }
                return newMsgs;
            });

            resumeResearch(resumeMsg);
            scheduleTextareaFocus();
            return;
        }

        // If processing, pause and resume with the message
        if (isProcessing && conversationId) {
            const interruptMsg = input.trim();
            setInput("");

            wsRef.current?.send(JSON.stringify({ type: 'pause', conversationId }));

            const userMsg: Message = { id: generateUUID(), role: 'user', content: interruptMsg };
            const assistantMsg: Message = { id: generateUUID(), role: 'assistant', content: '', thoughts: [], isStreaming: true };

            const calcNewMessages = (prev: Message[]) => {
                const updated = prev.map(msg => msg.isStreaming ? { ...msg, isStreaming: false } : msg);
                return [...updated, userMsg, assistantMsg];
            };

            setMessages(prev => {
                const newMsgs = calcNewMessages(prev);
                setConversationStates(prevStates => {
                    const next = new Map(prevStates);
                    const existing = next.get(conversationId);
                    next.set(conversationId, {
                        isProcessing: true,
                        isPaused: false,
                        latestReasoning: existing?.latestReasoning,
                        messages: newMsgs,
                    });
                    return next;
                });
                return newMsgs;
            });

            setTimeout(() => {
                wsRef.current?.send(JSON.stringify({ type: 'resume', message: interruptMsg, conversationId }));
            }, 100);

            scheduleTextareaFocus();
            return;
        }

        // Normal send
        const userMsg: Message = { id: generateUUID(), role: 'user', content: input };
        const assistantMsg: Message = { id: generateUUID(), role: 'assistant', content: '', thoughts: [], isStreaming: true };

        const newMessages = [...messages, userMsg, assistantMsg];
        setMessages(newMessages);
        setIsProcessing(true);
        // Switch to conversation view when sending from home page
        setCurrentPage('chat');

        if (conversationId) {
            setConversationStates(prev => {
                const next = new Map(prev);
                next.set(conversationId, {
                    isProcessing: true,
                    isPaused: false,
                    latestReasoning: undefined,
                    messages: newMessages,
                });
                return next;
            });
        }

        wsRef.current?.send(JSON.stringify({ message: input, conversationId }));
        setInput("");
        scheduleTextareaFocus();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // Send message as a new background task (Cmd+Enter)
    const sendAsBackgroundTask = () => {
        if (!input.trim() || !isConnected) return;

        const userMsg = input.trim();
        setInput("");

        // Store pending message to associate when conversation_created arrives
        pendingBackgroundMessageRef.current = userMsg;

        // Send as a new conversation (no conversationId forces new task)
        wsRef.current?.send(JSON.stringify({ message: userMsg }));

        scheduleTextareaFocus();
    };

    // ===== Render =====

    // Show login page if not authenticated and not in anonymous mode
    // Also show login after logout (authStatus is null or not authenticated)
    if (authStatus !== null && !authStatus.authenticated && !authStatus.anonMode) {
        return <LoginPage onLoginSuccess={fetchAuthStatus} />;
    }

    return (
        <div className="app-wrapper">
            <Sidebar
                isOpen={sidebarOpen}
                conversations={conversations}
                conversationStates={conversationStates}
                pendingConfirmations={pendingConfirmations}
                currentConversationId={conversationId}
                exportingConversationId={exportingConversationId}
                currentPage={currentPage}
                authStatus={authStatus}
                onNewChat={startNewConversation}
                onSelectConversation={selectConversation}
                onDeleteConversation={deleteConversation}
                onExportConversation={exportConversationAsATIF}
                onGoToSkills={goToSkillsPage}
                onGoToAutomations={goToAutomationsPage}
                onGoToMcpTools={goToMcpToolsPage}
                onLogout={handleLogout}
                onClose={() => setSidebarOpen(false)}
            />

            <div className="app-container">
                <Header
                    sidebarOpen={sidebarOpen}
                    onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                    isConnected={isConnected}
                    models={models}
                    selectedModel={selectedModel}
                    showModelDropdown={showModelDropdown}
                    setShowModelDropdown={setShowModelDropdown}
                    onSelectModel={selectModel}
                    onGoHome={goToHomePage}
                />

                {currentPage === 'home' && (
                    <HomePage
                        activeTasks={getActiveTasks()}
                        onSelectTask={selectConversation}
                    />
                )}
                {currentPage === 'skills' && (
                    <SkillsPage />
                )}
                {currentPage === 'automations' && (
                    <AutomationsPage
                        pendingConfirmations={automationConfirmations}
                        onConfirmationRespond={respondToAutomationConfirmation}
                        onConfirmationDismiss={dismissAutomationConfirmation}
                        onViewConversation={selectConversation}
                    />
                )}
                {currentPage === 'mcp-tools' && (
                    <McpToolsPage />
                )}
                {currentPage === 'chat' && (
                    <MessageList messages={messages} onDeleteMessage={deleteMessage} />
                )}

                <InputArea
                    input={input}
                    onInputChange={setInput}
                    onSubmit={sendMessage}
                    onKeyDown={handleKeyDown}
                    isConnected={isConnected}
                    isProcessing={isProcessing}
                    isPaused={isPaused}
                    conversationId={conversationId}
                    onPause={pauseResearch}
                    onResume={() => resumeResearch()}
                    pendingConfirmation={conversationId ? pendingConfirmations.get(conversationId)?.[0] : undefined}
                    onConfirmationRespond={sendCurrentConfirmationResponse}
                    textareaRef={textareaRef}
                    onBackgroundSend={sendAsBackgroundTask}
                />
            </div>

            <ToastContainer
                confirmations={allConfirmations}
                currentConversationId={conversationId}
                onRespond={handleConfirmationResponse}
                onDismiss={handleConfirmationDismiss}
                onNavigateToConversation={selectConversation}
                onNavigateToAutomations={goToAutomationsPage}
            />
        </div>
    );
};

// Export for use in Tauri wrapper
export default App;

// Direct render for web mode only (skip in Tauri - main.tsx handles rendering with SidecarProvider)
if (typeof window !== 'undefined' && document.getElementById("root") && !('__TAURI_INTERNALS__' in window)) {
    const root = createRoot(document.getElementById("root")!);
    root.render(<App />);
}
