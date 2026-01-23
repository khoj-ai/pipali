// Tool result status detection utilities

export type ToolResultStatus = 'success' | 'error' | 'neutral';

/**
 * Determine if a tool result indicates success or failure
 */
export function getToolResultStatus(toolResult: string | undefined, toolName: string | undefined): ToolResultStatus {
    if (!toolResult) return 'neutral';

    const lowerResult = toolResult.toLowerCase();
    if (lowerResult.includes('[interrupted]')) return 'error';

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

    // For shell_command, check for errors or non-zero exit codes
    if (toolName === 'shell_command') {
        if (lowerResult.includes('cancelled') || lowerResult.includes('[exit code:') || lowerResult.startsWith('error')) {
            return 'error';
        }
        return 'success';
    }

    // For web tools, check if we got actual content (not an error)
    if (toolName === 'search_web' || toolName === 'read_webpage') {
        if (toolResult.length > 0 && !lowerResult.startsWith('error') && !lowerResult.startsWith('failed')) {
            return 'success';
        } else {
            return 'error';
        }
    }

    return 'neutral';
}
