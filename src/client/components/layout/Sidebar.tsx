// Sidebar with conversation list

import React, { useState, useEffect, useRef } from 'react';
import { Loader2, MessageSquare, AlertCircle, CheckCircle, Plus, MoreVertical, Download, Trash2, ChevronRight, Search, X, Zap, Clock, Hammer, Settings, User, LogOut, Shield, Sun, Moon, Monitor, Pencil, Pin, PinOff } from 'lucide-react';
import type { ConversationSummary, ConversationState, ConfirmationRequest, AuthStatus, BillingAlert } from '../../types';
import { useTheme } from '../../hooks';
import { BillingAlertBanner } from '../billing';
import { apiFetch } from '../../utils/api';

import { MOD_KEY } from '../../utils/platform';

const MAX_VISIBLE_CHATS = 5;

/**
 * Generate a Gravatar URL from an email address.
 * Falls back to a 404 if no Gravatar exists (so we can detect and show initials).
 */
async function getGravatarUrl(email: string, size = 64): Promise<string> {
    const trimmedEmail = email.trim().toLowerCase();
    const encoder = new TextEncoder();
    const data = encoder.encode(trimmedEmail);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    // d=404 returns a 404 if no Gravatar exists, allowing us to fall back to initials
    return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

/**
 * Get user initial from name or email for avatar fallback.
 */
function getUserInitial(name?: string, email?: string): string {
    if (name) {
        return name.charAt(0).toUpperCase();
    }
    if (email) {
        return email.charAt(0).toUpperCase();
    }
    return '?';
}

interface SidebarProps {
    isOpen: boolean;
    conversations: ConversationSummary[];
    conversationStates: Map<string, ConversationState>;
    pendingConfirmations: Map<string, ConfirmationRequest[]>;
    currentConversationId?: string;
    exportingConversationId: string | null;
    currentPage?: 'home' | 'chat' | 'skills' | 'automations' | 'mcp-tools' | 'settings';
    authStatus?: AuthStatus | null;
    billingAlerts?: BillingAlert[];
    platformFrontendUrl?: string;
    onNewChat: () => void;
    onSelectConversation: (id: string, highlightTerm?: string) => void;
    onDeleteConversation: (id: string, e: React.MouseEvent) => void;
    onExportConversation: (id: string) => void;
    onRenameConversation: (id: string, title: string) => Promise<boolean>;
    onPinConversation: (id: string, isPinned: boolean) => void;
    onGoToSkills?: () => void;
    onGoToAutomations?: () => void;
    onGoToMcpTools?: () => void;
    onGoToSettings?: () => void;
    onLogout?: () => void;
    onClose?: () => void;
    onDismissAllBillingAlerts?: () => void;
}

export function Sidebar({
    isOpen,
    conversations,
    conversationStates,
    pendingConfirmations,
    currentConversationId,
    exportingConversationId,
    currentPage,
    authStatus,
    billingAlerts,
    platformFrontendUrl,
    onNewChat,
    onSelectConversation,
    onDeleteConversation,
    onExportConversation,
    onRenameConversation,
    onPinConversation,
    onGoToSkills,
    onGoToAutomations,
    onGoToMcpTools,
    onGoToSettings,
    onLogout,
    onClose,
    onDismissAllBillingAlerts,
}: SidebarProps) {
    const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);
    const [openMenuContext, setOpenMenuContext] = useState<'sidebar' | 'modal' | null>(null);
    const [showAllChatsModal, setShowAllChatsModal] = useState(false);
    const [showUserMenu, setShowUserMenu] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searchResults, setSearchResults] = useState<ConversationSummary[] | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef<HTMLInputElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [gravatarUrl, setGravatarUrl] = useState<string | null>(null);
    const [gravatarFailed, setGravatarFailed] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const { theme, setTheme, isDark } = useTheme();

    // Load Gravatar URL when user email is available but no profile picture
    const userEmail = authStatus?.user?.email;
    const hasProfilePicture = !!authStatus?.user?.profilePictureUrl;
    useEffect(() => {
        if (userEmail && !hasProfilePicture) {
            setGravatarFailed(false);
            getGravatarUrl(userEmail).then(setGravatarUrl);
        } else {
            setGravatarUrl(null);
            setGravatarFailed(false);
        }
    }, [userEmail, hasProfilePicture]);

    // Get user initial for avatar fallback
    const userInitial = getUserInitial(authStatus?.user?.name, authStatus?.user?.email);

    // Close menus when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            // Close conversation menu
            if (!target.closest('.conversation-menu-container')) {
                setOpenConversationMenuId(null);
                setOpenMenuContext(null);
            }
            // Close user menu
            if (!target.closest('.user-profile-container')) {
                setShowUserMenu(false);
            }
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

    // Global keyboard shortcut: Cmd/Ctrl+O to toggle all chats modal
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
                e.preventDefault();
                e.stopPropagation();
                setShowAllChatsModal(prev => {
                    if (prev) {
                        setSearchQuery('');
                        setSelectedIndex(0);
                    }
                    return !prev;
                });
            }
            // Close modal on Escape (capture phase to intercept before other handlers)
            // But not while renaming — Escape should cancel rename first
            if (e.key === 'Escape' && showAllChatsModal && !renamingConversationId) {
                e.preventDefault();
                e.stopPropagation();
                setShowAllChatsModal(false);
                setSearchQuery('');
                setSelectedIndex(0);
            }
        };

        document.addEventListener('keydown', handleGlobalKeyDown, true);
        return () => document.removeEventListener('keydown', handleGlobalKeyDown, true);
    }, [showAllChatsModal, renamingConversationId]);

    // Debounced server-side full-text search across message content
    useEffect(() => {
        const trimmed = searchQuery.trim();
        if (!trimmed || trimmed.length < 2) {
            setSearchResults(null);
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const res = await apiFetch(
                    `/api/conversations?q=${encodeURIComponent(trimmed)}`,
                    { signal: controller.signal },
                );
                if (res.ok) {
                    const data = await res.json();
                    setSearchResults(data.conversations);
                }
            } catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError') return;
                console.error('Search failed', e);
            } finally {
                setIsSearching(false);
            }
        }, 300);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [searchQuery]);

    // Filter conversations: use server results when available, else client-side filter
    const filteredConversations = (() => {
        const trimmed = searchQuery.trim();
        if (!trimmed) return conversations;
        if (searchResults) return searchResults;
        // Instant client-side filter while waiting for server results
        return conversations.filter(conv =>
            conv.title.toLowerCase().includes(trimmed.toLowerCase()) ||
            conv.preview?.toLowerCase().includes(trimmed.toLowerCase())
        );
    })();

    // Split conversations into visible (first 5) and hidden (rest)
    // Always include the current conversation so it appears in the sidebar
    const topConversations = conversations.slice(0, MAX_VISIBLE_CHATS);
    const currentInTop = !currentConversationId || topConversations.some(c => c.id === currentConversationId);
    const currentConv = !currentInTop ? conversations.find(c => c.id === currentConversationId) : undefined;
    const visibleConversations = currentConv
        ? [...topConversations.slice(0, MAX_VISIBLE_CHATS - 1), currentConv]
        : topConversations;
    const hasMoreChats = conversations.length > MAX_VISIBLE_CHATS;
    const hiddenChatsCount = conversations.length - visibleConversations.length;

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
        // Pass search query as highlight term if full-text search matched in message content
        const term = searchQuery.trim();
        const conv = (searchResults ?? conversations).find(c => c.id === id);
        const hasMessageMatch = conv?.matchSnippet;
        onSelectConversation(id, hasMessageMatch ? term : undefined);
        setShowAllChatsModal(false);
        setSearchQuery('');
        setSelectedIndex(0);
        setSearchResults(null);
        setIsSearching(false);
    };

    // Close modal helper
    const closeModal = () => {
        setShowAllChatsModal(false);
        setSearchQuery('');
        setSelectedIndex(0);
        setSearchResults(null);
        setIsSearching(false);
        setRenamingConversationId(null);
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

    const startRename = (conv: ConversationSummary) => {
        setRenamingConversationId(conv.id);
        setRenameValue(conv.title);
        setOpenConversationMenuId(null);
        setOpenMenuContext(null);
    };

    // Focus the rename input after it mounts
    useEffect(() => {
        if (renamingConversationId) {
            // Use rAF to wait for the DOM to settle after React commit
            requestAnimationFrame(() => renameInputRef.current?.focus());
        }
    }, [renamingConversationId]);

    const finishRename = () => {
        setRenamingConversationId(null);
        // Return focus to the modal search input if it exists
        requestAnimationFrame(() => searchInputRef.current?.focus());
    };

    const submitRename = async (id: string) => {
        // Guard against double-submit (Enter triggers onBlur when input unmounts)
        if (!renamingConversationId) return;
        const trimmed = renameValue.trim();
        if (!trimmed) {
            finishRename();
            return;
        }
        // Skip API call if title unchanged
        const conv = conversations.find(c => c.id === id);
        if (conv && conv.title === trimmed) {
            finishRename();
            return;
        }
        const ok = await onRenameConversation(id, trimmed);
        if (ok) finishRename();
    };

    const cancelRename = () => {
        finishRename();
    };

    // Render a conversation item (reused in both sidebar and modal)
    const renderConversationItem = (conv: ConversationSummary, inModal = false, index?: number) => {
        const liveState = conversationStates.get(conv.id);
        const isActive = liveState?.isProcessing ?? conv.isActive ?? false;
        const hasPendingConfirmation = (pendingConfirmations.get(conv.id)?.length ?? 0) > 0;
        const isCompleted = liveState?.isCompleted ?? false;
        const isStopped = liveState ? !liveState.isProcessing && liveState.isStopped : false;
        // For completed/stopped tasks, show the final response instead of intermediate reasoning
        const assistantMsg = liveState?.messages.findLast(m => m.role === 'assistant');
        const latestReasoning = (isCompleted || isStopped) && assistantMsg?.content
            ? assistantMsg.content
            : (liveState?.latestReasoning ?? conv.latestReasoning);
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
                {isActive && !hasPendingConfirmation ? (
                    <Loader2 size={16} className="conversation-icon running" />
                ) : hasPendingConfirmation ? (
                    <AlertCircle size={16} className="conversation-icon needs-attention" />
                ) : isCompleted ? (
                    <CheckCircle size={16} className="conversation-icon completed" />
                ) : conv.isAutomation ? (
                    <Clock size={16} className="conversation-icon" />
                ) : (
                    <MessageSquare size={16} className="conversation-icon" />
                )}

                <div className="conversation-info">
                    {renamingConversationId === conv.id ? (
                        <input
                            ref={renameInputRef}
                            className="conversation-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') submitRename(conv.id);
                                if (e.key === 'Escape') cancelRename();
                            }}
                            onBlur={() => submitRename(conv.id)}
                            onClick={(e) => e.stopPropagation()}
                        />
                    ) : (
                        <>
                            <span className="conversation-title">{conv.title}</span>
                            {/* Match snippet from full-text search */}
                            {conv.matchSnippet ? (
                                <span className="conversation-match-snippet">{conv.matchSnippet}</span>
                            ) : (isActive || isCompleted || hasPendingConfirmation) && latestReasoning ? (
                                <span className="conversation-subtitle">
                                    {(() => {
                                        const firstLine = latestReasoning.split('\n')[0] ?? '';
                                        return firstLine.length > 60
                                            ? firstLine.slice(0, 60) + '...'
                                            : firstLine;
                                    })()}
                                </span>
                            ) : null}
                        </>
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
                                    startRename(conv);
                                }}
                                role="menuitem"
                            >
                                <Pencil size={14} />
                                <span>Rename</span>
                            </button>

                            <button
                                title={conv.isPinned ? 'Unpin from Home' : 'Pin to Home'}
                                className="conversation-menu-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenConversationMenuId(null);
                                    setOpenMenuContext(null);
                                    onPinConversation(conv.id, !conv.isPinned);
                                }}
                                role="menuitem"
                            >
                                {conv.isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                                <span>{conv.isPinned ? 'Unpin' : 'Pin'}</span>
                            </button>

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
                        <span>Routines</span>
                    </button>
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'mcp-tools' ? 'active' : ''}`}
                        onClick={onGoToMcpTools}
                    >
                        <Hammer size={16} />
                        <span>Tools</span>
                    </button>
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'settings' ? 'active' : ''}`}
                        onClick={onGoToSettings}
                    >
                        <Settings size={16} />
                        <span>Settings</span>
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

                {/* Billing Alert Banner */}
                {billingAlerts && billingAlerts.length > 0 && platformFrontendUrl && onDismissAllBillingAlerts && (
                    <div className="sidebar-billing-section">
                        <BillingAlertBanner
                            alerts={billingAlerts}
                            platformFrontendUrl={platformFrontendUrl}
                            onDismissAll={onDismissAllBillingAlerts}
                        />
                    </div>
                )}

                {/* User Profile Section */}
                {authStatus && (authStatus.authenticated || authStatus.anonMode) && (
                    <div className="sidebar-user-section">
                        <div className="user-profile-container">
                            <button
                                className="user-profile-btn"
                                onClick={() => setShowUserMenu(prev => !prev)}
                                aria-label="User menu"
                            >
                                <div className="user-avatar">
                                    {authStatus.anonMode ? (
                                        <Shield size={18} />
                                    ) : authStatus.user?.profilePictureUrl ? (
                                        <img
                                            src={authStatus.user.profilePictureUrl}
                                            alt=""
                                            className="user-avatar-img"
                                            referrerPolicy="no-referrer"
                                        />
                                    ) : gravatarUrl && !gravatarFailed ? (
                                        <img
                                            src={gravatarUrl}
                                            alt=""
                                            className="user-avatar-img"
                                            onError={() => setGravatarFailed(true)}
                                        />
                                    ) : (
                                        <span className="user-avatar-initial">{userInitial}</span>
                                    )}
                                </div>
                                <div className="user-info">
                                    <span className="user-name">
                                        {authStatus.anonMode
                                            ? 'Anonymous Mode'
                                            : authStatus.user?.name || authStatus.user?.email || 'User'}
                                    </span>
                                    {!authStatus.anonMode && authStatus.user?.email && authStatus.user?.name && (
                                        <span className="user-email">{authStatus.user.email}</span>
                                    )}
                                </div>
                            </button>

                            {showUserMenu && (
                                <div className="user-menu" role="menu">
                                    {/* Theme Toggle */}
                                    <div className="user-menu-theme">
                                        <span className="user-menu-label">Theme</span>
                                        <div className="theme-toggle-group">
                                            <button
                                                className={`theme-toggle-btn ${theme === 'light' ? 'active' : ''}`}
                                                onClick={() => setTheme('light')}
                                                aria-label="Light theme"
                                                title="Light"
                                            >
                                                <Sun size={14} />
                                            </button>
                                            <button
                                                className={`theme-toggle-btn ${theme === 'dark' ? 'active' : ''}`}
                                                onClick={() => setTheme('dark')}
                                                aria-label="Dark theme"
                                                title="Dark"
                                            >
                                                <Moon size={14} />
                                            </button>
                                            <button
                                                className={`theme-toggle-btn ${theme === 'system' ? 'active' : ''}`}
                                                onClick={() => setTheme('system')}
                                                aria-label="System theme"
                                                title="System"
                                            >
                                                <Monitor size={14} />
                                            </button>
                                        </div>
                                    </div>
                                    {!authStatus.anonMode && (
                                        <button
                                            className="user-menu-item danger"
                                            onClick={() => {
                                                setShowUserMenu(false);
                                                onLogout?.();
                                            }}
                                            role="menuitem"
                                        >
                                            <LogOut size={14} />
                                            <span>Sign out</span>
                                        </button>
                                    )}
                                    {authStatus.anonMode && (
                                        <div className="user-menu-info">
                                            <span>Using local API keys</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
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
                                ref={searchInputRef}
                                type="text"
                                placeholder="Search chats..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={handleModalKeyDown}
                                autoFocus
                            />
                            {isSearching && <Loader2 size={14} className="search-spinner spinning" />}
                            {searchQuery && !isSearching && (
                                <button
                                    className="search-clear"
                                    onClick={() => { setSearchQuery(''); setSearchResults(null); }}
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
                                {searchQuery && searchResults ? ' found' : searchQuery ? ` matching "${searchQuery}"` : ''}
                            </span>
                            <span className="keyboard-hint">
                                <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Enter</kbd> open · <kbd>{MOD_KEY}O</kbd> toggle · <kbd>Esc</kbd> close
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
