// Message list container with empty state

import { useMemo } from 'react';
import type { Message } from '../../types';
import { MessageItem } from './MessageItem';
import { MessageNavigator } from './MessageNavigator';
import { EmptyHomeState } from '../home/EmptyHomeState';
import { useMessageListScroll } from './useMessageListScroll';

interface MessageListProps {
    messages: Message[];
    conversationId?: string;
    platformFrontendUrl?: string;
    onDeleteMessage?: (messageId: string, role: 'user' | 'assistant') => void;
    onBillingContinue?: (messageId: string) => void;
    onBillingDismiss?: (messageId: string) => void;
    onAuthSignIn?: (messageId: string) => void;
    onAuthDismiss?: (messageId: string) => void;
    onRunErrorDismiss?: (messageId: string) => void;
    userFirstName?: string;
    hasInput?: boolean;
    isProcessing?: boolean;
    zoom?: number;
}

export function MessageList({
    messages,
    conversationId,
    platformFrontendUrl,
    onDeleteMessage,
    onBillingContinue,
    onBillingDismiss,
    onAuthSignIn,
    onAuthDismiss,
    onRunErrorDismiss,
    userFirstName,
    hasInput,
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

    const messageIndices = useMemo(
        () => messages.map((_, i) => i),
        [messages.length]
    );

    return (
        <main className="main-content" ref={mainContentRef} style={{ zoom }}>
            <div className="messages-container">
                {messages.length === 0 ? (
                    <EmptyHomeState userFirstName={userFirstName} hasInput={hasInput} />
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
                                    onDelete={onDeleteMessage}
                                    onBillingContinue={onBillingContinue}
                                    onBillingDismiss={onBillingDismiss}
                                    onAuthSignIn={onAuthSignIn}
                                    onAuthDismiss={onAuthDismiss}
                                    onRunErrorDismiss={onRunErrorDismiss}
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
