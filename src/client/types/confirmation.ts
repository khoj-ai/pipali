// Confirmation types for user approval dialogs

export type ConfirmationOption = {
    id: string;
    label: string;
    description?: string;
    style?: 'primary' | 'secondary' | 'danger' | 'warning';
    persistPreference?: boolean;
};

export type DiffInfo = {
    filePath: string;
    oldText?: string;
    newText?: string;
    isNewFile?: boolean;
};

export type CommandExecutionInfo = {
    command: string;
    reason: string;
    workdir: string;
};

export type ConfirmationRequest = {
    requestId: string;
    inputType: 'choice' | 'multi_select' | 'number_range' | 'text_input';
    title: string;
    message?: string;
    operation: string;
    context?: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        affectedFiles?: string[];
        riskLevel?: 'low' | 'medium' | 'high';
        /** Operation sub-type for display (e.g., 'read-only', 'write-only', 'read-write' for bash commands) */
        operationType?: string;
        /** Structured command execution info (for bash_command operations) */
        commandInfo?: CommandExecutionInfo;
    };
    diff?: DiffInfo;
    options: ConfirmationOption[];
    defaultOptionId?: string;
    timeoutMs?: number;
};

// Source of the confirmation - determines visual treatment and response channel
export type ConfirmationSource =
    | { type: 'chat'; conversationId: string; conversationTitle: string }
    | { type: 'automation'; confirmationId: string; automationId: string; automationName: string; executionId: string; conversationId: string | null };

// Pending confirmation type for both chat and automation confirmations
export type PendingConfirmation = {
    key: string;                    // Unique key for React
    request: ConfirmationRequest;
    source: ConfirmationSource;
    expiresAt?: string;             // Optional expiration (automations have this)
};
