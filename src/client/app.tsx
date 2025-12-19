/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import React, { useState, useEffect, useRef } from "react";
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
} from "./types";

// Hooks
import { useFocusManagement, useModels } from "./hooks";

// Utils
import { formatToolCallsForSidebar } from "./utils/formatting";

// Components
import { Header, Sidebar, InputArea } from "./components/layout";
import { MessageList } from "./components/messages";
import { ToastContainer } from "./components/confirmation";

const App = () => {
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

    // Multiple pending confirmations - one per conversation
    const [pendingConfirmations, setPendingConfirmations] = useState<Map<string, ConfirmationRequest>>(new Map());
    // Per-conversation state for tracking active tasks across all conversations
    const [conversationStates, setConversationStates] = useState<Map<string, ConversationState>>(new Map());

    // Refs
    const wsRef = useRef<WebSocket | null>(null);
    const prevConversationIdRef = useRef<string | undefined>(undefined);

    // Hooks
    const { textareaRef, scheduleTextareaFocus } = useFocusManagement();
    const { models, selectedModel, selectModel, showModelDropdown, setShowModelDropdown } = useModels();

    // Initialize WebSocket and fetch data
    useEffect(() => {
        connectWebSocket();
        fetchConversations();

        // Check URL for conversationId
        const params = new URLSearchParams(window.location.search);
        const cid = params.get('conversationId');
        if (cid) {
            setConversationId(cid);
        }

        return () => {
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, []);

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

        // Update URL
        if (conversationId) {
            const url = new URL(window.location.href);
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
            const res = await fetch('/api/conversations');
            if (res.ok) {
                const data = await res.json();
                setConversations(data.conversations);
            }
        } catch (e) {
            console.error("Failed to fetch conversations", e);
        }
    };

    const fetchHistory = async (id: string) => {
        try {
            const res = await fetch(`/api/chat/${id}/history`);
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
                        id: crypto.randomUUID(),
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
                            id: crypto.randomUUID(),
                            isInternalThought: true,
                        });
                    }

                    if (msg.observation && msg.observation.results) {
                        toolResultsMap = new Map(
                            msg.observation.results
                            .filter((res: any) => res.source_call_id && res.content)
                            .map((res: any) => [res.source_call_id, res.content])
                        );

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
                    }

                    if (hasMessage) {
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
            const res = await fetch(`/api/conversations/${id}/export/atif`);
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
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/chat`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log("Connected to WebSocket");
            setIsConnected(true);
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
            if (!msgConversationId || msgConversationId === conversationId) {
                setIsProcessing(false);
                setIsPaused(false);
                setMessages(prev => [...prev, {
                    id: crypto.randomUUID(),
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
                            id: crypto.randomUUID(),
                            role: 'assistant' as const,
                            content: '',
                            isStreaming: true,
                            thoughts: [],
                        }];
                    }
                    next.set(msgConversationId, {
                        isProcessing: true,
                        isPaused: false,
                        latestReasoning: existing?.latestReasoning,
                        messages: msgs,
                    });
                    return next;
                });
            }
            if (!msgConversationId || msgConversationId === conversationId) {
                setIsProcessing(true);
                setIsPaused(false);
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
            if (!msgConversationId || msgConversationId === conversationId) {
                setIsPaused(true);
            }
            return;
        }

        if (message.type === 'conversation_created') {
            const newConvId = message.conversationId;
            setConversationId(newConvId);
            if (newConvId) {
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
                    return currentMessages;
                });
            }
            fetchConversations();
            return;
        }

        if (message.type === 'confirmation_request') {
            const confirmationData = message.data as ConfirmationRequest;
            if (msgConversationId) {
                setPendingConfirmations(prev => {
                    const next = new Map(prev);
                    next.set(msgConversationId, confirmationData);
                    return next;
                });
            }
            return;
        }

        if (message.type === 'iteration') {
            const { data } = message;

            const createThoughts = (): Thought[] => {
                const newThoughts: Thought[] = [];
                if (data.message && data.toolCalls) {
                    newThoughts.push({
                        id: crypto.randomUUID(),
                        type: 'thought',
                        content: data.message,
                    });
                } else if (data.thought) {
                    newThoughts.push({
                        id: crypto.randomUUID(),
                        type: 'thought',
                        content: data.thought,
                        isInternalThought: true,
                    });
                }

                if (data.toolCalls && Array.isArray(data.toolCalls)) {
                    for (const toolCall of data.toolCalls) {
                        const toolResult = data.toolResults?.find(
                            (tr: any) => tr.source_call_id === toolCall.tool_call_id
                        )?.content;
                        const matchingToolContent = !!toolResult && typeof toolResult !== 'string' ? JSON.stringify(toolResult) : toolResult;

                        newThoughts.push({
                            id: toolCall.tool_call_id || crypto.randomUUID(),
                            type: 'tool_call',
                            content: '',
                            toolName: toolCall.function_name,
                            toolArgs: toolCall.arguments,
                            toolResult: matchingToolContent,
                        });
                    }
                }

                return newThoughts;
            };

            const updateMessagesWithThoughts = (msgs: Message[]): Message[] => {
                const lastMsg = msgs[msgs.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                    const newThoughts = createThoughts();
                    return msgs.map(msg =>
                        msg.id === lastMsg.id
                            ? { ...msg, thoughts: [...(msg.thoughts || []), ...newThoughts] }
                            : msg
                    );
                }
                return msgs;
            };

            const isCurrentConversation = !msgConversationId || msgConversationId === conversationId || !conversationId;

            if (isCurrentConversation) {
                setMessages(prev => updateMessagesWithThoughts(prev));
            }

            const targetConvId = msgConversationId || conversationId;
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
                        isPaused: false,
                        latestReasoning: newReasoning || existing?.latestReasoning,
                        messages: updateMessagesWithThoughts(existingMessages),
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
                    id: crypto.randomUUID(),
                    role: 'assistant' as const,
                    content: data.response,
                    isStreaming: false,
                }];
            };

            const isCurrentConversation = !completedConvId || completedConvId === conversationId || !conversationId;

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

    const selectConversation = (id: string) => {
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

        setConversationId(id);
        const convState = conversationStates.get(id);
        setIsProcessing(convState?.isProcessing ?? false);
        setIsPaused(convState?.isPaused ?? false);

        if (convState?.messages && convState.messages.length > 0) {
            setMessages(convState.messages);
        }
    };

    const startNewConversation = () => {
        setConversationId(undefined);
        setIsProcessing(false);
        setIsPaused(false);
    };

    const deleteConversation = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
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

    // ===== Message Sending =====

    const pauseResearch = () => {
        if (!isConnected || !isProcessing || isPaused || !conversationId) return;
        wsRef.current?.send(JSON.stringify({ type: 'pause', conversationId }));
    };

    const resumeResearch = (withMessage?: string) => {
        if (!isConnected || !isPaused || !conversationId) return;
        wsRef.current?.send(JSON.stringify({ type: 'resume', message: withMessage, conversationId }));
    };

    const sendConfirmationResponse = (convId: string, optionId: string) => {
        const pendingConfirmation = pendingConfirmations.get(convId);
        if (!pendingConfirmation || !isConnected) return;

        const response = {
            type: 'confirmation_response',
            conversationId: convId,
            data: {
                requestId: pendingConfirmation.requestId,
                selectedOptionId: optionId,
                timestamp: new Date().toISOString(),
            }
        };

        wsRef.current?.send(JSON.stringify(response));

        setPendingConfirmations(prev => {
            const next = new Map(prev);
            next.delete(convId);
            return next;
        });
    };

    const sendCurrentConfirmationResponse = (optionId: string) => {
        if (conversationId) {
            sendConfirmationResponse(conversationId, optionId);
        }
    };

    const sendMessage = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!input.trim() || !isConnected) return;

        // Clear any pending confirmation dialog for current conversation
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

            const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: resumeMsg };
            const assistantMsg: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', thoughts: [], isStreaming: true };

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

            const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: interruptMsg };
            const assistantMsg: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', thoughts: [], isStreaming: true };

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
        const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: input };
        const assistantMsg: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', thoughts: [], isStreaming: true };

        const newMessages = [...messages, userMsg, assistantMsg];
        setMessages(newMessages);
        setIsProcessing(true);

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

    // ===== Render =====

    return (
        <div className="app-wrapper">
            <Sidebar
                isOpen={sidebarOpen}
                conversations={conversations}
                conversationStates={conversationStates}
                pendingConfirmations={pendingConfirmations}
                currentConversationId={conversationId}
                exportingConversationId={exportingConversationId}
                onNewChat={startNewConversation}
                onSelectConversation={selectConversation}
                onDeleteConversation={deleteConversation}
                onExportConversation={exportConversationAsATIF}
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
                />

                <MessageList messages={messages} />

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
                    pendingConfirmation={conversationId ? pendingConfirmations.get(conversationId) : undefined}
                    onConfirmationRespond={sendCurrentConfirmationResponse}
                    textareaRef={textareaRef}
                />
            </div>

            <ToastContainer
                confirmations={pendingConfirmations}
                conversations={conversations}
                currentConversationId={conversationId}
                onRespond={sendConfirmationResponse}
                onDismiss={(convId) => {
                    setPendingConfirmations(prev => {
                        const next = new Map(prev);
                        next.delete(convId);
                        return next;
                    });
                }}
            />
        </div>
    );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
