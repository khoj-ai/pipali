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
} from "./types";
import type { PendingConfirmation } from "./types/confirmation";

// Hooks
import { useFocusManagement, useModels, useSidecar, useWebSocketChat } from "./hooks";

// Utils
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
    const [input, setInput] = useState("");
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

    // Pending confirmations from automations
    const [automationConfirmations, setAutomationConfirmations] = useState<AutomationPendingConfirmation[]>([]);
    // Find in page state
    const [showFindInPage, setShowFindInPage] = useState(false);
    // Billing alerts state
    const [billingAlerts, setBillingAlerts] = useState<BillingAlert[]>([]);
    const [platformUrl, setPlatformUrl] = useState<string>('https://platform.pipali.ai');

    // Refs
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
    const pendingConfirmationsRef = useRef<Map<string, { runId: string; request: ConfirmationRequest }[]>>(new Map());
    const automationConfirmationsRef = useRef<AutomationPendingConfirmation[]>([]);
    const conversationsRef = useRef<ConversationSummary[]>([]);
    const conversationStatesRef = useRef<Map<string, ConversationState>>(new Map());
    const messagesRef = useRef<Message[]>([]);

    useEffect(() => {
        automationConfirmationsRef.current = automationConfirmations;
    }, [automationConfirmations]);

    useEffect(() => {
        conversationsRef.current = conversations;
    }, [conversations]);

    // Hooks
    const { textareaRef, scheduleTextareaFocus } = useFocusManagement();
    const { models, selectedModel, selectModel, showModelDropdown, setShowModelDropdown, refetchModels } = useModels();
    const wsUrl = `${wsBaseUrl}/ws/chat`;

    const {
        isConnected,
        conversationId,
        messages,
        isProcessing,
        isStopped,
        currentRunId: activeRunId,
        conversationStates,
        pendingConfirmations,
        sendMessage: sendWsMessage,
        addOptimisticUserMessage,
        startOptimisticRun,
        stop,
        respondToConfirmation,
        fork,
        setConversationId: setChatConversationId,
        setMessages: setChatMessages,
        clearConversation,
        syncConversationState,
        removeConversationState,
        clearConfirmations,
        dismissConfirmation,
    } = useWebSocketChat({
        wsUrl,
        shouldActivateConversationOnCreate: () => pendingBackgroundMessageRef.current === null,
        onConversationCreated: () => {
            // Refresh list so sidebar picks up new conversations quickly.
            fetchConversations();
            // Clear background marker (if any) once the server has created the conversation.
            pendingBackgroundMessageRef.current = null;
        },
        onConfirmationRequest: (request, convId) => {
            const conv = conversationsRef.current.find(c => c.id === convId);
            notifyConfirmationRequest(request, conv?.title, convId);
        },
        onTaskComplete: (_request, response, convId) => {
            const state = conversationStatesRef.current.get(convId);
            const userRequest = state?.messages.filter(m => m.role === 'user').pop()?.content;
            notifyTaskComplete(userRequest, response, convId);
            setBillingAlerts([]);
            fetchConversations();
        },
        onBillingError: (billingError, convId) => {
            console.warn("Billing error:", billingError);

            const conversationTitle = convId ? conversationsRef.current.find(c => c.id === convId)?.title : undefined;
            const alert: BillingAlert = {
                id: generateUUID(),
                code: billingError.code,
                message: billingError.message,
                conversationId: convId,
                conversationTitle,
                source: 'chat',
                timestamp: new Date(),
                details: {
                    credits_balance_cents: billingError.credits_balance_cents,
                    current_period_spent_cents: billingError.current_period_spent_cents,
                    spend_hard_limit_cents: billingError.spend_hard_limit_cents,
                },
            };
            setBillingAlerts(prev => [alert, ...prev]);

            if (convId) {
                removeConversationState(convId);
            }

            if (!convId || convId === conversationIdRef.current) {
                const billingMsgId = generateUUID();
                const friendlyMessage = getRandomBillingMessage(billingError.code);
                const next = [
                    ...messagesRef.current,
                    {
                        id: billingMsgId,
                        stableId: billingMsgId,
                        role: 'assistant' as const,
                        content: '',
                        billingInfo: { code: billingError.code, message: friendlyMessage },
                    },
                ];
                setChatMessages(next);
                if (convId) syncConversationState(convId, next);
            }
        },
        onError: (error, convId) => {
            if (convId && convId === conversationIdRef.current) {
                const errMsgId = generateUUID();
                const next = [...messagesRef.current, { id: errMsgId, stableId: errMsgId, role: 'assistant' as const, content: `Error: ${error}` }];
                setChatMessages(next);
                syncConversationState(convId, next);
            }
        },
    });

    useEffect(() => {
        conversationStatesRef.current = conversationStates;
    }, [conversationStates]);

    useEffect(() => {
        pendingConfirmationsRef.current = pendingConfirmations;
    }, [pendingConfirmations]);

    useEffect(() => {
        activeRunIdRef.current = activeRunId;
    }, [activeRunId]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    // Initialize WebSocket and fetch data
    useEffect(() => {
        fetchConversations();
        fetchAutomationConfirmations();
        fetchAuthStatus();

        // Check URL for conversationId
        const params = new URLSearchParams(window.location.search);
        const cid = params.get('conversationId');
        if (cid) {
            setChatConversationId(cid);
        }

        // Poll for automation confirmations every 30 seconds
        const pollInterval = setInterval(fetchAutomationConfirmations, 30000);

        return () => {
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
            setChatConversationId(convId);
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
            setChatConversationId(convId);
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
            // Refetch conversations when window is shown (ensures data is loaded after sidecar is ready)
            fetchConversations();

            // Check for pending confirmations and navigate accordingly
            // Use refs to get current values (avoids stale closure issue)
            const chatConfirmations = pendingConfirmationsRef.current;
            const autoConfirmations = automationConfirmationsRef.current;

            const firstChatConfirmation = Array.from(chatConfirmations.entries())[0];
            if (firstChatConfirmation) {
                const [convId] = firstChatConfirmation;
                setCurrentPage('chat');
                setChatConversationId(convId);
                conversationIdRef.current = convId;
            } else if (autoConfirmations.length > 0 && autoConfirmations[0]?.conversationId) {
                // Navigate to the first automation's conversation
                setCurrentPage('chat');
                setChatConversationId(autoConfirmations[0].conversationId);
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
                setCurrentPage('chat');
                conversationIdRef.current = undefined;
                clearConversation();
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

        // Skip fetching if this is just a new conversation getting its ID assigned
        // and we already have optimistic messages in memory.
        const isNewConversationGettingId = prevId === undefined && conversationId !== undefined;
        if (isNewConversationGettingId && messages.length > 0) {
            syncConversationState(conversationId, messages);
            prevConversationIdRef.current = conversationId;
            return;
        }

        if (conversationId) {
            const convState = conversationStates.get(conversationId);
            if (convState?.messages && convState.messages.length > 0) {
                setChatMessages(convState.messages);
            } else {
                fetchHistory(conversationId);
            }
        }

        prevConversationIdRef.current = conversationId;
    }, [conversationId]);

    const stopResearch = useCallback(() => {
        if (!isConnected || !isProcessing || !conversationId) return;

        stop(conversationId, activeRunIdRef.current, { optimistic: true, reason: 'user_stop' });
    }, [isConnected, isProcessing, conversationId, stop]);

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
            setChatMessages(historyMessages);
            syncConversationState(id, historyMessages);
            historyLoadedConversationIdRef.current = id;

            // Check if there's a pending query to send after history loaded
            sendPendingQueryForConversation(id);
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

    // ===== Chat Runtime (WebSocket via hook) =====

    const sendPendingQueryForConversation = useCallback((conversationId: string) => {
        const pendingQuery = pendingQueryAfterHistoryRef.current;
        if (!pendingQuery) return;
        if (!isConnected) return;

        pendingQueryAfterHistoryRef.current = null;
        setCurrentPage('chat');
        setChatConversationId(conversationId);
        clearConfirmations(conversationId);

        sendWsMessage(pendingQuery, conversationId);
    }, [isConnected, sendWsMessage, setChatConversationId, clearConfirmations]);

    useEffect(() => {
        if (!isConnected) return;
        const initialQuery = initialQueryRef.current;
        if (!initialQuery) return;
        initialQueryRef.current = null;

        const url = new URL(window.location.href);
        url.searchParams.delete('q');
        window.history.replaceState({}, '', url);

        const urlConversationId = new URLSearchParams(window.location.search).get('conversationId') || undefined;
        setCurrentPage('chat');

        if (urlConversationId) {
            pendingQueryAfterHistoryRef.current = initialQuery;
            if (historyLoadedConversationIdRef.current === urlConversationId) {
                sendPendingQueryForConversation(urlConversationId);
            }
            return;
        }

        clearConversation();
        awaitingConversationIdRef.current = true;
        sendWsMessage(initialQuery);
    }, [isConnected, clearConversation, sendWsMessage, sendPendingQueryForConversation]);

    useEffect(() => {
        if (!conversationId) return;
        if (!awaitingConversationIdRef.current) return;

        awaitingConversationIdRef.current = false;
        const queued = pendingNewConversationMessagesRef.current;
        pendingNewConversationMessagesRef.current = [];
        for (const qm of queued) {
            sendWsMessage(qm.message, conversationId, {
                clientMessageId: qm.clientMessageId,
                runId: qm.runId,
                optimistic: false,
            });
        }
    }, [conversationId, sendWsMessage]);

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
        if (conversationId) {
            syncConversationState(conversationId, messages);
        }
        conversationIdRef.current = undefined;

        setCurrentPage('home');
        clearConversation();

        // Update URL to root
        window.history.pushState({}, '', '/');
    };

    const goToSkillsPage = () => {
        if (conversationId) {
            syncConversationState(conversationId, messages);
        }

        setCurrentPage('skills');
        clearConversation();

        // Update URL to /skills
        window.history.pushState({}, '', '/skills');
    };

    const goToAutomationsPage = () => {
        if (conversationId) {
            syncConversationState(conversationId, messages);
        }

        setCurrentPage('automations');
        clearConversation();

        // Update URL to /automations
        window.history.pushState({}, '', '/automations');
    };

    const goToMcpToolsPage = () => {
        if (conversationId) {
            syncConversationState(conversationId, messages);
        }

        setCurrentPage('mcp-tools');
        clearConversation();

        // Update URL to /tools
        window.history.pushState({}, '', '/tools');
    };

    const goToSettingsPage = () => {
        if (conversationId) {
            syncConversationState(conversationId, messages);
        }

        setCurrentPage('settings');
        clearConversation();

        // Update URL to /settings
        window.history.pushState({}, '', '/settings');
    };

    const selectConversation = (id: string) => {
        setCurrentPage('chat');
        if (conversationId) {
            syncConversationState(conversationId, messages);
        }
        conversationIdRef.current = id;
        setChatConversationId(id);
        const convState = conversationStates.get(id);
        if (convState?.messages && convState.messages.length > 0) setChatMessages(convState.messages);
        else fetchHistory(id);
    };

    const startNewConversation = () => {
        conversationIdRef.current = undefined;
        awaitingConversationIdRef.current = false;
        pendingNewConversationMessagesRef.current = [];

        setCurrentPage('chat');
        clearConversation();
    };

    const deleteConversation = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            const res = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setConversations(prev => prev.filter(c => c.id !== id));
                removeConversationState(id);
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
                const next = messages.filter(m => m.id !== messageId);
                setChatMessages(next);
                syncConversationState(conversationId, next);
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
        respondToConfirmation(convId, pendingConfirmation.runId, requestId, optionId, guidance);
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
            dismissConfirmation(source.conversationId, confirmation.request.requestId);
        } else {
            dismissAutomationConfirmation(source.confirmationId);
        }
    };

    const sendMessage = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!isConnected) return;

        const rawValue = textareaRef.current?.value ?? input;
        const messageText = rawValue.trim();
        if (!messageText) return;
        setInput("");

        if (conversationId) clearConfirmations(conversationId);

        const clientMessageId = generateUUID();
        const runId = generateUUID();
        const userMsg: Message = { id: clientMessageId, stableId: clientMessageId, role: 'user', content: messageText };

        setCurrentPage('chat');

        if (!conversationId && awaitingConversationIdRef.current) {
            addOptimisticUserMessage(userMsg);
            startOptimisticRun(undefined, runId, clientMessageId);
            pendingNewConversationMessagesRef.current.push({ clientMessageId, runId, message: messageText });
            scheduleTextareaFocus();
            return;
        }

        if (!conversationId) {
            awaitingConversationIdRef.current = true;
        }
        sendWsMessage(messageText, conversationId, { clientMessageId, runId, optimistic: true });
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
        if (!isConnected) return;

        const rawValue = textareaRef.current?.value ?? input;
        const userMsg = rawValue.trim();
        if (!userMsg) return;
        setInput("");

        // Store pending message to associate when conversation_created arrives
        const clientMessageId = generateUUID();
        const runId = generateUUID();
        pendingBackgroundMessageRef.current = { message: userMsg, clientMessageId, runId };

        // If we have a conversationId, fork it (includes chat history)
        // Otherwise, create a new conversation from scratch
        if (conversationId) {
            fork(userMsg, conversationId);
        } else {
            // No conversationId - create new conversation from scratch
            sendWsMessage(userMsg, undefined, { clientMessageId, runId, optimistic: false });
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
