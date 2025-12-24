// Sidebar with conversation list

import React, { useState, useEffect, useRef } from 'react';
import { Loader2, MessageSquare, AlertCircle, Plus, MoreVertical, Download, Trash2, ChevronRight, Search, X, Zap, Clock, Wrench } from 'lucide-react';
import type { ConversationSummary, ConversationState, ConfirmationRequest } from '../../types';

const MAX_VISIBLE_CHATS = 5;

interface SidebarProps {
    isOpen: boolean;
    conversations: ConversationSummary[];
    conversationStates: Map<string, ConversationState>;
    pendingConfirmations: Map<string, ConfirmationRequest>;
    currentConversationId?: string;
    exportingConversationId: string | null;
    currentPage?: 'home' | 'chat' | 'skills' | 'automations' | 'mcp-tools';
    onNewChat: () => void;
    onSelectConversation: (id: string) => void;
    onDeleteConversation: (id: string, e: React.MouseEvent) => void;
    onExportConversation: (id: string) => void;
    onGoToSkills?: () => void;
    onGoToAutomations?: () => void;
    onGoToMcpTools?: () => void;
    onClose?: () => void;
}

export function Sidebar({
    isOpen,
    conversations,
    conversationStates,
    pendingConfirmations,
    currentConversationId,
    exportingConversationId,
    currentPage,
    onNewChat,
    onSelectConversation,
    onDeleteConversation,
    onExportConversation,
    onGoToSkills,
    onGoToAutomations,
    onGoToMcpTools,
    onClose,
}: SidebarProps) {
    const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);
    const [openMenuContext, setOpenMenuContext] = useState<'sidebar' | 'modal' | null>(null);
    const [showAllChatsModal, setShowAllChatsModal] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // Close conversation menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            if (target.closest('.conversation-menu-container')) return;
            setOpenConversationMenuId(null);
            setOpenMenuContext(null);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Reset selected index when search query changes or modal opens
    useEffect(() => {
        setSelectedIndex(0);
    }, [searchQuery, showAllChatsModal]);

    // Scroll selected item into view
    useEffect(() => {
        if (!showAllChatsModal || !listRef.current) return;
        const items = listRef.current.querySelectorAll('.conversation-item');
        const selectedItem = items[selectedIndex] as HTMLElement | undefined;
        selectedItem?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [selectedIndex, showAllChatsModal]);

    // Global Escape key handler for modal (captures before app's global handler)
    useEffect(() => {
        if (!showAllChatsModal) return;

        const handleGlobalEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setShowAllChatsModal(false);
                setSearchQuery('');
                setSelectedIndex(0);
            }
        };

        // Use capture phase to intercept before other handlers
        document.addEventListener('keydown', handleGlobalEscape, true);
        return () => document.removeEventListener('keydown', handleGlobalEscape, true);
    }, [showAllChatsModal]);

    // Filter conversations based on search query
    const filteredConversations = searchQuery.trim()
        ? conversations.filter(conv =>
            conv.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            conv.preview?.toLowerCase().includes(searchQuery.toLowerCase())
        )
        : conversations;

    // Split conversations into visible (first 5) and hidden (rest)
    const visibleConversations = conversations.slice(0, MAX_VISIBLE_CHATS);
    const hasMoreChats = conversations.length > MAX_VISIBLE_CHATS;
    const hiddenChatsCount = conversations.length - MAX_VISIBLE_CHATS;

    const toggleConversationMenu = (id: string, e: React.MouseEvent, context: 'sidebar' | 'modal') => {
        e.stopPropagation();
        if (openConversationMenuId === id && openMenuContext === context) {
            setOpenConversationMenuId(null);
            setOpenMenuContext(null);
        } else {
            setOpenConversationMenuId(id);
            setOpenMenuContext(context);
        }
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
        setOpenMenuContext(null);
    };

    const handleModalSelectConversation = (id: string) => {
        onSelectConversation(id);
        setShowAllChatsModal(false);
        setSearchQuery('');
        setSelectedIndex(0);
    };

    // Close modal helper
    const closeModal = () => {
        setShowAllChatsModal(false);
        setSearchQuery('');
        setSelectedIndex(0);
    };

    // Handle keyboard navigation in modal
    const handleModalKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                closeModal();
                break;
            case 'ArrowDown':
                if (filteredConversations.length === 0) return;
                e.preventDefault();
                setSelectedIndex(prev =>
                    prev < filteredConversations.length - 1 ? prev + 1 : prev
                );
                break;
            case 'ArrowUp':
                if (filteredConversations.length === 0) return;
                e.preventDefault();
                setSelectedIndex(prev => (prev > 0 ? prev - 1 : prev));
                break;
            case 'Enter':
                if (filteredConversations.length === 0) return;
                e.preventDefault();
                const selectedConv = filteredConversations[selectedIndex];
                if (selectedConv) {
                    handleModalSelectConversation(selectedConv.id);
                }
                break;
        }
    };

    // Render a conversation item (reused in both sidebar and modal)
    const renderConversationItem = (conv: ConversationSummary, inModal = false, index?: number) => {
        const liveState = conversationStates.get(conv.id);
        const isActive = liveState?.isProcessing ?? conv.isActive ?? false;
        const latestReasoning = liveState?.latestReasoning ?? conv.latestReasoning;
        const hasPendingConfirmation = pendingConfirmations.has(conv.id);
        const isSelected = inModal && index === selectedIndex;

        return (
            <div
                key={conv.id}
                className={`conversation-item ${currentConversationId === conv.id ? 'active' : ''} ${isActive ? 'has-active-task' : ''} ${isSelected ? 'keyboard-selected' : ''}`}
                onClick={() => inModal ? handleModalSelectConversation(conv.id) : handleSelectConversation(conv.id)}
                onMouseEnter={() => inModal && index !== undefined && setSelectedIndex(index)}
                onKeyDown={(e) => handleConversationKeyDown(conv.id, e)}
                role="button"
                tabIndex={inModal ? -1 : 0}
                aria-label={`Open conversation: ${conv.title}`}
                aria-selected={isSelected}
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
                        onClick={(e) => toggleConversationMenu(conv.id, e, inModal ? 'modal' : 'sidebar')}
                        aria-label="Conversation actions"
                    >
                        <MoreVertical size={16} />
                    </button>

                    {openConversationMenuId === conv.id && openMenuContext === (inModal ? 'modal' : 'sidebar') && (
                        <div className="conversation-menu" role="menu">
                            <button
                                className="conversation-menu-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenConversationMenuId(null);
                                    setOpenMenuContext(null);
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
                                    setOpenMenuContext(null);
                                    onDeleteConversation(conv.id, e);
                                    if (inModal) {
                                        closeModal();
                                    }
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
    };

    return (
        <>
            {/* Mobile backdrop overlay */}
            {isOpen && (
                <div
                    className="sidebar-backdrop"
                    onClick={onClose}
                    aria-hidden="true"
                />
            )}
            <aside className={`sidebar ${isOpen ? 'open' : 'closed'}`}>
                <div className="sidebar-header">
                    <div className="sidebar-header-row">
                        <button className="new-chat-btn" onClick={onNewChat}>
                            <Plus size={18} />
                            <span>New chat</span>
                        </button>
                        <button
                            className="sidebar-close-btn"
                            onClick={onClose}
                            aria-label="Close sidebar"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                <div className="sidebar-nav">
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'skills' ? 'active' : ''}`}
                        onClick={onGoToSkills}
                    >
                        <Zap size={16} />
                        <span>Skills</span>
                    </button>
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'automations' ? 'active' : ''}`}
                        onClick={onGoToAutomations}
                    >
                        <Clock size={16} />
                        <span>Automations</span>
                    </button>
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'mcp-tools' ? 'active' : ''}`}
                        onClick={onGoToMcpTools}
                    >
                        <Wrench size={16} />
                        <span>Tools</span>
                    </button>
                </div>

                <div className="conversations-list">
                    {visibleConversations.map(conv => renderConversationItem(conv))}

                    {hasMoreChats && (
                        <button
                            className="see-more-btn"
                            onClick={() => setShowAllChatsModal(true)}
                        >
                            <span>See {hiddenChatsCount} more</span>
                            <ChevronRight size={14} />
                        </button>
                    )}

                    {conversations.length === 0 && (
                        <div className="no-conversations">No conversations yet</div>
                    )}
                </div>
            </aside>

            {/* All Chats Modal */}
            {showAllChatsModal && (
                <div
                    className="chat-modal-overlay"
                    onClick={closeModal}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            closeModal();
                        }
                    }}
                >
                    <div
                        className="chat-modal"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="chat-modal-header">
                            <h2>All Chats</h2>
                            <button
                                className="chat-modal-close"
                                onClick={closeModal}
                                aria-label="Close"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="chat-modal-search">
                            <Search size={16} className="search-icon" />
                            <input
                                type="text"
                                placeholder="Search chats..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={handleModalKeyDown}
                                autoFocus
                            />
                            {searchQuery && (
                                <button
                                    className="search-clear"
                                    onClick={() => setSearchQuery('')}
                                    aria-label="Clear search"
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </div>

                        <div className="chat-modal-list" ref={listRef} role="listbox">
                            {filteredConversations.length > 0 ? (
                                filteredConversations.map((conv, index) => renderConversationItem(conv, true, index))
                            ) : (
                                <div className="no-conversations">
                                    {searchQuery ? 'No chats match your search' : 'No conversations yet'}
                                </div>
                            )}
                        </div>

                        <div className="chat-modal-footer">
                            <span className="chat-count">
                                {filteredConversations.length} {filteredConversations.length === 1 ? 'chat' : 'chats'}
                                {searchQuery && ` matching "${searchQuery}"`}
                            </span>
                            <span className="keyboard-hint">
                                <kbd>↑</kbd><kbd>↓</kbd> to navigate · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
