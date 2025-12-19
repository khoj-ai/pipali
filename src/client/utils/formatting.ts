// Formatting utilities for tool names, arguments, and display

/**
 * Convert snake_case tool name to Title Case
 */
export function formatToolName(name: string): string {
    return name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Format tool arguments for display based on tool type
 */
export function formatToolArgs(toolName: string, args: any): string {
    if (!args || typeof args !== 'object') return '';

    // Tool-specific formatting for readability
    switch (toolName) {
        case 'view_file':
            if (args.offset || args.limit) {
                const offsetStr = args.offset ? `${args.offset}` : '1';
                const limitStr = args.limit ? `${args.offset + args.limit}` : '';
                const params = [offsetStr, limitStr].filter(Boolean).join('-');
                return `${args.path} (lines ${params})`;
            }
            return args.path || '';

        case 'list_files':
            if (args.path && args.pattern) {
                return `${args.path}/${args.pattern}`;
            }
            return args.path || args.pattern || '';

        case 'grep_files':
            const parts = [];
            if (args.pattern) parts.push(`"${args.pattern}"`);
            if (args.path) parts.push(`in ${args.path}`);
            if (args.include) parts.push(`(${args.include})`);
            return parts.join(' ');

        case 'edit_file':
        case 'write_file':
            return args.file_path || '';

        case 'bash_command':
            return args.justification || '';

        default:
            // Generic formatting: show key values in a readable way
            return Object.entries(args)
                .filter(([_, v]) => v !== undefined && v !== null && v !== '')
                .map(([k, v]) => {
                    if (typeof v === 'string' && v.length > 50) {
                        return `${k}: "${v.slice(0, 47)}..."`;
                    }
                    return typeof v === 'string' ? `${k}: "${v}"` : `${k}: ${v}`;
                })
                .join(', ');
    }
}

/**
 * Extract filename from path
 */
export function getFileName(path: string): string {
    if (!path) return '';
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
}

/**
 * Format tool calls for sidebar subtitle display
 * Uses the same friendly names and formatting as the train of thought display
 */
export function formatToolCallsForSidebar(toolCalls: any[]): string {
    if (!toolCalls || toolCalls.length === 0) return '';

    const friendlyNames: Record<string, string> = {
        "view_file": "Read",
        "list_files": "List",
        "grep_files": "Search",
        "edit_file": "Edit",
        "write_file": "Write",
        "bash_command": "Shell",
        "read_file": "Read",
        "text": "Respond",
    };

    // Format each tool call with friendly name and key argument
    const formatted = toolCalls.map(tc => {
        const toolName = tc.function_name || '';
        const friendly = friendlyNames[toolName] || formatToolName(toolName);
        const args = tc.arguments || {};

        // Get a concise description of what's being done
        let detail = '';
        switch (toolName) {
            case 'view_file':
            case 'read_file':
                detail = args.path ? ` ${getFileName(args.path)}` : '';
                break;
            case 'list_files':
                detail = args.path ? ` ${args.path}` : '';
                break;
            case 'grep_files':
                detail = args.pattern ? ` "${args.pattern}"` : '';
                break;
            case 'edit_file':
            case 'write_file':
                detail = args.file_path ? ` ${getFileName(args.file_path)}` : '';
                break;
            case 'bash_command':
                detail = args.justification ? ` ${args.justification}` : '';
                break;
        }

        return `${friendly}${detail}`;
    });

    // Join multiple tool calls
    return formatted.join(', ');
}

/**
 * Get friendly display name for a tool
 */
export function getFriendlyToolName(toolName: string): string {
    const friendlyNames: Record<string, string> = {
        "view_file": "Read",
        "list_files": "List",
        "grep_files": "Search",
        "edit_file": "Edit",
        "write_file": "Write",
        "bash_command": "Shell",
    };
    return friendlyNames[toolName] || formatToolName(toolName);
}
