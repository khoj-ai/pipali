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

export type ConfirmationRequest = {
    requestId: string;
    inputType: 'choice' | 'multi_select' | 'number_range' | 'text_input';
    title: string;
    message: string;
    operation: string;
    context?: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        affectedFiles?: string[];
        riskLevel?: 'low' | 'medium' | 'high';
    };
    diff?: DiffInfo;
    options: ConfirmationOption[];
    defaultOptionId?: string;
    timeoutMs?: number;
};
