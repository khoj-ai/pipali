// Tool result status detection utilities

export type ToolResultStatus = 'success' | 'error' | 'neutral';

export interface MultimodalItem {
    type: string;
    text?: string;
    data?: string;
    mime_type?: string;
    source_type?: string;
}

/** Parse multimodal content from a tool result string */
export function parseMultimodalContent(result: string): MultimodalItem[] | null {
    if (!result.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(result);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
            return parsed as MultimodalItem[];
        }
    } catch { /* Not valid JSON */ }
    return null;
}

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

    // For generate_image, check if multimodal image content is present
    if (toolName === 'generate_image') {
        return parseMultimodalContent(toolResult) ? 'success' : 'error';
    }

    // For web tools, check if we got actual content (not an error)
    if (toolName === 'search_web' || toolName === 'read_webpage') {
        if (toolResult.length > 0 && !lowerResult.startsWith('error') && !lowerResult.startsWith('failed')) {
            return 'success';
        } else {
            return 'error';
        }
    }

    // Chrome browser MCP tools: content without error prefix means success
    if (toolName?.startsWith('chrome-browser__')) {
        if (toolResult.length > 0 && !lowerResult.startsWith('error') && !lowerResult.startsWith('failed')) {
            return 'success';
        }
        return 'error';
    }

    if (toolName && ['delegate_task', 'inspect_task', 'wait_for_tasks', 'stop_task'].includes(toolName)) {
        return lowerResult.startsWith('error') ? 'error' : 'success';
    }

    return 'neutral';
}
