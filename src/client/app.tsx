/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";

// Types
import type {
    Message,
    Thought,
    ConfirmationRequest,
    ConversationSummary,
    ConversationState,
    ActiveTask,
    AuthStatus,
    BillingAlert,
    BillingError,
    ServerMessage,
} from "./types";
import type { PendingConfirmation } from "./types/confirmation";

// Hooks
import { useFocusManagement, useModels, useSidecar } from "./hooks";

// Utils
import { formatToolCallsForSidebar } from "./utils/formatting";
import { setApiBaseUrl, apiFetch } from "./utils/api";
import { initNotifications, notifyConfirmationRequest, notifyTaskComplete, setNotificationClickHandler, setupFocusNavigationListener } from "./utils/notifications";
import { onWindowShown, listenForDeepLinks } from "./utils/tauri";

// Components
import { Header, Sidebar, InputArea } from "./components/layout";
import { MessageList } from "./components/messages";
import { ToastContainer } from "./components/confirmation/ToastContainer";
import { HomePage } from "./components/home";
import { SkillsPage } from "./components/skills";
import { AutomationsPage } from "./components/automations";
import { McpToolsPage } from "./components/mcp-tools";
import { SettingsPage } from "./components/settings";
import { LoginPage } from "./components/auth";
import { FindInPage } from "./components/FindInPage";
import { getRandomBillingMessage } from "./components/billing";
import type { AutomationPendingConfirmation } from "./types/automations";

// Page types
type PageType = 'home' | 'chat' | 'skills' | 'automations' | 'mcp-tools' | 'settings';

type ChatPendingConfirmation = { runId: string; request: ConfirmationRequest };

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

    // Fetch platform URL on mount
    useEffect(() => {
        apiFetch('/api/auth/platform-url')
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data?.url) setPlatformUrl(data.url);
            })
            .catch(() => { /* Use default platform URL */ });
    }, []);

    // Core state
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isConnected, setIsConnected] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isStopped, setIsStopped] = useState(false);
    const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
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
        if (path === '/settings') return 'settings';
        return 'home';
    });

    // Multiple pending confirmations - queue per conversation (supports parallel tool calls)
    const [pendingConfirmations, setPendingConfirmations] = useState<Map<string, ChatPendingConfirmation[]>>(new Map());
    // Pending confirmations from automations
    const [automationConfirmations, setAutomationConfirmations] = useState<AutomationPendingConfirmation[]>([]);
    // Per-conversation state for tracking active tasks across all conversations
    const [conversationStates, setConversationStates] = useState<Map<string, ConversationState>>(new Map());
    // Find in page state
    const [showFindInPage, setShowFindInPage] = useState(false);
    // Billing alerts state
    const [billingAlerts, setBillingAlerts] = useState<BillingAlert[]>([]);
    const [platformUrl, setPlatformUrl] = useState<string>('https://platform.pipali.ai');

    // Refs
    const wsRef = useRef<WebSocket | null>(null);
    const prevConversationIdRef = useRef<string | undefined>(undefined);
    // Track current conversationId for WebSocket handler (avoids stale closure)
    const conversationIdRef = useRef<string | undefined>(undefined);
    const activeRunIdRef = useRef<string | undefined>(undefined);
    // Track pending background task message (sent before conversation_created is received)
    const pendingBackgroundMessageRef = useRef<{ message: string; clientMessageId: string; runId: string } | null>(null);
    // Track initial query from URL param (sent once when WebSocket connects or after history loads)
    const initialQueryRef = useRef<string | null>(
        new URLSearchParams(window.location.search).get('q')
    );
    // Track if we have a pending query that needs to wait for history to load
    const pendingQueryAfterHistoryRef = useRef<string | null>(null);
    // Track which conversation history has loaded (for query-param continuation races)
    const historyLoadedConversationIdRef = useRef<string | null>(null);
    const awaitingConversationIdRef = useRef(false);
    const pendingNewConversationMessagesRef = useRef<Array<{ clientMessageId: string; runId: string; message: string }>>([]);
    // Track pending confirmations for window-shown navigation (avoids stale closure)
    const pendingConfirmationsRef = useRef(pendingConfirmations);
    const automationConfirmationsRef = useRef<AutomationPendingConfirmation[]>([]);

    // Keep confirmation refs in sync with state (for window-shown handler)
    useEffect(() => {
        pendingConfirmationsRef.current = pendingConfirmations;
    }, [pendingConfirmations]);

    useEffect(() => {
        automationConfirmationsRef.current = automationConfirmations;
    }, [automationConfirmations]);

    useEffect(() => {
        activeRunIdRef.current = activeRunId;
    }, [activeRunId]);

    // Hooks
    const { textareaRef, scheduleTextareaFocus } = useFocusManagement();
    const { models, selectedModel, selectModel, showModelDropdown, setShowModelDropdown, refetchModels } = useModels();

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

    // Initialize native OS notifications and register click handler
    useEffect(() => {
        initNotifications();

        // Register click handler for web notifications (navigates to conversation)
        // This handler is also used by the focus navigation listener for Tauri notifications
        setNotificationClickHandler((convId) => {
            setCurrentPage('chat');
            setConversationId(convId);
            conversationIdRef.current = convId;
            scheduleTextareaFocus();
        });

        // Setup focus listener for Tauri notification click navigation workaround
        // When user clicks a Tauri notification, the app gains focus and this listener
        // will navigate to the pending conversation
        setupFocusNavigationListener();

        return () => {
            setNotificationClickHandler(null);
        };
    }, [scheduleTextareaFocus]);

    // Helper function to parse deep link URL and navigate to conversation
    const handleDeepLink = useCallback((url: string) => {
        // Parse pipali://chat/{conversationId} format
        const match = url.match(/^pipali:\/\/chat\/([a-zA-Z0-9-]+)/);
        if (match) {
            const convId = match[1];
            setCurrentPage('chat');
            setConversationId(convId);
            conversationIdRef.current = convId;
            scheduleTextareaFocus();
        }
    }, [scheduleTextareaFocus]);

    // Listen for deep link events from Tauri (external pipali:// URLs)
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        listenForDeepLinks(handleDeepLink).then((unlistenFn) => {
            unlisten = unlistenFn;
        });

        return () => {
            unlisten?.();
        };
    }, [handleDeepLink]);

    // Focus chat input and navigate to pending confirmations when window is shown via shortcut/tray (Tauri)
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        onWindowShown(() => {
            // Check for pending confirmations and navigate accordingly
            // Use refs to get current values (avoids stale closure issue)
            const chatConfirmations = pendingConfirmationsRef.current;
            const autoConfirmations = automationConfirmationsRef.current;

            const firstChatConfirmation = Array.from(chatConfirmations.entries())[0];
            if (firstChatConfirmation) {
                const [convId] = firstChatConfirmation;
                setCurrentPage('chat');
                setConversationId(convId);
                conversationIdRef.current = convId;
            } else if (autoConfirmations.length > 0 && autoConfirmations[0]?.conversationId) {
                // Navigate to the first automation's conversation
                setCurrentPage('chat');
                setConversationId(autoConfirmations[0].conversationId);
                conversationIdRef.current = autoConfirmations[0].conversationId;
            }
            scheduleTextareaFocus();
        }).then((unlistenFn) => {
            unlisten = unlistenFn;
        });

        return () => {
            unlisten?.();
        };
    }, [scheduleTextareaFocus]);

    // Keep conversationIdRef in sync with state (for WebSocket handler)
    useEffect(() => {
        conversationIdRef.current = conversationId;
    }, [conversationId]);

    // Global keyboard shortcut: Cmd/Ctrl+N for new chat
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
                e.preventDefault();
                // Update ref immediately to prevent WebSocket messages from old conversation
                conversationIdRef.current = undefined;
                setCurrentPage('chat');
                setConversationId(undefined);
                setMessages([]);
                setIsProcessing(false);
                setIsStopped(false);
                setActiveRunId(undefined);
                scheduleTextareaFocus();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [scheduleTextareaFocus]);

    // Focus textarea on various state changes
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

    const stopResearch = useCallback(() => {
        if (!isConnected || !isProcessing || !conversationId) return;

        const runId = activeRunIdRef.current;

        const markToolCallsInterrupted = (msgs: Message[]): Message[] => {
            return msgs.map(m => {
                if (m.role !== 'assistant' || !m.thoughts) return m;
                if (runId && m.stableId !== runId) return m;

                const hadPending = m.thoughts.some(t => t.type === 'tool_call' && t.isPending);
                if (!runId && !hadPending) return m;

                const updatedThoughts = m.thoughts.map(t => {
                    if (t.type === 'tool_call' && t.isPending) return { ...t, isPending: false, toolResult: '[interrupted]' };
                    return t;
                });

                return { ...m, thoughts: updatedThoughts, isStreaming: false };
            });
        };

        setIsProcessing(false);
        setIsStopped(true);
        setActiveRunId(undefined);

        // Clear any pending confirmations for this conversation.
        setPendingConfirmations(prev => {
            if (!prev.has(conversationId)) return prev;
            const next = new Map(prev);
            next.delete(conversationId);
            return next;
        });

        setMessages(prev => markToolCallsInterrupted(prev));

        setConversationStates(prev => {
            const next = new Map(prev);
            const existing = next.get(conversationId);
            if (existing) {
                next.set(conversationId, {
                    ...existing,
                    isProcessing: false,
                    isStopped: true,
                    messages: markToolCallsInterrupted(existing.messages),
                });
            }
            return next;
        });

        wsRef.current?.send(JSON.stringify({ type: 'stop', conversationId, runId }));
    }, [isConnected, isProcessing, conversationId]);

    // Global Escape key listener for stopping research
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isProcessing && isConnected && conversationId) {
                e.preventDefault();
                e.stopPropagation();
                stopResearch();
                textareaRef.current?.focus();
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [isProcessing, isConnected, conversationId, stopResearch]);

    // Global Cmd/Ctrl+F listener for find in page
    useEffect(() => {
        const handleFindShortcut = (e: KeyboardEvent) => {
            if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                setShowFindInPage(prev => !prev);
            }
        };

        window.addEventListener('keydown', handleFindShortcut);
        return () => window.removeEventListener('keydown', handleFindShortcut);
    }, []);

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
                const newConfirmations: AutomationPendingConfirmation[] = data.confirmations || [];

                // Notify for any new confirmations that weren't in the previous state
                setAutomationConfirmations(prev => {
                    const prevIds = new Set(prev.map(c => c.id));
                    for (const confirmation of newConfirmations) {
                        if (!prevIds.has(confirmation.id)) {
                            // New confirmation - send OS notification with conversation ID for navigation
                            notifyConfirmationRequest(
                                confirmation.request,
                                confirmation.automationName || 'Routine',
                                confirmation.conversationId ?? undefined
                            );
                        }
                    }
                    return newConfirmations;
                });
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
            } else {
                // If auth status check fails, default to requiring login
                console.error("Auth status check failed with status:", res.status);
                setAuthStatus({ anonMode: false, authenticated: false, user: null });
            }
        } catch (e) {
            // If we can't reach the server, default to requiring login
            console.error("Failed to fetch auth status", e);
            setAuthStatus({ anonMode: false, authenticated: false, user: null });
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
            historyLoadedConversationIdRef.current = null;
            const res = await apiFetch(`/api/chat/${id}/history`);
            if (!res.ok) return;
            const data = await res.json();
            const historyMessages: Message[] = [];
            let currentAgentMessage: Message | null = null;
            let thoughts: Thought[] = [];
            let firstAgentStepId: string | null = null;

            const finalizeCurrentAgent = () => {
                if (currentAgentMessage) {
                    if (thoughts.length > 0) {
                        currentAgentMessage.thoughts = thoughts;
                    }
                    historyMessages.push(currentAgentMessage);
                } else if (thoughts.length > 0) {
                    // Use the first agent step_id for orphaned thoughts so deletion works
                    const msgId = firstAgentStepId ?? generateUUID();
                    historyMessages.push({
                        role: 'assistant',
                        content: '',
                        thoughts: thoughts,
                        id: msgId,
                        stableId: msgId,
                    });
                }
                thoughts = [];
                currentAgentMessage = null;
                firstAgentStepId = null;
            };

            for (const msg of data.history) {
                if (msg.source === 'user') {
                    finalizeCurrentAgent();
                    historyMessages.push({
                        role: 'user',
                        content: typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message),
                        id: msg.step_id,
                        stableId: msg.step_id,
                    });
                }

                if (msg.source === 'agent') {
                    // Track first agent step_id for this message group (used for orphaned thoughts)
                    if (firstAgentStepId === null) {
                        firstAgentStepId = msg.step_id;
                    }
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
                            .map((res: any) => [res.source_call_id, typeof res.content === 'string' ? res.content : JSON.stringify(res.content)])
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
                            stableId: msg.step_id,
                        };
                    }
                }
            }

            finalizeCurrentAgent();
            setMessages(historyMessages);
            historyLoadedConversationIdRef.current = id;

            // Check if there's a pending query to send after history loaded
            const pendingQuery = pendingQueryAfterHistoryRef.current;
            if (pendingQuery && wsRef.current?.readyState === WebSocket.OPEN) {
                pendingQueryAfterHistoryRef.current = null;

                const clientMessageId = generateUUID();
                const runId = generateUUID();
                const userMsg: Message = { id: clientMessageId, stableId: clientMessageId, role: 'user', content: pendingQuery };
                setMessages(prev => [...prev, userMsg]);
                setIsProcessing(true);
                setIsStopped(false);
                setActiveRunId(undefined);
                wsRef.current.send(JSON.stringify({ type: 'message', message: pendingQuery, conversationId: id, clientMessageId, runId }));
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

        const sendPendingQueryForConversation = (conversationId: string) => {
            const pendingQuery = pendingQueryAfterHistoryRef.current;
            if (!pendingQuery) return;
            if (ws.readyState !== WebSocket.OPEN) return;

            pendingQueryAfterHistoryRef.current = null;
            const clientMessageId = generateUUID();
            const runId = generateUUID();
            const userMsg: Message = { id: clientMessageId, stableId: clientMessageId, role: 'user', content: pendingQuery };
            setMessages(prev => [...prev, userMsg]);
            setIsProcessing(true);
            setIsStopped(false);
            setActiveRunId(undefined);
            ws.send(JSON.stringify({ type: 'message', message: pendingQuery, conversationId, clientMessageId, runId }));
        };

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

                    // If history already loaded before the WebSocket connected, send immediately.
                    if (historyLoadedConversationIdRef.current === urlConversationId) {
                        sendPendingQueryForConversation(urlConversationId);
                    }
                } else {
                    // No conversationId, start fresh conversation immediately
                    const clientMessageId = generateUUID();
                    const runId = generateUUID();
                    const userMsg: Message = { id: clientMessageId, stableId: clientMessageId, role: 'user', content: initialQuery };
                    setMessages([userMsg]);
                    setIsProcessing(true);
                    setIsStopped(false);
                    setActiveRunId(undefined);
                    setCurrentPage('chat');
                    awaitingConversationIdRef.current = true;
                    ws.send(JSON.stringify({ type: 'message', message: initialQuery, clientMessageId, runId }));
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
                const message: ServerMessage = JSON.parse(event.data);
                handleWebSocketMessage(message);
            } catch (e) {
                console.error("Failed to parse message:", e);
            }
        };

        wsRef.current = ws;
    };

    const handleWebSocketMessage = (message: ServerMessage) => {
        const msgConversationId = 'conversationId' in message ? message.conversationId : undefined;

        if (message.type === 'billing_error') {
            const billingError = message.error as BillingError;
            console.warn("Billing error:", billingError);

            // Find conversation title for the alert
            const conversationTitle = conversations.find(c => c.id === msgConversationId)?.title;

            // Create billing alert
            const alert: BillingAlert = {
                id: generateUUID(),
                code: billingError.code,
                message: billingError.message,
                conversationId: msgConversationId,
                conversationTitle,
                source: 'chat', // TODO: detect automation source
                timestamp: new Date(),
                details: {
                    credits_balance_cents: billingError.credits_balance_cents,
                    current_period_spent_cents: billingError.current_period_spent_cents,
                    spend_hard_limit_cents: billingError.spend_hard_limit_cents,
                },
            };

            setBillingAlerts(prev => [alert, ...prev]);

            // Clear processing state for this conversation
            if (msgConversationId) {
                setConversationStates(prev => {
                    const next = new Map(prev);
                    next.delete(msgConversationId);
                    return next;
                });
            }

            // Show friendly message in current conversation's chat thread
            if (!msgConversationId || msgConversationId === conversationIdRef.current) {
                setIsProcessing(false);
                setIsStopped(false);
                setActiveRunId(undefined);
                const billingMsgId = generateUUID();
                const friendlyMessage = getRandomBillingMessage(billingError.code);
                setMessages(prev => [...prev, {
                    id: billingMsgId,
                    stableId: billingMsgId,
                    role: 'assistant',
                    content: '', // Content rendered via billingInfo
                    billingInfo: {
                        code: billingError.code,
                        message: friendlyMessage,
                    },
                }]);
            }
            return;
        }

        // All run/step lifecycle events are handled below.

        if (message.type === 'conversation_created') {
            const newConvId = message.conversationId;
            const isBackgroundTask = pendingBackgroundMessageRef.current !== null;
            const pendingMsg = pendingBackgroundMessageRef.current;
            const serverHistory = (message as any).history; // History from forked conversation
            pendingBackgroundMessageRef.current = null; // Clear the pending message

            // For background tasks, don't switch to the new conversation
            if (!isBackgroundTask) {
                // Update ref immediately so subsequent WebSocket messages are processed correctly
                // (avoids race condition where messages arrive before useEffect updates the ref)
                conversationIdRef.current = newConvId;
                awaitingConversationIdRef.current = false;
                setConversationId(newConvId);

                const queued = pendingNewConversationMessagesRef.current;
                pendingNewConversationMessagesRef.current = [];
                for (const qm of queued) {
                    wsRef.current?.send(JSON.stringify({
                        type: 'message',
                        message: qm.message,
                        conversationId: newConvId,
                        clientMessageId: qm.clientMessageId,
                        runId: qm.runId,
                    }));
                }
            }

            if (newConvId) {
                if (isBackgroundTask && pendingMsg) {
                    // For background task: parse history if present (forked conversation)
                    const historyMessages: Message[] = [];
                    if (serverHistory && Array.isArray(serverHistory)) {
                        // Parse history same way as fetchHistory does
                        let thoughts: Thought[] = [];
                        let currentAgentMessage: Message | null = null;

                        const finalizeAgent = () => {
                            if (currentAgentMessage) {
                                if (thoughts.length > 0) currentAgentMessage.thoughts = thoughts;
                                historyMessages.push(currentAgentMessage);
                            } else if (thoughts.length > 0) {
                                const msgId = generateUUID();
                                historyMessages.push({ role: 'assistant', content: '', thoughts, id: msgId, stableId: msgId });
                            }
                            thoughts = [];
                            currentAgentMessage = null;
                        };

                        for (const msg of serverHistory) {
                            if (msg.source === 'user') {
                                finalizeAgent();
                                const msgId = String(msg.step_id);
                                historyMessages.push({
                                    role: 'user',
                                    content: typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message),
                                    id: msgId,
                                    stableId: msgId,
                                });
                            }
                            if (msg.source === 'agent') {
                                const hasMessage = msg.message && msg.message.trim() !== '';
                                if (msg.reasoning_content) {
                                    thoughts.push({ type: 'thought', content: msg.reasoning_content, id: generateUUID(), isInternalThought: true });
                                }
                                const toolResultsMap = new Map(
                                    (msg.observation?.results || [])
                                        .filter((r: any) => r.source_call_id && r.content)
                                        .map((r: any) => [r.source_call_id, typeof r.content === 'string' ? r.content : JSON.stringify(r.content)])
                                );
                                if (msg.tool_calls?.length > 0) {
                                    if (hasMessage) thoughts.push({ type: 'thought', content: msg.message, id: generateUUID() });
                                    for (const tc of msg.tool_calls) {
                                        thoughts.push({
                                            type: 'tool_call', toolName: tc.function_name, toolArgs: tc.arguments,
                                            toolResult: toolResultsMap.get(tc.tool_call_id) as string | undefined,
                                            content: '', id: tc.tool_call_id,
                                        });
                                    }
                                } else if (hasMessage) {
                                    const msgId = String(msg.step_id);
                                    currentAgentMessage = { role: 'assistant', content: msg.message, id: msgId, stableId: msgId };
                                }
                            }
                        }
                        finalizeAgent();
                    }

                    const initialMessages: Message[] = [
                        ...historyMessages,
                        {
                            id: pendingMsg.clientMessageId,
                            stableId: pendingMsg.clientMessageId,
                            role: 'user' as const,
                            content: pendingMsg.message,
                        },
                    ];
                    setConversationStates(prevStates => {
                        const next = new Map(prevStates);
                        next.set(newConvId, {
                            isProcessing: true,
                            isStopped: false,
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
                                isStopped: false,
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

        if (message.type === 'user_step_saved') {
            const stepId = String(message.stepId);
            const targetConvId = message.conversationId;

            const updateUserMessageId = (msgs: Message[]): Message[] => {
                return msgs.map(msg => {
                    if (msg.role === 'user' && msg.id === message.clientMessageId) {
                        return { ...msg, id: stepId };
                    }
                    return msg;
                });
            };

            if (targetConvId === conversationIdRef.current) {
                setMessages(prev => updateUserMessageId(prev));
            }

            setConversationStates(prev => {
                const next = new Map(prev);
                const existing = next.get(targetConvId);
                if (existing) {
                    next.set(targetConvId, {
                        ...existing,
                        messages: updateUserMessageId(existing.messages),
                    });
                }
                return next;
            });
            return;
        }

        if (message.type === 'confirmation_request') {
            const confirmationData = message.data as ConfirmationRequest;
            const convId = message.conversationId;
            setPendingConfirmations(prev => {
                const next = new Map(prev);
                const existing = next.get(convId) || [];
                if (!existing.some(c => c.request.requestId === confirmationData.requestId)) {
                    next.set(convId, [...existing, { runId: message.runId, request: confirmationData }]);

                    const conv = conversations.find(c => c.id === convId);
                    notifyConfirmationRequest(confirmationData, conv?.title, convId);
                }
                return next;
            });
            return;
        }

        if (message.type === 'run_started') {
            const convId = message.conversationId;
            const runId = message.runId;

            const ensureAssistantForRun = (msgs: Message[]): Message[] => {
                if (msgs.some(m => m.role === 'assistant' && m.stableId === runId)) return msgs;

                const assistant: Message = {
                    id: runId,
                    stableId: runId,
                    role: 'assistant',
                    content: '',
                    thoughts: [],
                    isStreaming: true,
                };

                const idx = msgs.findIndex(m => m.role === 'user' && (m.id === message.clientMessageId || m.stableId === message.clientMessageId));
                if (idx === -1) return [...msgs, assistant];
                return [...msgs.slice(0, idx + 1), assistant, ...msgs.slice(idx + 1)];
            };

            if (convId === conversationIdRef.current) {
                setIsProcessing(true);
                setIsStopped(false);
                setActiveRunId(runId);
                setMessages(prev => ensureAssistantForRun(prev));
            }

            setConversationStates(prev => {
                const next = new Map(prev);
                const existing = next.get(convId);
                const existingMessages = existing?.messages || [];
                next.set(convId, {
                    isProcessing: true,
                    isStopped: false,
                    latestReasoning: existing?.latestReasoning,
                    messages: ensureAssistantForRun(existingMessages),
                });
                return next;
            });

            return;
        }

        if (message.type === 'step_start') {
            const convId = message.conversationId;
            const runId = message.runId;
            const { data } = message;

            const createPendingThoughts = (): Thought[] => {
                const newThoughts: Thought[] = [];
                if (data.message && data.toolCalls?.length > 0) {
                    newThoughts.push({ id: generateUUID(), type: 'thought', content: data.message });
                } else if (data.thought) {
                    newThoughts.push({ id: generateUUID(), type: 'thought', content: data.thought, isInternalThought: true });
                }

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
                const assistantIdx = msgs.findIndex(m => m.role === 'assistant' && m.stableId === runId);
                if (assistantIdx === -1) {
                    const assistant: Message = { id: runId, stableId: runId, role: 'assistant', content: '', thoughts: [], isStreaming: true };
                    return updateMessagesWithPendingThoughts([...msgs, assistant]);
                }

                const assistant = msgs[assistantIdx];
                if (!assistant) return msgs;
                const newThoughts = createPendingThoughts();
                const updatedAssistant: Message = { ...assistant, thoughts: [...(assistant.thoughts || []), ...newThoughts] };
                return msgs.map((m, idx) => (idx === assistantIdx ? updatedAssistant : m));
            };

            if (convId === conversationIdRef.current) {
                setMessages(prev => updateMessagesWithPendingThoughts(prev));
            }

            setConversationStates(prev => {
                const next = new Map(prev);
                const existing = next.get(convId);
                const existingMessages = existing?.messages || [];

                let newReasoning: string | undefined;
                if (data.message && data.toolCalls?.length > 0) {
                    newReasoning = data.message;
                } else if (data.thought) {
                    newReasoning = data.thought;
                } else if (data.toolCalls?.length > 0) {
                    newReasoning = formatToolCallsForSidebar(data.toolCalls);
                }

                next.set(convId, {
                    isProcessing: true,
                    isStopped: false,
                    latestReasoning: newReasoning || existing?.latestReasoning,
                    messages: updateMessagesWithPendingThoughts(existingMessages),
                });
                return next;
            });

            return;
        }

        if (message.type === 'step_end') {
            const convId = message.conversationId;
            const runId = message.runId;
            const { data } = message;

            const updateMessagesWithResults = (msgs: Message[]): Message[] => {
                const assistantIdx = msgs.findIndex(m => m.role === 'assistant' && m.stableId === runId);
                if (assistantIdx === -1) return msgs;
                const assistant = msgs[assistantIdx];
                if (!assistant) return msgs;
                const updatedThoughts = (assistant.thoughts || []).map(thought => {
                    if (thought.type === 'tool_call' && thought.isPending) {
                        const toolResult = data.toolResults?.find(tr => tr.source_call_id === thought.id)?.content;
                        if (toolResult !== undefined) {
                            const matchingToolContent = typeof toolResult !== 'string' ? JSON.stringify(toolResult) : toolResult;
                            return { ...thought, toolResult: matchingToolContent, isPending: false };
                        }
                    }
                    return thought;
                });
                const updatedAssistant: Message = { ...assistant, thoughts: updatedThoughts };
                return msgs.map((m, idx) => (idx === assistantIdx ? updatedAssistant : m));
            };

            if (convId === conversationIdRef.current) {
                setMessages(prev => updateMessagesWithResults(prev));
            }

            setConversationStates(prev => {
                const next = new Map(prev);
                const existing = next.get(convId);
                if (!existing) return next;

                let newReasoning: string | undefined;
                if (data.message && data.toolCalls?.length > 0) {
                    newReasoning = data.message;
                } else if (data.thought) {
                    newReasoning = data.thought;
                } else if (data.toolCalls?.length > 0) {
                    newReasoning = formatToolCallsForSidebar(data.toolCalls);
                }

                next.set(convId, {
                    ...existing,
                    latestReasoning: newReasoning || existing.latestReasoning,
                    messages: updateMessagesWithResults(existing.messages),
                });
                return next;
            });
            return;
        }

        if (message.type === 'run_stopped') {
            const convId = message.conversationId;
            const runId = message.runId;

            const markToolCallsInterrupted = (msgs: Message[]): Message[] => {
                return msgs.map(m => {
                    if (m.role !== 'assistant' || m.stableId !== runId || !m.thoughts) return m;
                    const updatedThoughts = m.thoughts.map(t => {
                        if (t.type === 'tool_call' && t.isPending) return { ...t, isPending: false, toolResult: '[interrupted]' };
                        return t;
                    });
                    return { ...m, thoughts: updatedThoughts, isStreaming: false };
                });
            };

            // A stopped run cannot still be awaiting confirmation; clear any pending confirmations tied to this run.
            setPendingConfirmations(prev => {
                const existing = prev.get(convId);
                if (!existing || existing.length === 0) return prev;

                const remaining = existing.filter(c => c.runId !== runId);
                if (remaining.length === existing.length) return prev;

                const next = new Map(prev);
                if (remaining.length === 0) next.delete(convId);
                else next.set(convId, remaining);
                return next;
            });

            if (convId === conversationIdRef.current) {
                setIsProcessing(false);
                setActiveRunId(undefined);
                setIsStopped(message.reason === 'user_stop');
                setMessages(prev => markToolCallsInterrupted(prev));
            }

            setConversationStates(prev => {
                const next = new Map(prev);
                const existing = next.get(convId);
                if (!existing) return next;
                next.set(convId, {
                    ...existing,
                    isProcessing: false,
                    isStopped: message.reason === 'user_stop',
                    messages: markToolCallsInterrupted(existing.messages),
                });
                return next;
            });

            if (message.reason === 'error' && message.error && convId === conversationIdRef.current) {
                const errMsgId = generateUUID();
                setMessages(prev => [
                    ...prev,
                    { id: errMsgId, stableId: errMsgId, role: 'assistant', content: `Error: ${message.error}` },
                ]);
            }

            return;
        }

        if (message.type === 'run_complete') {
            const convId = message.conversationId;
            const runId = message.runId;
            const response = message.data.response;
            const messageId = String(message.data.stepId);

            setBillingAlerts([]);

            const finalizeMessages = (msgs: Message[]): Message[] => {
                const filteredMsgs = msgs.filter(msg => !msg.billingInfo);
                const assistantIdx = filteredMsgs.findIndex(m => m.role === 'assistant' && m.stableId === runId);
                if (assistantIdx === -1) {
                    return [
                        ...filteredMsgs,
                        { id: messageId, stableId: runId, role: 'assistant', content: response, isStreaming: false },
                    ];
                }
                return filteredMsgs.map((m, idx) => {
                    if (idx !== assistantIdx) return m;
                    return { ...m, id: messageId, content: response, isStreaming: false };
                });
            };

            if (convId === conversationIdRef.current) {
                setIsProcessing(false);
                setIsStopped(false);
                setActiveRunId(undefined);
                setMessages(prev => finalizeMessages(prev));
            }

            setConversationStates(prev => {
                const next = new Map(prev);
                const existing = next.get(convId);
                const existingMessages = existing?.messages || [];

                const userRequest = existingMessages.filter(m => m.role === 'user').pop()?.content;
                notifyTaskComplete(userRequest, response, convId);

                next.set(convId, {
                    isProcessing: false,
                    isStopped: false,
                    latestReasoning: existing?.latestReasoning,
                    messages: finalizeMessages(existingMessages),
                });
                return next;
            });

            setPendingConfirmations(prev => {
                const next = new Map(prev);
                next.delete(convId);
                return next;
            });

            fetchConversations();
            return;
        }
    };

    // ===== Conversation Actions =====

    // Derive active tasks from conversationStates for home page display
    const getActiveTasks = (): ActiveTask[] => {
        const activeTasks: ActiveTask[] = [];

        conversationStates.forEach((state, convId) => {
            if (state.isProcessing || state.isStopped) {
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
                    isStopped: state.isStopped,
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
        setIsStopped(false);
        setActiveRunId(undefined);

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
        setIsStopped(false);
        setActiveRunId(undefined);

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
        setIsStopped(false);
        setActiveRunId(undefined);

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
        setIsStopped(false);
        setActiveRunId(undefined);

        // Update URL to /tools
        window.history.pushState({}, '', '/tools');
    };

    const goToSettingsPage = () => {
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

        setCurrentPage('settings');
        setConversationId(undefined);
        setMessages([]);
        setIsProcessing(false);
        setIsStopped(false);
        setActiveRunId(undefined);

        // Update URL to /settings
        window.history.pushState({}, '', '/settings');
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
        setIsStopped(convState?.isStopped ?? false);
        setActiveRunId(undefined);

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
        setIsStopped(false);
        setActiveRunId(undefined);
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

    const sendConfirmationResponse = (convId: string, requestId: string, optionId: string, guidance?: string) => {
        const queue = pendingConfirmations.get(convId);
        const pendingConfirmation = queue?.find(c => c.request.requestId === requestId);
        if (!pendingConfirmation || !isConnected) return;

        const response = {
            type: 'confirmation_response',
            conversationId: convId,
            runId: pendingConfirmation.runId,
            data: {
                requestId,
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
            const remainingQueue = existingQueue.filter(c => c.request.requestId !== requestId);
            if (remainingQueue.length > 0) {
                next.set(convId, remainingQueue);
            } else {
                next.delete(convId);
            }
            return next;
        });
    };

    const sendCurrentConfirmationResponse = (optionId: string, guidance?: string) => {
        if (!conversationId) return;
        const pending = pendingConfirmations.get(conversationId)?.[0];
        if (!pending) return;
        sendConfirmationResponse(conversationId, pending.request.requestId, optionId, guidance);
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
            for (const item of queue) {
                chatConfirmations.push(toChatConfirmation(convId, item.request, convTitle));
            }
        }
        const automationConfirmationsList = automationConfirmations.map(toAutomationConfirmation);
        return [...chatConfirmations, ...automationConfirmationsList];
    }, [pendingConfirmations, automationConfirmations, conversations, toChatConfirmation, toAutomationConfirmation]);

    const sidebarPendingConfirmations = useMemo((): Map<string, ConfirmationRequest[]> => {
        const next = new Map<string, ConfirmationRequest[]>();
        for (const [convId, queue] of pendingConfirmations.entries()) {
            next.set(convId, queue.map(item => item.request));
        }
        return next;
    }, [pendingConfirmations]);

    // Confirmation response handler
    const handleConfirmationResponse = (confirmation: PendingConfirmation, optionId: string, guidance?: string) => {
        if (confirmation.source.type === 'chat') {
            sendConfirmationResponse(confirmation.source.conversationId, confirmation.request.requestId, optionId, guidance);
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
                const remainingQueue = existingQueue.filter(c => c.request.requestId !== confirmation.request.requestId);
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

        const messageText = input.trim();
        setInput("");

        if (conversationId) {
            setPendingConfirmations(prev => {
                const next = new Map(prev);
                next.delete(conversationId);
                return next;
            });
        }

        const clientMessageId = generateUUID();
        const runId = generateUUID();
        const userMsg: Message = { id: clientMessageId, stableId: clientMessageId, role: 'user', content: messageText };

        setIsProcessing(true);
        setIsStopped(false);
        setCurrentPage('chat');

        setMessages(prev => [...prev, userMsg]);

        if (conversationId) {
            setConversationStates(prevStates => {
                const next = new Map(prevStates);
                const existing = next.get(conversationId);
                const existingMessages = existing?.messages || [];
                next.set(conversationId, {
                    isProcessing: true,
                    isStopped: false,
                    latestReasoning: existing?.latestReasoning,
                    messages: [...existingMessages, userMsg],
                });
                return next;
            });
        }

        if (!conversationId && awaitingConversationIdRef.current) {
            pendingNewConversationMessagesRef.current.push({ clientMessageId, runId, message: messageText });
            scheduleTextareaFocus();
            return;
        }

        if (!conversationId) {
            awaitingConversationIdRef.current = true;
        }

        wsRef.current?.send(JSON.stringify({ type: 'message', message: messageText, conversationId, clientMessageId, runId }));
        scheduleTextareaFocus();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // Send message as a new background task (Cmd/Ctrl+Enter)
    const sendAsBackgroundTask = () => {
        if (!input.trim() || !isConnected) return;

        const userMsg = input.trim();
        setInput("");

        // Store pending message to associate when conversation_created arrives
        const clientMessageId = generateUUID();
        const runId = generateUUID();
        pendingBackgroundMessageRef.current = { message: userMsg, clientMessageId, runId };

        // If we have a conversationId, fork it (includes chat history)
        // Otherwise, create a new conversation from scratch
        if (conversationId) {
            wsRef.current?.send(JSON.stringify({
                type: 'fork',
                message: userMsg,
                sourceConversationId: conversationId,
                clientMessageId,
                runId,
            }));
        } else {
            // No conversationId - create new conversation from scratch
            wsRef.current?.send(JSON.stringify({ type: 'message', message: userMsg, clientMessageId, runId }));
        }

        scheduleTextareaFocus();
    };

    // ===== Render =====

    // Handle successful login - refetch auth status and models
    const handleLoginSuccess = useCallback(async () => {
        await fetchAuthStatus();
        // Refetch models after a delay to allow server sync to complete
        setTimeout(() => refetchModels(), 3000);
    }, [refetchModels]);

    // Show loading state while fetching auth status
    // This prevents showing the home screen before we know if user needs to login
    if (authStatus === null) {
        return (
            <div className="app-wrapper">
                <div className="app-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
                    <div style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                        Loading...
                    </div>
                </div>
            </div>
        );
    }

    // Show login page if not authenticated and not in anonymous mode
    if (!authStatus.authenticated && !authStatus.anonMode) {
        return <LoginPage onLoginSuccess={handleLoginSuccess} />;
    }

    return (
        <div className="app-wrapper">
            <Sidebar
                isOpen={sidebarOpen}
                conversations={conversations}
                conversationStates={conversationStates}
                pendingConfirmations={sidebarPendingConfirmations}
                currentConversationId={conversationId}
                exportingConversationId={exportingConversationId}
                currentPage={currentPage}
                authStatus={authStatus}
                billingAlerts={billingAlerts}
                platformUrl={platformUrl}
                onNewChat={startNewConversation}
                onSelectConversation={selectConversation}
                onDeleteConversation={deleteConversation}
                onExportConversation={exportConversationAsATIF}
                onGoToSkills={goToSkillsPage}
                onGoToAutomations={goToAutomationsPage}
                onGoToMcpTools={goToMcpToolsPage}
                onGoToSettings={goToSettingsPage}
                onLogout={handleLogout}
                onClose={() => setSidebarOpen(false)}
                onDismissAllBillingAlerts={() => setBillingAlerts([])}
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
                {currentPage === 'settings' && (
                    <SettingsPage />
                )}
                {currentPage === 'chat' && (
                    <MessageList messages={messages} conversationId={conversationId} platformUrl={platformUrl} onDeleteMessage={deleteMessage} />
                )}

                <InputArea
                    input={input}
                    onInputChange={setInput}
                    onSubmit={sendMessage}
                    onKeyDown={handleKeyDown}
                    isConnected={isConnected}
                    isProcessing={isProcessing}
                    isStopped={isStopped}
                    conversationId={conversationId}
                    onStop={stopResearch}
                    pendingConfirmation={conversationId ? pendingConfirmations.get(conversationId)?.[0]?.request : undefined}
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


            <FindInPage
                isOpen={showFindInPage}
                onClose={() => setShowFindInPage(false)}
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
