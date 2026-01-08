// Toast container for confirmation notifications from background tasks

import type { PendingConfirmation } from '../../types/confirmation';
import { ConfirmationToast } from './ConfirmationToast';

interface ToastContainerProps {
    confirmations: PendingConfirmation[];
    currentConversationId?: string;
    onRespond: (confirmation: PendingConfirmation, optionId: string, guidance?: string) => void;
    onDismiss: (confirmation: PendingConfirmation) => void;
    onNavigateToConversation?: (conversationId: string) => void;
    onNavigateToAutomations?: () => void;
}

export function ToastContainer({
    confirmations,
    currentConversationId,
    onRespond,
    onDismiss,
    onNavigateToConversation,
    onNavigateToAutomations,
}: ToastContainerProps) {
    // Filter out confirmations for current conversation (shown inline instead)
    const toastConfirmations = confirmations.filter(c => {
        if (c.source.type === 'chat') {
            return c.source.conversationId !== currentConversationId;
        }
        // Always show automation confirmations as toasts
        return true;
    });

    if (toastConfirmations.length === 0) return null;

    return (
        <div className="toast-container">
            {toastConfirmations.map((confirmation) => (
                <ConfirmationToast
                    key={confirmation.key}
                    confirmation={confirmation}
                    onRespond={(key, optionId, guidance) => onRespond(confirmation, optionId, guidance)}
                    onDismiss={() => onDismiss(confirmation)}
                    onNavigateToConversation={onNavigateToConversation}
                    onNavigateToAutomations={onNavigateToAutomations}
                />
            ))}
        </div>
    );
}
