// Message list container with empty state

import { useMemo } from 'react';
import type { Message } from '../../types';
import type { ComposerDraft } from '../../hooks/useComposerDraft';
import { useStableCallback } from '../../hooks/useStableCallback';
import { MessageItem } from './MessageItem';
import { MessageNavigator } from './MessageNavigator';
import { EmptyHomeState } from '../home/EmptyHomeState';
import { useMessageListScroll } from './useMessageListScroll';

interface MessageListProps {
    messages: Message[];
    conversationId?: string;
    platformFrontendUrl?: string;
    onDeleteMessage: (messageId: string, role: 'user' | 'assistant') => void;
    onEditMessage: (messageId: string, text: string) => void;
    onForkConversation: (messageId: string) => void;
    onBillingContinue: (messageId: string) => void;
    onBillingDismiss: (messageId: string) => void;
    onAuthSignIn: (messageId: string) => void;
    onAuthDismiss: (messageId: string) => void;
    onRunErrorDismiss: (messageId: string) => void;
    userFirstName?: string;
    draft: ComposerDraft;
    isProcessing?: boolean;
    zoom?: number;
}

export function MessageList({
    messages,
    conversationId,
    platformFrontendUrl,
    onDeleteMessage,
    onEditMessage,
    onForkConversation,
    onBillingContinue,
    onBillingDismiss,
    onAuthSignIn,
    onAuthDismiss,
    onRunErrorDismiss,
    userFirstName,
    draft,
    isProcessing = false,
    zoom = 1,
}: MessageListProps) {
    const {
        activeRunStableId,
        hasActiveRun,
        mainContentRef,
        messageRefsMap,
        messagesRef,
        registerMessageRef,
    } = useMessageListScroll({ messages, conversationId, isProcessing });

    const handlers = {
        onDelete: useStableCallback(onDeleteMessage),
        onEdit: useStableCallback(onEditMessage),
        onFork: useStableCallback(onForkConversation),
        onBillingContinue: useStableCallback(onBillingContinue),
        onBillingDismiss: useStableCallback(onBillingDismiss),
        onAuthSignIn: useStableCallback(onAuthSignIn),
        onAuthDismiss: useStableCallback(onAuthDismiss),
        onRunErrorDismiss: useStableCallback(onRunErrorDismiss),
    };

    const messageIndices = useMemo(
        () => messages.map((_, i) => i),
        [messages.length]
    );

    return (
        <main className="main-content" ref={mainContentRef} style={{ zoom }}>
            <div className="messages-container">
                {messages.length === 0 ? (
                    <EmptyHomeState userFirstName={userFirstName} draft={draft} />
                ) : (
                    <div className="messages" ref={messagesRef}>
                        {messages.map((msg, index) => (
                            <div
                                key={msg.stableId}
                                ref={el => registerMessageRef(index, el)}
                            >
                                <MessageItem
                                    message={msg}
                                    platformFrontendUrl={platformFrontendUrl}
                                    {...handlers}
                                    isActiveRun={hasActiveRun && msg.role === 'assistant' && msg.stableId === activeRunStableId}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <MessageNavigator
                messageIndices={messageIndices}
                scrollContainerRef={mainContentRef}
                messageRefs={messageRefsMap}
            />
        </main>
    );
}
