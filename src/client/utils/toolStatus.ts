// Tool result status detection utilities

export type ToolResultStatus = 'success' | 'error' | 'neutral';

/**
 * Determine if a tool result indicates success or failure
 */
export function getToolResultStatus(toolResult: string | undefined, toolName: string | undefined): ToolResultStatus {
    if (!toolResult) return 'neutral';

    const lowerResult = toolResult.toLowerCase();

    // Tool-specific success indicators
    if (toolName === 'edit_file' || toolName === 'write_file') {
        if (lowerResult.includes('success') || lowerResult.includes('updated') || lowerResult.includes('created') || lowerResult.includes('wrote')) {
            return 'success';
        } else {
            return 'error';
        }
    }

    // For read/list/grep, having content usually means success
    if (toolName === 'view_file' || toolName === 'list_files' || toolName === 'grep_files') {
        if (toolResult.length > 0 && !lowerResult.startsWith('error')) {
            return 'success';
        } else {
            return 'error';
        }
    }

    // For bash_command, check for errors or non-zero exit codes
    if (toolName === 'bash_command') {
        if (lowerResult.includes('cancelled') || lowerResult.includes('[exit code:') || lowerResult.startsWith('error')) {
            return 'error';
        }
        return 'success';
    }

    return 'neutral';
}
