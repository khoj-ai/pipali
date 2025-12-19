// Sidebar with conversation list

import React, { useState, useEffect } from 'react';
import { Loader2, MessageSquare, AlertCircle, Plus, MoreVertical, Download, Trash2 } from 'lucide-react';
import type { ConversationSummary, ConversationState, ConfirmationRequest } from '../../types';

interface SidebarProps {
    isOpen: boolean;
    conversations: ConversationSummary[];
    conversationStates: Map<string, ConversationState>;
    pendingConfirmations: Map<string, ConfirmationRequest>;
    currentConversationId?: string;
    exportingConversationId: string | null;
    onNewChat: () => void;
    onSelectConversation: (id: string) => void;
    onDeleteConversation: (id: string, e: React.MouseEvent) => void;
    onExportConversation: (id: string) => void;
}

export function Sidebar({
    isOpen,
    conversations,
    conversationStates,
    pendingConfirmations,
    currentConversationId,
    exportingConversationId,
    onNewChat,
    onSelectConversation,
    onDeleteConversation,
    onExportConversation,
}: SidebarProps) {
    const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);

    // Close conversation menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            if (target.closest('.conversation-menu-container')) return;
            setOpenConversationMenuId(null);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const toggleConversationMenu = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setOpenConversationMenuId(prev => (prev === id ? null : id));
    };

    const handleConversationKeyDown = (id: string, e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectConversation(id);
        }
    };

    const handleSelectConversation = (id: string) => {
        onSelectConversation(id);
        setOpenConversationMenuId(null);
    };

    return (
        <aside className={`sidebar ${isOpen ? 'open' : 'closed'}`}>
            <div className="sidebar-header">
                <button className="new-chat-btn" onClick={onNewChat}>
                    <Plus size={18} />
                    <span>New chat</span>
                </button>
            </div>

            <div className="conversations-list">
                {conversations.map(conv => {
                    // Get live state from conversationStates, fallback to API data
                    const liveState = conversationStates.get(conv.id);
                    const isActive = liveState?.isProcessing ?? conv.isActive ?? false;
                    const latestReasoning = liveState?.latestReasoning ?? conv.latestReasoning;
                    const hasPendingConfirmation = pendingConfirmations.has(conv.id);

                    return (
                        <div
                            key={conv.id}
                            className={`conversation-item ${currentConversationId === conv.id ? 'active' : ''} ${isActive ? 'has-active-task' : ''}`}
                            onClick={() => handleSelectConversation(conv.id)}
                            onKeyDown={(e) => handleConversationKeyDown(conv.id, e)}
                            role="button"
                            tabIndex={0}
                            aria-label={`Open conversation: ${conv.title}`}
                        >
                            {/* Activity indicator */}
                            {isActive ? (
                                <Loader2 size={16} className="spinning conversation-icon" />
                            ) : hasPendingConfirmation ? (
                                <AlertCircle size={16} className="conversation-icon needs-attention" />
                            ) : (
                                <MessageSquare size={16} className="conversation-icon" />
                            )}

                            <div className="conversation-info">
                                <span className="conversation-title">{conv.title}</span>
                                {/* Subtitle with train of thought */}
                                {isActive && latestReasoning && (
                                    <span className="conversation-subtitle">
                                        {(() => {
                                            const firstLine = latestReasoning.split('\n')[0] ?? '';
                                            return firstLine.length > 60
                                                ? firstLine.slice(0, 60) + '...'
                                                : firstLine;
                                        })()}
                                    </span>
                                )}
                            </div>

                            <div className="conversation-menu-container">
                                <button
                                    className="menu-btn"
                                    onClick={(e) => toggleConversationMenu(conv.id, e)}
                                    aria-label="Conversation actions"
                                >
                                    <MoreVertical size={16} />
                                </button>

                                {openConversationMenuId === conv.id && (
                                    <div className="conversation-menu" role="menu">
                                        <button
                                            className="conversation-menu-item"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenConversationMenuId(null);
                                                onExportConversation(conv.id);
                                            }}
                                            disabled={exportingConversationId === conv.id}
                                            role="menuitem"
                                        >
                                            {exportingConversationId === conv.id ? (
                                                <Loader2 size={14} className="spinning" />
                                            ) : (
                                                <Download size={14} />
                                            )}
                                            <span>Export</span>
                                        </button>

                                        <button
                                            className="conversation-menu-item danger"
                                            onClick={(e) => {
                                                setOpenConversationMenuId(null);
                                                onDeleteConversation(conv.id, e);
                                            }}
                                            role="menuitem"
                                        >
                                            <Trash2 size={14} />
                                            <span>Delete</span>
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
                {conversations.length === 0 && (
                    <div className="no-conversations">No conversations yet</div>
                )}
            </div>
        </aside>
    );
}
