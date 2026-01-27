/**
 * Confirmation Service
 *
 * Handles user confirmation requests for dangerous operations.
 * Works with any frontend (web, TUI) through a callback-based system.
 */

import {
    type ConfirmationRequest,
    type ConfirmationResponse,
    type ConfirmationResult,
    type ConfirmationPreferences,
    type DiffInfo,
    type CommandExecutionInfo,
    CONFIRMATION_OPTIONS,
    createStandardConfirmationOptions,
} from './confirmation.types';

/**
 * Callback function type for requesting confirmation from user
 * The implementer (WebSocket handler, TUI, etc.) provides this
 */
export type ConfirmationCallback = (request: ConfirmationRequest) => Promise<ConfirmationResponse>;

/**
 * Context for a confirmation-aware operation
 */
export interface ConfirmationContext {
    /** Callback to request confirmation from user */
    requestConfirmation: ConfirmationCallback;
    /** Current user preferences */
    preferences: ConfirmationPreferences;
    /** Session ID for tracking */
    sessionId?: string;
}

/**
 * Operations that require confirmation
 */
export type ConfirmableOperation =
    | 'edit_file'
    | 'write_file'
    | 'delete_file'
    | 'execute_command'
    | 'mcp_tool_call'
    | 'read_sensitive_file'
    | 'grep_sensitive_path'
    | 'fetch_internal_url';

/**
 * Get risk level based on operation and optional sub-type.
 * For shell commands: read-only = low, write-only = medium, read-write = high
 * For MCP tools: safe = low, unsafe = high
 */
function getRiskLevel(
    operation: ConfirmableOperation,
    operationSubType?: string
): 'low' | 'medium' | 'high' {
    // For execute_command, risk level depends on operation_type directly
    if (operation === 'execute_command' && operationSubType) {
        switch (operationSubType) {
            case 'read-only':
                return 'low';
            case 'write-only':
                return 'medium';
            case 'read-write':
                return 'high';
        }
    }

    // For mcp_tool_call, subType is "safe" or "unsafe"
    if (operation === 'mcp_tool_call' && operationSubType) {
        if (operationSubType === 'safe') {
            return 'low';
        }
        if (operationSubType === 'unsafe') {
            return 'high';
        }
    }

    // Default risk levels for other operations
    const defaultRiskLevels: Record<ConfirmableOperation, 'low' | 'medium' | 'high'> = {
        edit_file: 'medium',
        write_file: 'medium',
        delete_file: 'high',
        execute_command: 'high',
        mcp_tool_call: 'medium',
        read_sensitive_file: 'medium',
        grep_sensitive_path: 'medium',
        fetch_internal_url: 'medium',
    };

    return defaultRiskLevels[operation];
}

/**
 * Create a new confirmation request for a file operation
 */
export function createFileOperationConfirmation(
    operation: ConfirmableOperation,
    filePath: string,
    details: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        additionalMessage?: string;
        diff?: DiffInfo;
        operationSubType?: string;
        /** Structured command execution info (for shell_command operations) */
        commandInfo?: CommandExecutionInfo;
    }
): ConfirmationRequest {
    const titles: Record<ConfirmableOperation, string> = {
        edit_file: 'Confirm File Edit',
        write_file: 'Confirm File Write',
        delete_file: 'Confirm File Deletion',
        execute_command: 'Confirm Command Execution',
        mcp_tool_call: 'Confirm MCP Tool Call',
        read_sensitive_file: 'Confirm Sensitive File Access',
        grep_sensitive_path: 'Confirm Sensitive Path Search',
        fetch_internal_url: 'Confirm Internal Network Access',
    };

    return {
        requestId: crypto.randomUUID(),
        inputType: 'choice',
        title: titles[operation],
        message: details.additionalMessage,
        operation,
        context: {
            toolName: details.toolName,
            toolArgs: details.toolArgs,
            affectedFiles: [filePath],
            riskLevel: getRiskLevel(operation, details.operationSubType),
            operationType: details.operationSubType,
            commandInfo: details.commandInfo,
        },
        diff: details.diff,
        options: createStandardConfirmationOptions(),
        defaultOptionId: CONFIRMATION_OPTIONS.NO,
        timeoutMs: 0, // No timeout - wait for user
    };
}

/**
 * Check if an operation requires confirmation
 * @param operationKey - Either a ConfirmableOperation or a composite key like "execute_command:read-only"
 */
export function requiresConfirmation(
    operationKey: string,
    preferences: ConfirmationPreferences
): boolean {
    return !preferences.skipConfirmationFor.has(operationKey);
}

/**
 * Process a confirmation response and return the result
 */
export function processConfirmationResponse(
    response: ConfirmationResponse
): ConfirmationResult {
    const approved = response.selectedOptionId === CONFIRMATION_OPTIONS.YES ||
        response.selectedOptionId === CONFIRMATION_OPTIONS.YES_DONT_ASK;

    const skipFutureConfirmations = response.selectedOptionId === CONFIRMATION_OPTIONS.YES_DONT_ASK;

    // Build denial reason, including guidance if provided
    let denialReason: string | undefined;
    if (!approved) {
        if (response.selectedOptionId === CONFIRMATION_OPTIONS.GUIDANCE && response.guidance) {
            denialReason = `User denied the operation with guidance: ${response.guidance}`;
        } else {
            denialReason = 'User denied the operation';
        }
    }

    return {
        approved,
        selectedOption: response.selectedOptionId,
        skipFutureConfirmations,
        denialReason,
    };
}

/**
 * Request confirmation for an operation
 *
 * @param operation - The type of operation
 * @param filePath - Path to the affected file
 * @param context - Confirmation context with callback and preferences
 * @param details - Additional details about the operation
 * @returns ConfirmationResult with approval status
 */
export async function requestOperationConfirmation(
    operation: ConfirmableOperation,
    filePath: string,
    context: ConfirmationContext,
    details: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        additionalMessage?: string;
        diff?: DiffInfo;
        /** Optional read/read-write sub-type for finer-grained confirmation tracking (used by shell_command) */
        operationSubType?: string;
        commandInfo?: CommandExecutionInfo;
    }
): Promise<ConfirmationResult> {
    // Build the confirmation key - includes sub-type if provided for finer-grained tracking
    // e.g., "execute_command:read-only" vs "execute_command:read-write"
    const confirmationKey = details.operationSubType
        ? `${operation}:${details.operationSubType}`
        : operation;

    // Check if user has opted to skip confirmations for this operation (or operation+subtype combo)
    if (!requiresConfirmation(confirmationKey, context.preferences)) {
        return {
            approved: true,
            selectedOption: CONFIRMATION_OPTIONS.YES_DONT_ASK,
            skipFutureConfirmations: true,
        };
    }

    // Create the confirmation request
    const request = createFileOperationConfirmation(operation, filePath, details);

    // Request confirmation from user via callback
    const response = await context.requestConfirmation(request);

    // Process the response
    const result = processConfirmationResponse(response);

    // Update preferences if user chose "don't ask again"
    // Store with the full key (including sub-type) for granular control
    if (result.skipFutureConfirmations) {
        context.preferences.skipConfirmationFor.add(confirmationKey);
    }

    return result;
}

/**
 * Create a new empty preferences object
 */
export function createEmptyPreferences(): ConfirmationPreferences {
    return {
        skipConfirmationFor: new Set(),
    };
}

/**
 * Serialize preferences for storage
 */
export function serializePreferences(preferences: ConfirmationPreferences): string {
    return JSON.stringify({
        skipConfirmationFor: Array.from(preferences.skipConfirmationFor),
    });
}

/**
 * Deserialize preferences from storage
 */
export function deserializePreferences(data: string): ConfirmationPreferences {
    try {
        const parsed = JSON.parse(data);
        return {
            skipConfirmationFor: new Set(parsed.skipConfirmationFor || []),
        };
    } catch {
        return createEmptyPreferences();
    }
}
