/**
 * Confirmation Service
 *
 * Handles user confirmation requests for dangerous operations.
 * Works with any frontend (web, TUI) through a callback-based system.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    type ConfirmationRequest,
    type ConfirmationResponse,
    type ConfirmationResult,
    type ConfirmationPreferences,
    type DiffInfo,
    type CommandExecutionInfo,
    type ConfirmationResponseAttachment,
    CONFIRMATION_OPTIONS,
    createStandardConfirmationOptions,
} from './confirmation.types';

/**
 * How long an unanswered confirmation blocks its run before it is given up on.
 *
 * A run can be waiting while nobody is at the machine - a scheduled routine at 3am, or
 * a delegated task still going after the app was closed - so this is generous. Without
 * it those runs would block forever.
 */
export const CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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
    | 'fetch_internal_url'
    | 'change_sandbox_settings';

/**
 * Get risk level based on operation and optional sub-type.
 * For shell commands: read-only = low, read-write = high
 * For MCP tools: subType format is "serverName:safe" or "serverName:unsafe"
 */
function getRiskLevel(
    operation: ConfirmableOperation,
    operationSubType?: string
): 'low' | 'medium' | 'high' {
    // For execute_command, risk level depends on the command's operation type
    if (operation === 'execute_command' && operationSubType) {
        switch (operationSubType) {
            case 'read-only':
                return 'low';
            case 'read-write':
                return 'high';
        }
    }

    // For mcp_tool_call, subType format is "serverName:safe" or "serverName:unsafe"
    if (operation === 'mcp_tool_call' && operationSubType) {
        if (operationSubType.endsWith(':safe')) {
            return 'low';
        }
        if (operationSubType.endsWith(':unsafe')) {
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
        change_sandbox_settings: 'high',
    };

    return defaultRiskLevels[operation];
}

/** Dialog heading per operation. The client translates these by operation id. */
const CONFIRMATION_TITLES: Record<ConfirmableOperation, string> = {
    edit_file: 'Confirm File Edit',
    write_file: 'Confirm File Write',
    delete_file: 'Confirm File Deletion',
    execute_command: 'Confirm Command Execution',
    mcp_tool_call: 'Confirm Tool Call',
    read_sensitive_file: 'Confirm Sensitive File Access',
    grep_sensitive_path: 'Confirm Sensitive Path Search',
    fetch_internal_url: 'Confirm Internal Network Access',
    change_sandbox_settings: 'Confirm Permission Change',
};

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
    return {
        requestId: crypto.randomUUID(),
        inputType: 'choice',
        title: CONFIRMATION_TITLES[operation],
        message: details.additionalMessage,
        operation,
        context: {
            toolName: details.toolName,
            toolArgs: details.toolArgs,
            // Only include affectedFiles for actual file operations, not MCP tool calls
            affectedFiles: operation === 'mcp_tool_call' ? [] : [filePath],
            riskLevel: getRiskLevel(operation, details.operationSubType),
            operationType: details.operationSubType,
            commandInfo: details.commandInfo,
        },
        diff: details.diff,
        options: createStandardConfirmationOptions(operation),
        defaultOptionId: CONFIRMATION_OPTIONS.NO,
        timeoutMs: 0, // No timeout - wait for user
    };
}

/**
 * Create a confirmation request for a change to Pipali's own sandbox permissions.
 *
 * Yes or no only: a change that widens what Pipali may do unsupervised is exactly what
 * "don't ask again" would stop the user seeing.
 *
 * @param changes - What the change does, a line each, as describeSandboxChanges words it
 */
export function createPermissionChangeConfirmation(changes: string[]): ConfirmationRequest {
    return {
        requestId: crypto.randomUUID(),
        inputType: 'choice',
        title: CONFIRMATION_TITLES.change_sandbox_settings,
        message: [
            'Pipali asked to change its own sandbox permissions:',
            '',
            ...changes.map(change => `- ${change}`),
            '',
            'Apply this change?',
        ].join('\n'),
        summary: changes.join('; '),
        operation: 'change_sandbox_settings',
        context: { toolName: 'sandbox_settings', toolArgs: {}, riskLevel: 'high' },
        options: [
            {
                id: CONFIRMATION_OPTIONS.YES,
                label: 'Yes',
                description: 'Apply this permission change',
                style: 'primary',
            },
            {
                id: CONFIRMATION_OPTIONS.NO,
                label: 'No',
                description: 'Leave permissions as they are',
                style: 'danger',
            },
        ],
        defaultOptionId: CONFIRMATION_OPTIONS.NO,
        timeoutMs: 0,
    };
}

/**
 * The grant a "don't ask again" answer to this request is stored as, e.g. "edit_file" or
 * "mcp_tool_call:github:unsafe". A shell command grant names its operation type and working
 * directory, e.g. "execute_command:read-write:/home/me/project".
 */
export function getConfirmationKey(request: ConfirmationRequest): string {
    const { operation, context } = request;
    const key = context?.operationType ? `${operation}:${context.operationType}` : operation;
    return operation === 'execute_command' ? `${key}:${context?.commandInfo?.workdir}` : key;
}

/**
 * Whether a grant answers this request. A command's grant also answers commands of its
 * operation type in its subfolders.
 */
export function grantCovers(grant: string, request: ConfirmationRequest): boolean {
    const key = getConfirmationKey(request);
    if (grant === key) return true;

    const workdir = request.context?.commandInfo?.workdir;
    if (request.operation !== 'execute_command' || !workdir) return false;
    const prefix = key.slice(0, -workdir.length);
    return grant.startsWith(prefix) && coversSubfolder(grant.slice(prefix.length), workdir);
}

/**
 * A filesystem root, or a folder holding the home folder, covers itself alone: its
 * subfolders are nearly everything. Judged by real path, so no spelling of home slips by.
 */
function coversSubfolder(folder: string, subfolder: string): boolean {
    if (!isInside(folder, subfolder)) return false;
    try {
        const real = fs.realpathSync.native(folder);
        const home = fs.realpathSync.native(os.homedir());
        return path.parse(real).root !== real && real !== home && !isInside(real, home);
    } catch {
        return false;
    }
}

function isInside(folder: string, target: string): boolean {
    const relative = path.relative(folder, target);
    return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}

/** Check if an operation requires confirmation, given the grants the user has made */
export function requiresConfirmation(
    request: ConfirmationRequest,
    preferences: ConfirmationPreferences
): boolean {
    for (const grant of preferences.skipConfirmationFor) {
        if (grantCovers(grant, request)) return false;
    }
    return true;
}

export function formatConfirmationAttachmentBlock(attachments?: ConfirmationResponseAttachment[]): string {
    if (!attachments || attachments.length === 0) return '';

    const paths = attachments
        .map(attachment => attachment.path)
        .filter(path => typeof path === 'string' && path.trim().length > 0);

    if (paths.length === 0) return '';

    return `\n\n<attached_files>\n${paths.map(path => `- ${path}`).join('\n')}\n</attached_files>`;
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
        const attachmentBlock = formatConfirmationAttachmentBlock(response.attachments);
        if (response.selectedOptionId === CONFIRMATION_OPTIONS.GUIDANCE && response.guidance) {
            denialReason = `User denied the operation with guidance: ${response.guidance}${attachmentBlock}`;
        } else if (response.selectedOptionId === CONFIRMATION_OPTIONS.GUIDANCE && attachmentBlock) {
            denialReason = `User denied the operation with attachments:${attachmentBlock}`;
        } else {
            denialReason = `User denied the operation${attachmentBlock}`;
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
    const request = createFileOperationConfirmation(operation, filePath, details);

    if (!requiresConfirmation(request, context.preferences)) {
        return {
            approved: true,
            selectedOption: CONFIRMATION_OPTIONS.YES_DONT_ASK,
            skipFutureConfirmations: true,
        };
    }

    // Request confirmation from user via callback
    const response = await context.requestConfirmation(request);

    // Process the response
    const result = processConfirmationResponse(response);

    if (result.skipFutureConfirmations) {
        context.preferences.skipConfirmationFor.add(getConfirmationKey(request));
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
