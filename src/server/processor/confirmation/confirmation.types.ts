/**
 * User Confirmation Types
 *
 * A modular, extensible confirmation system for dangerous/state-changing operations.
 * Designed to be frontend-agnostic (supports web, TUI, etc.)
 */

/**
 * Supported confirmation input types for extensibility
 */
export type ConfirmationInputType =
    | 'choice'       // Simple yes/no/custom choice (current)
    | 'multi_select' // Multiple options can be selected (future)
    | 'number_range' // Numeric input within bounds (future)
    | 'text_input';  // Free-form text input (future)

/**
 * Base option for choice-based confirmations
 */
export interface ConfirmationOption {
    /** Unique identifier for this option */
    id: string;
    /** Display label shown to user */
    label: string;
    /** Optional description/explanation */
    description?: string;
    /** Visual style hint for the frontend */
    style?: 'primary' | 'secondary' | 'danger' | 'warning';
    /** If true, this option persists the preference (e.g., "don't ask again") */
    persistPreference?: boolean;
}

/**
 * Diff information for edit operations
 */
export interface DiffInfo {
    /** The file being modified */
    filePath: string;
    /** Text being replaced (for edit operations) */
    oldText?: string;
    /** New text replacing the old (for edit operations) */
    newText?: string;
    /** Whether this is a new file or overwrite */
    isNewFile?: boolean;
}

/**
 * Request sent from server to client asking for user confirmation
 */
export interface ConfirmationRequest {
    /** Unique ID for this confirmation request */
    requestId: string;
    /** Type of confirmation input expected */
    inputType: ConfirmationInputType;
    /** Title/header for the confirmation dialog */
    title: string;
    /** Detailed message explaining what will happen */
    message: string;
    /** The operation being confirmed (for logging/tracking) */
    operation: string;
    /** Additional context about the operation */
    context?: {
        /** Tool name requesting confirmation */
        toolName: string;
        /** Tool arguments for display */
        toolArgs: Record<string, unknown>;
        /** Files affected */
        affectedFiles?: string[];
        /** Risk level indicator */
        riskLevel?: 'low' | 'medium' | 'high';
        /** Operation sub-type for display (e.g., 'read-only', 'write-only', 'read-write' for bash commands) */
        operationType?: string;
    };
    /** Diff information for showing what changes will be made */
    diff?: DiffInfo;
    /** Available options for choice-based confirmations */
    options: ConfirmationOption[];
    /** Default option ID if user doesn't respond */
    defaultOptionId?: string;
    /** Timeout in milliseconds (0 = no timeout) */
    timeoutMs?: number;
}

/**
 * Response sent from client to server with user's decision
 */
export interface ConfirmationResponse {
    /** Must match the requestId from ConfirmationRequest */
    requestId: string;
    /** ID of the selected option ('yes', 'yes_dont_ask', 'no', or 'guidance') */
    selectedOptionId: string;
    /** User-provided guidance/alternative instructions (sent when selectedOptionId is 'guidance') */
    guidance?: string;
    /** Additional data for extended input types */
    inputData?: {
        /** For multi_select: array of selected option IDs */
        selectedIds?: string[];
        /** For number_range: numeric value */
        numericValue?: number;
        /** For text_input: user's text */
        textValue?: string;
    };
    /** Whether user chose to persist this preference */
    persistPreference?: boolean;
    /** Timestamp of response */
    timestamp: string;
}

/**
 * Standard confirmation option IDs
 */
export const CONFIRMATION_OPTIONS = {
    YES: 'yes',
    YES_DONT_ASK: 'yes_dont_ask',
    NO: 'no',
    GUIDANCE: 'guidance',  // User provided alternative instructions (implicitly declines)
} as const;

/**
 * Create standard 3-option confirmation (Yes, Yes and don't ask again, No)
 */
export function createStandardConfirmationOptions(): ConfirmationOption[] {
    return [
        {
            id: CONFIRMATION_OPTIONS.YES,
            label: 'Yes',
            description: 'Proceed with this operation',
            style: 'primary',
        },
        {
            id: CONFIRMATION_OPTIONS.YES_DONT_ASK,
            label: "Yes, don't ask again",
            description: 'Proceed and skip future confirmations for this operation type',
            style: 'secondary',
            persistPreference: true,
        },
        {
            id: CONFIRMATION_OPTIONS.NO,
            label: 'No',
            description: 'Cancel this operation',
            style: 'danger',
        },
    ];
}


/**
 * Result of a confirmation check
 */
export interface ConfirmationResult {
    /** Whether the operation was approved */
    approved: boolean;
    /** The option that was selected */
    selectedOption: string;
    /** Whether to skip future confirmations */
    skipFutureConfirmations: boolean;
    /** If denied, optional message explaining why */
    denialReason?: string;
}

/**
 * WebSocket message types for confirmation flow
 */
export interface ConfirmationWebSocketMessage {
    type: 'confirmation_request';
    data: ConfirmationRequest;
}

export interface ConfirmationResponseWebSocketMessage {
    type: 'confirmation_response';
    data: ConfirmationResponse;
}

/**
 * Stored user preferences for skipping confirmations
 */
export interface ConfirmationPreferences {
    /** Operations that user has chosen to skip confirmations for */
    skipConfirmationFor: Set<string>;
}
