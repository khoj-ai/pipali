// Toast container for confirmation notifications from background conversations

import React from 'react';
import type { ConfirmationRequest, ConversationSummary } from '../../types';
import { ConfirmationToast } from './ConfirmationToast';

interface ToastContainerProps {
    confirmations: Map<string, ConfirmationRequest>;
    conversations: ConversationSummary[];
    currentConversationId?: string;
    onRespond: (convId: string, optionId: string) => void;
    onDismiss: (convId: string) => void;
}

export function ToastContainer({
    confirmations,
    conversations,
    currentConversationId,
    onRespond,
    onDismiss,
}: ToastContainerProps) {
    // Filter out confirmations for current conversation (shown inline instead)
    const toastConfirmations = Array.from(confirmations.entries())
        .filter(([convId]) => convId !== currentConversationId);

    if (toastConfirmations.length === 0) return null;

    return (
        <div className="toast-container">
            {toastConfirmations.map(([convId, request]) => {
                const conv = conversations.find(c => c.id === convId);
                return (
                    <ConfirmationToast
                        key={request.requestId}
                        convId={convId}
                        convTitle={conv?.title || 'Background Task'}
                        request={request}
                        onRespond={onRespond}
                        onDismiss={onDismiss}
                    />
                );
            })}
        </div>
    );
}
