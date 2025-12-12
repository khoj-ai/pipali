/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUp, Sparkles, ChevronDown, Circle, Loader2, Plus, MessageSquare, Trash2, PanelLeftClose, PanelLeft, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";

// Types
type Message = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    thoughts?: Thought[];
    isStreaming?: boolean;
};

type Thought = {
    id: string;
    type: 'thought' | 'tool_call' | 'tool_result';
    content: string;
    toolName?: string;
    toolArgs?: any;
    toolResult?: string;
};

type WebSocketMessage = {
    type: 'iteration' | 'complete' | 'error';
    data?: any;
    error?: string;
};

type ConversationSummary = {
    id: string;
    title: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
};

type ChatModelInfo = {
    id: number;
    name: string;
    friendlyName: string | null;
    modelType: string;
    visionEnabled?: boolean;
    providerName: string | null;
};

const App = () => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isConnected, setIsConnected] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [conversationId, setConversationId] = useState<string | undefined>(undefined);
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [models, setModels] = useState<ChatModelInfo[]>([]);
    const [selectedModel, setSelectedModel] = useState<ChatModelInfo | null>(null);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const wsRef = useRef<WebSocket | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const modelDropdownRef = useRef<HTMLDivElement>(null);

    // Initialize WebSocket and fetch data
    useEffect(() => {
        connectWebSocket();
        fetchConversations();
        fetchModels();
        fetchUserModel();

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

    // Close model dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
                setShowModelDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Fetch history if conversationId changes
    useEffect(() => {
        // Clear messages immediately when conversation changes
        setMessages([]);

        if (conversationId) {
            const url = new URL(window.location.href);
            url.searchParams.set('conversationId', conversationId);
            window.history.pushState({}, '', url);
            fetchHistory(conversationId);
        } else {
            const url = new URL(window.location.href);
            url.searchParams.delete('conversationId');
            window.history.pushState({}, '', url);
        }
    }, [conversationId]);

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
        }
    }, [input]);

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

    const fetchModels = async () => {
        try {
            const res = await fetch('/api/models');
            if (res.ok) {
                const data = await res.json();
                setModels(data.models);
            }
        } catch (e) {
            console.error("Failed to fetch models", e);
        }
    };

    const fetchUserModel = async () => {
        try {
            const res = await fetch('/api/user/model');
            if (res.ok) {
                const data = await res.json();
                if (data.model) {
                    setSelectedModel(data.model);
                }
            }
        } catch (e) {
            console.error("Failed to fetch user model", e);
        }
    };

    const selectModel = async (model: ChatModelInfo) => {
        try {
            const res = await fetch('/api/user/model', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: model.id }),
            });
            if (res.ok) {
                setSelectedModel(model);
                setShowModelDropdown(false);
            }
        } catch (e) {
            console.error("Failed to select model", e);
        }
    };

    const fetchHistory = async (id: string) => {
        try {
            const res = await fetch(`/api/chat/${id}/history`);
            if (res.ok) {
                const data = await res.json();
                const historyMessages: Message[] = data.history.map((msg: any) => ({
                    id: msg.turnId || crypto.randomUUID(),
                    role: msg.by,
                    content: typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message),
                    thoughts: [],
                }));
                setMessages(historyMessages);
            }
        } catch (e) {
            console.error("Failed to fetch history", e);
        }
    };

    const startNewConversation = () => {
        setConversationId(undefined);
        // Messages will be cleared by the useEffect when conversationId changes
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
        if (message.type === 'error') {
            console.error("Server error:", message.error);
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `Error: ${message.error}`,
            }]);
            return;
        }

        if (message.type === 'iteration') {
            const { data } = message;
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                    const newThought: Thought = {
                        id: crypto.randomUUID(),
                        type: data.query ? 'tool_call' : 'thought',
                        content: data.thought || '',
                        toolName: data.query?.name,
                        toolArgs: data.query?.args,
                        toolResult: data.summarizedResult
                    };

                    return prev.map(msg =>
                        msg.id === lastMsg.id
                            ? { ...msg, thoughts: [...(msg.thoughts || []), newThought] }
                            : msg
                    );
                }
                return prev;
            });
        }

        if (message.type === 'complete') {
            const { data } = message;
            setConversationId(data.conversationId);
            setIsProcessing(false);

            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                    return prev.map(msg =>
                        msg.id === lastMsg.id
                            ? { ...msg, content: data.response, isStreaming: false }
                            : msg
                    );
                }
                return prev;
            });

            // Refresh conversations list
            fetchConversations();
        }
    };

    const sendMessage = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!input.trim() || !isConnected || isProcessing) return;

        const userMsg: Message = {
            id: crypto.randomUUID(),
            role: 'user',
            content: input
        };

        const assistantMsg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            thoughts: [],
            isStreaming: true
        };

        setMessages(prev => [...prev, userMsg, assistantMsg]);
        setIsProcessing(true);

        wsRef.current?.send(JSON.stringify({
            message: input,
            conversationId
        }));

        setInput("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    return (
        <div className="app-wrapper">
            {/* Sidebar */}
            <aside className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
                <div className="sidebar-header">
                    <button className="new-chat-btn" onClick={startNewConversation}>
                        <Plus size={18} />
                        <span>New chat</span>
                    </button>
                </div>

                <div className="conversations-list">
                    {conversations.map(conv => (
                        <button
                            key={conv.id}
                            className={`conversation-item ${conversationId === conv.id ? 'active' : ''}`}
                            onClick={() => setConversationId(conv.id)}
                        >
                            <MessageSquare size={16} />
                            <span className="conversation-title">{conv.title}</span>
                            <button
                                className="delete-btn"
                                onClick={(e) => deleteConversation(conv.id, e)}
                            >
                                <Trash2 size={14} />
                            </button>
                        </button>
                    ))}
                    {conversations.length === 0 && (
                        <div className="no-conversations">No conversations yet</div>
                    )}
                </div>
            </aside>

            {/* Main Content */}
            <div className="app-container">
                {/* Header */}
                <header className="header">
                    <div className="header-content">
                        <div className="header-left">
                            <button
                                className="sidebar-toggle"
                                onClick={() => setSidebarOpen(!sidebarOpen)}
                            >
                                {sidebarOpen ? <PanelLeftClose size={20} /> : <PanelLeft size={20} />}
                            </button>
                            <h1 className="logo">Panini</h1>
                        </div>

                        <div className="header-right">
                            {/* Model Selector */}
                            <div className="model-selector" ref={modelDropdownRef}>
                                <button
                                    className="model-selector-btn"
                                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                                >
                                    <span className="model-name">
                                        {selectedModel?.friendlyName || selectedModel?.name || 'Select model'}
                                    </span>
                                    <ChevronDown size={14} className={showModelDropdown ? 'rotated' : ''} />
                                </button>

                                {showModelDropdown && (
                                    <div className="model-dropdown">
                                        {models.map(model => (
                                            <button
                                                key={model.id}
                                                className={`model-option ${selectedModel?.id === model.id ? 'selected' : ''}`}
                                                onClick={() => selectModel(model)}
                                            >
                                                <div className="model-option-info">
                                                    <span className="model-option-name">
                                                        {model.friendlyName || model.name}
                                                    </span>
                                                    <span className="model-option-provider">
                                                        {model.providerName}
                                                    </span>
                                                </div>
                                                {selectedModel?.id === model.id && <Check size={16} />}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="status">
                                <Circle
                                    className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}
                                    size={8}
                                    fill="currentColor"
                                />
                            </div>
                        </div>
                    </div>
                </header>

                {/* Main Content */}
                <main className="main-content">
                    <div className="messages-container">
                        {messages.length === 0 ? (
                            <div className="empty-state">
                                <Sparkles className="empty-icon" size={32} strokeWidth={1.5} />
                                <h2>What can I help you with?</h2>
                                <p>Ask me anything about your files, data, or tasks.</p>
                            </div>
                        ) : (
                            <div className="messages">
                                {messages.map((msg) => (
                                    <MessageItem key={msg.id} message={msg} />
                                ))}
                                <div ref={messagesEndRef} />
                            </div>
                        )}
                    </div>
                </main>

                {/* Input Area */}
                <footer className="input-area">
                    <div className="input-container">
                        <form onSubmit={sendMessage} className="input-form">
                            <textarea
                                ref={textareaRef}
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Ask anything..."
                                rows={1}
                                disabled={!isConnected || isProcessing}
                            />
                            <button
                                type="submit"
                                disabled={!input.trim() || !isConnected || isProcessing}
                                className="send-button"
                            >
                                {isProcessing ? (
                                    <Loader2 size={18} className="spinning" />
                                ) : (
                                    <ArrowUp size={18} />
                                )}
                            </button>
                        </form>
                        <p className="input-hint">
                            Press Enter to send, Shift + Enter for new line
                        </p>
                    </div>
                </footer>
            </div>
        </div>
    );
};

const MessageItem = ({ message }: { message: Message }) => {
    const isUser = message.role === 'user';

    return (
        <div className={`message ${isUser ? 'user-message' : 'assistant-message'}`}>
            <div className="message-label">
                {isUser ? 'You' : 'Panini'}
            </div>

            {/* Thoughts / Reasoning */}
            {message.thoughts && message.thoughts.length > 0 && (
                <ThoughtsSection thoughts={message.thoughts} />
            )}

            {/* Message Content */}
            {message.content ? (
                <div className="message-content">
                    <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
            ) : message.isStreaming ? (
                <div className="message-content streaming">
                    <span className="streaming-dot" />
                    <span className="streaming-dot" />
                    <span className="streaming-dot" />
                </div>
            ) : null}
        </div>
    );
};

const ThoughtsSection = ({ thoughts }: { thoughts: Thought[] }) => {
    const [isExpanded, setIsExpanded] = useState(false);

    const toolCalls = thoughts.filter(t => t.type === 'tool_call');
    if (toolCalls.length === 0) return null;

    return (
        <div className="thoughts-section">
            <button
                className="thoughts-toggle"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <span className="thoughts-summary">
                    {toolCalls.length} step{toolCalls.length > 1 ? 's' : ''} taken
                </span>
                <ChevronDown
                    size={14}
                    className={`thoughts-chevron ${isExpanded ? 'expanded' : ''}`}
                />
            </button>

            {isExpanded && (
                <div className="thoughts-list">
                    {toolCalls.map((thought, idx) => (
                        <div key={thought.id} className="thought-item">
                            <div className="thought-step">{idx + 1}</div>
                            <div className="thought-content">
                                <div className="thought-tool">{formatToolName(thought.toolName || '')}</div>
                                {thought.content && (
                                    <div className="thought-reasoning">{thought.content}</div>
                                )}
                                {thought.toolResult && (
                                    <div className="thought-result">
                                        {thought.toolResult.slice(0, 200)}
                                        {thought.toolResult.length > 200 && '...'}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

const formatToolName = (name: string): string => {
    return name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
