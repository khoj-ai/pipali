// Formatting utilities for tool names, arguments, and display

import { CONVERSATION_HEADER, PIPALI_MEMORY_RELATIVE_DIR } from '../../shared';
import { resolveUidLabel } from './snapshotParser';

/** Format bytes to a human-readable file size string. */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Convert snake_case tool name to Title Case
 */
export function convertSnakeToTitleCase(name: string): string {
    return name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Parse MCP tool name ("server-name__tool_name") into parts with friendly display name.
 * Returns null for non-MCP tool names.
 */
export function parseMcpToolName(toolName: string): { serverName: string; toolName: string; friendlyName: string } | null {
    const sep = toolName.indexOf('__');
    if (sep === -1) return null;
    const serverName = toolName.slice(0, sep);
    const tool = toolName.slice(sep + 2);
    const friendlyServer = serverName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const friendlyTool = convertSnakeToTitleCase(tool);
    return { serverName, toolName: tool, friendlyName: `${friendlyServer}: ${friendlyTool}` };
}

/**
 * Strip server prefix from MCP operation type for display.
 * "chrome-browser:safe" → "safe", "read-only" → "read-only"
 */
export function cleanOperationType(opType: string): string {
    const colonIdx = opType.lastIndexOf(':');
    if (colonIdx === -1) return opType;
    const suffix = opType.slice(colonIdx + 1);
    // Only strip if suffix is a known MCP safety level
    if (suffix === 'safe' || suffix === 'unsafe') return suffix;
    return opType;
}

/**
 * Format tool arguments as plain text. Used as fallback for tools
 * not handled by formatToolArgsRich (shell_command, search_web, unknown tools).
 */
export function formatToolArgs(toolName: string, args: any): string {
    if (!args || typeof args !== 'object') return '';

    switch (toolName) {
        case 'shell_command':
            return args.justification || '';

        case 'search_web':
            return args.query ? `${args.query}` : '';

        case 'delegate_task':
            return args.title || args.message || '';

        case 'stop_process':
            return args.pid ? `pid ${args.pid}` : '';

        default:
            return Object.entries(args)
                .filter(([k, v]) => v !== undefined && v !== null && v !== '' && k !== 'operation_type')
                .map(([k, v]) => {
                    if (typeof v === 'string' && v.length > 50) {
                        return `${k}: "${v.slice(0, 47)}..."`;
                    }
                    return typeof v === 'string' ? `${k}: "${v}"` : `${k}: ${v}`;
                })
                .join(', ');
    }
}

/** Normalize path separators for platform-independent display parsing. */
function normalizePathSeparators(path: string): string {
    return path.replace(/\\/g, '/');
}

/** Extract filename from path. */
export function getFileName(path: string): string {
    if (!path) return '';
    const parts = normalizePathSeparators(path).split('/');
    return parts[parts.length - 1] || path;
}

const MEMORY_FILE_TOOLS = new Set(['view_file', 'edit_file', 'write_file']);

/** Whether a file tool is operating on Pipali's persistent memory store. */
function isMemoryFileToolCall(toolName: string, args: any): boolean {
    if (!MEMORY_FILE_TOOLS.has(toolName) || !args || typeof args !== 'object') return false;

    const filePath = toolName === 'view_file' ? args.path : args.file_path;
    if (typeof filePath !== 'string') return false;

    const normalized = normalizePathSeparators(filePath).replace(/\/+/g, '/');
    return normalized.endsWith('.md')
        && `/${normalized}`.includes(`/${PIPALI_MEMORY_RELATIVE_DIR}/`);
}

/**
 * Format tool calls for sidebar subtitle display
 * Uses the same friendly names and formatting as the train of thought display
 */
export function formatToolCallsForSidebar(toolCalls: any[]): string {
    if (!toolCalls || toolCalls.length === 0) return '';

    // Format each tool call with friendly name and key argument
    const formatted = toolCalls.map(tc => {
        const toolName = tc.function_name || '';
        const friendly = getFriendlyToolName(toolName);
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
            case 'shell_command':
                detail = args.justification ? ` ${args.justification}` : '';
                break;
            case 'search_web':
                detail = args.query ? ` ${args.query}` : '';
                break;
            case 'delegate_task':
                detail = args.title ? ` ${args.title}` : '';
                break;
            case 'stop_process':
                detail = args.pid ? ` pid ${args.pid}` : '';
                break;
            case 'generate_image':
                if (args.prompt) {
                    const end = args.prompt.search(/[.!?](\s|$)/);
                    detail = end > 0 && end < args.prompt.length - 1
                        ? ` "${args.prompt.slice(0, end + 1)}\u2026"`
                        : ` "${args.prompt}"`;
                }
                break;
            case 'read_webpage':
                if (args.url) {
                    try {
                        const url = new URL(args.url);
                        detail = ` ${url.hostname}`;
                    } catch {
                        detail = ` ${args.url}`;
                    }
                }
                break;
            case 'chrome-browser__navigate_page':
            case 'chrome-browser__new_page':
                if (args.url) {
                    try {
                        const url = new URL(args.url);
                        detail = ` ${url.hostname}`;
                    } catch {
                        detail = ` ${args.url}`;
                    }
                }
                break;
            case 'chrome-browser__click':
            case 'chrome-browser__hover':
                detail = args.uid ? ` ${args.uid}` : '';
                break;
            case 'chrome-browser__fill':
                detail = args.value ? ` "${args.value.length > 20 ? args.value.slice(0, 17) + '\u2026' : args.value}"` : '';
                break;
            case 'chrome-browser__press_key':
                detail = args.key ? ` ${args.key}` : '';
                break;
            case 'chrome-browser__wait_for':
                detail = args.text ? ` "${args.text}"` : '';
                break;
        }

        return `${friendly}${detail}`;
    });

    // Join multiple tool calls
    return formatted.join(', ');
}

// Tool activity categories for visual icon trail display
export type ToolCategory = 'web' | 'read' | 'write' | 'execute' | 'other';

/**
 * Categorize a tool by its name for the icon trail summary.
 */
export function getToolCategory(toolName: string): ToolCategory {
    switch (toolName) {
        case 'search_web':
        case 'read_webpage':
            return 'web';
        case 'view_file':
        case 'list_files':
        case 'grep_files':
            return 'read';
        case 'edit_file':
        case 'write_file':
        case 'generate_image':
        case 'email_user':
            return 'write';
        case 'shell_command':
        case 'stop_process':
            return 'execute';
        case 'delegate_task':
        case 'stop_task':
            return 'execute';
        case 'inspect_task':
        case 'wait_for_tasks':
            return 'read';
        default:
            if (toolName.startsWith('chrome') || toolName.startsWith('browser'))
                return 'web';
            return 'other';
    }
}

/**
 * Get friendly display name for a tool.
 * MCP tools (server__tool_name) get "Server Tool Name" format automatically.
 */
export function getFriendlyToolName(toolName: string): string {
    const friendlyNames: Record<string, string> = {
        "view_file": "Read",
        "list_files": "List",
        "grep_files": "Search",
        "edit_file": "Edit",
        "write_file": "Write",
        "shell_command": "Shell",
        "stop_process": "Stop",
        "search_web": "Search",
        "read_webpage": "Read",
        "generate_image": "Generate",
        "delegate_task": "Delegate",
        "inspect_task": "Check",
        "stop_task": "Stop",
        "wait_for_tasks": "Wait",
    };
    if (friendlyNames[toolName]) return friendlyNames[toolName];

    const mcp = parseMcpToolName(toolName);
    if (mcp) return mcp.friendlyName;

    return convertSnakeToTitleCase(toolName);
}

/** Rich tool args with optional link, hover text, and secondary context */
export interface RichToolArgs {
    text: string;
    secondary?: string; // De-emphasized context like "in folder/path"
    url?: string;
    hoverText?: string;
}

export interface DelegationToolText {
    background: string;
    modelTier: (tier: string) => string;
    waitForTasks: (tasks: string) => string;
    noRunInProgress: string;
}

/**
 * Split a path into basename and folder with home dir stripped.
 * Returns [basename, folder] where folder has ~/ prefix removed.
 */
function splitPath(fullPath: string): [string, string] {
    const shortened = shortenHomePath(fullPath);
    const lastSlash = shortened.lastIndexOf('/');
    if (lastSlash <= 0) return [shortened, ''];
    const basename = shortened.slice(lastSlash + 1);
    let folder = shortened.slice(0, lastSlash);
    if (folder.startsWith('~/')) folder = folder.slice(2);
    else if (folder === '~') folder = '';
    return [basename, folder];
}

/**
 * Format tool arguments with rich data for interactive display.
 * File tools return structured primary/secondary text at all detail levels.
 * In outline mode, primary is basename; in full mode, primary includes more context.
 */
export function formatToolArgsRich(
    toolName: string,
    args: any,
    outline = false,
    uidMap?: Map<string, { role: string; label: string }>,
    delegatedTaskTitles?: Map<string, string>,
    delegationText?: DelegationToolText,
): RichToolArgs | null {
    if (!args || typeof args !== 'object') return null;

    switch (toolName) {
        case 'view_file': {
            if (!args.path) return null;
            const [basename, folder] = splitPath(args.path);
            let text = basename;
            if (!outline && (args.offset || args.limit)) {
                const offsetStr = args.offset ? `${args.offset}` : '1';
                const limitStr = args.limit ? `${args.offset + args.limit}` : '';
                text += ` (lines ${[offsetStr, limitStr].filter(Boolean).join('-')})`;
            }
            const secondary = isMemoryFileToolCall(toolName, args)
                ? 'in memories'
                : folder ? `in ${folder}` : undefined;
            return { text, secondary, url: `file://${args.path}`, hoverText: args.path };
        }
        case 'edit_file':
        case 'write_file': {
            if (!args.file_path) return null;
            const [basename, folder] = splitPath(args.file_path);
            const secondary = isMemoryFileToolCall(toolName, args)
                ? 'in memories'
                : folder ? `in ${folder}` : undefined;
            return { text: basename, secondary, url: `file://${args.file_path}`, hoverText: args.file_path };
        }
        case 'list_files': {
            if (!args.path) return null;
            const dir = shortenHomePath(args.path).replace(/^~\/?/, '');
            const primary = args.pattern || getFileName(args.path);
            return { text: primary, secondary: dir ? `in ${dir}` : undefined, hoverText: args.path };
        }
        case 'grep_files': {
            const primary = args.pattern ? `"${args.pattern}"` : '';
            if (!primary) return null;
            const dir = args.path ? shortenHomePath(args.path).replace(/^~\/?/, '') : '';
            const hoverText = [args.pattern, args.path, args.include].filter(Boolean).join(' ');
            let secondary = dir ? `in ${dir}` : undefined;
            if (!outline && args.include && secondary) secondary += ` (${args.include})`;
            else if (!outline && args.include) secondary = `(${args.include})`;
            return { text: primary, secondary, hoverText };
        }
        case 'read_webpage': {
            if (!args.url) return null;
            let displayUrl = args.url;
            try {
                const url = new URL(args.url);
                displayUrl = url.hostname + (url.pathname !== '/' ? url.pathname : '');
            } catch { /* use full url */ }

            const hoverParts = ["Read"];
            if (args.query) hoverParts.push(`about "${args.query}" in`);
            hoverParts.push(args.url);

            return {
                text: displayUrl,
                url: args.url,
                hoverText: hoverParts.join(' '),
            };
        }

        case 'delegate_task': {
            // title is a required argument, so the fallback is for a model that skipped it
            const text = args.title || args.message?.split('\n')[0];
            if (!text) return null;
            const secondary = [
                typeof args.model_tier === 'string'
                    ? delegationText?.modelTier(args.model_tier) ?? args.model_tier
                    : undefined,
                args.run_in_background !== false ? delegationText?.background : undefined,
            ].filter(Boolean).join(' ');
            return { text, secondary: secondary || undefined, hoverText: args.message };
        }
        case 'wait_for_tasks': {
            const ids: string[] = Array.isArray(args.conversation_ids)
                ? args.conversation_ids.filter((id: unknown): id is string => typeof id === 'string')
                : [];
            if (ids.length === 0) return null;
            const tasks = ids.map(id => delegatedTaskTitles?.get(id) ?? id).join(', ');
            return {
                text: delegationText?.waitForTasks(tasks) ?? tasks,
                hoverText: ids.join(', '),
            };
        }

        case 'inspect_task':
        case 'stop_task': {
            if (typeof args.conversation_id !== 'string') return null;
            const title = delegatedTaskTitles?.get(args.conversation_id);
            return {
                text: title ?? args.conversation_id,
                hoverText: args.conversation_id,
            };
        }

        case 'generate_image': {
            if (!args.prompt) return null;
            let text = args.prompt;
            if (outline) {
                // Truncate at first sentence boundary (. ! ?) followed by a space or end
                const sentenceEnd = args.prompt.search(/[.!?](\s|$)/);
                if (sentenceEnd > 0 && sentenceEnd < args.prompt.length - 1) {
                    text = args.prompt.slice(0, sentenceEnd + 1) + '\u2026';
                }
            }
            const secondary = args.aspect_ratio ? `Aspect Ratio: ${args.aspect_ratio}` : undefined;
            return { text, secondary, hoverText: args.prompt };
        }

        // Chrome browser MCP tools
        case 'chrome-browser__navigate_page': {
            if (!args.url) return args.type === 'reload' ? { text: 'Reload' } : null;
            let displayUrl = args.url;
            try {
                const url = new URL(args.url);
                displayUrl = url.hostname + (url.pathname !== '/' ? url.pathname : '');
            } catch { /* use full url */ }
            return { text: displayUrl, url: args.url, hoverText: args.url };
        }
        case 'chrome-browser__new_page': {
            if (!args.url) return null;
            let displayUrl = args.url;
            try {
                const url = new URL(args.url);
                displayUrl = url.hostname + (url.pathname !== '/' ? url.pathname : '');
            } catch { /* use full url */ }
            return { text: displayUrl, url: args.url, hoverText: args.url };
        }
        case 'chrome-browser__take_screenshot': {
            const label = args.uid ? resolveUidLabel(args.uid, uidMap) : 'Page';
            const secondary = args.format && args.format !== 'png' ? args.format : undefined;
            return { text: `of ${label}`, secondary };
        }
        case 'chrome-browser__take_snapshot': {
            const label = args.uid ? resolveUidLabel(args.uid, uidMap) : 'Page';
            return { text: `of ${label}` };
        }
        case 'chrome-browser__click': {
            if (!args.uid) return null;
            return { text: `on ${resolveUidLabel(args.uid, uidMap)}`, hoverText: `uid=${args.uid}` };
        }
        case 'chrome-browser__hover': {
            if (!args.uid) return null;
            return { text: `on ${resolveUidLabel(args.uid, uidMap)}`, hoverText: `uid=${args.uid}` };
        }
        case 'chrome-browser__drag': {
            if (!args.from_uid || !args.to_uid) return null;
            return { text: `${resolveUidLabel(args.from_uid, uidMap)} → ${resolveUidLabel(args.to_uid, uidMap)}` };
        }
        case 'chrome-browser__fill': {
            if (!args.value) return null;
            const val = args.value.length > 30 ? args.value.slice(0, 27) + '\u2026' : args.value;
            const target = args.uid ? resolveUidLabel(args.uid, uidMap) : undefined;
            return { text: `"${val}"`, secondary: target ? `in ${target}` : undefined, hoverText: args.value };
        }
        case 'chrome-browser__fill_form': {
            const count = args.elements?.length || 0;
            return { text: `${count} field${count !== 1 ? 's' : ''}` };
        }
        case 'chrome-browser__press_key': {
            return args.key ? { text: args.key } : null;
        }
        case 'chrome-browser__evaluate_script': {
            if (!args.function) return null;
            const firstLine = args.function.split('\n')[0] || '';
            const text = firstLine.length > 50 ? firstLine.slice(0, 47) + '\u2026' : firstLine;
            return { text, hoverText: args.function };
        }
        case 'chrome-browser__wait_for': {
            return args.text ? { text: `"${args.text}"` } : null;
        }
        case 'chrome-browser__select_page': {
            return args.pageId != null ? { text: `page ${args.pageId}` } : null;
        }
        case 'chrome-browser__close_page': {
            return args.pageId != null ? { text: `page ${args.pageId}` } : null;
        }
        case 'chrome-browser__handle_dialog': {
            return args.action ? { text: args.action === 'accept' ? 'Accept' : 'Dismiss' } : null;
        }
        case 'chrome-browser__upload_file': {
            if (!args.filePath) return null;
            const fileName = args.filePath.split('/').pop() || args.filePath;
            return { text: fileName, hoverText: args.filePath };
        }

        default:
            return null;
    }
}

/**
 * Shorten home directory path for display
 */
export function shortenHomePath(path: string | undefined): string {
    if (!path) return '~';
    return normalizePathSeparators(path).replace(
        /^(?:[a-zA-Z]:\/Users|\/(?:Users|home))\/[^/]+/,
        '~',
    );
}

// UUID generator that works in non-secure contexts (e.g., HTTP on non-localhost)
export function generateUUID(): string {
    try {
        return crypto.randomUUID();
    } catch {
        // Fallback for non-secure contexts where crypto.randomUUID throws
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
}

/**
 * Generates a stable ID based on string content.
 * Uses a simple, fast 32-bit hash with string length to reduce collisions.
 * Based on Java's String.hashCode but with unsigned remap (>>> 0).
 */
export function generateDeterministicId(prefix: string, content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        hash = ((hash << 5) - hash) + content.charCodeAt(i);
    }
    // Append string length to get ~43 bit (vs 32) collision resistance
    return `${prefix}-${hash >>> 0}-${content.length}`;
}

/**
 * The conversation a delegate_task step started, so the step can link to it.
 *
 * A backgrounded task reports back as JSON; one waited on in the foreground comes
 * back as the same text summary inspect_task produces, led by its conversation id.
 * That header's pattern comes from the module that writes it, so the two cannot drift.
 */
export function getDelegatedConversationId(toolName: string, toolResult?: string): string | undefined {
    if (toolName !== 'delegate_task' || !toolResult) {
        return undefined;
    }

    try {
        const started = JSON.parse(toolResult) as { conversation_id?: unknown };
        if (typeof started.conversation_id === 'string') {
            return started.conversation_id;
        }
    } catch {
        // Not the JSON shape, so it is the text summary below
    }

    return toolResult.match(CONVERSATION_HEADER)?.[1];
}

/** Match delegated conversation handles in tool results back to their user-facing titles. */
export function buildDelegatedTaskTitleMap(thoughts: Array<{
    type: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: string;
}>): Map<string, string> {
    const titles = new Map<string, string>();
    for (const thought of thoughts) {
        if (thought.type !== 'tool_call' || thought.toolName !== 'delegate_task') continue;
        const conversationId = getDelegatedConversationId(thought.toolName, thought.toolResult);
        const title = thought.toolArgs?.title;
        if (conversationId && typeof title === 'string' && title.trim()) {
            titles.set(conversationId, title);
        }
    }
    return titles;
}

/** Remove internal handles and redundant acknowledgements from delegation tool output. */
export function formatDelegationToolResult(
    toolName: string,
    result?: string,
    noRunInProgress?: string,
): string | null | undefined {
    if (!result || !['delegate_task', 'inspect_task', 'wait_for_tasks', 'stop_task'].includes(toolName)) {
        return result;
    }

    if (toolName === 'delegate_task') {
        try {
            const parsed = JSON.parse(result) as { status?: unknown; conversation_id?: unknown };
            if (parsed.status === 'started' && typeof parsed.conversation_id === 'string') return null;
        } catch {
            // Foreground delegation returns the same readable summary as wait_for_tasks.
        }
    }

    if (/^Stopped conversation [0-9a-f-]+\.$/i.test(result)) return null;
    if (/^Conversation [0-9a-f-]+ had no run in progress\.$/i.test(result)) {
        return noRunInProgress ?? result;
    }

    return result
        .split('\n\n---\n\n')
        .map(summary => {
            const [firstLine, ...rest] = summary.split('\n');
            return firstLine && CONVERSATION_HEADER.test(firstLine) ? rest.join('\n') : summary;
        })
        .join('\n\n---\n\n')
        .trim();
}

/**
 * Compact size for a live character count. Above a thousand it keeps one decimal
 * rather than dropping to a whole number, so a ticking counter holds its width
 * instead of jittering the row each time it crosses a boundary.
 */
export function formatCharCount(chars: number): string {
    if (chars < 1000) return String(chars);
    if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)}K`;
    return `${(chars / 1_000_000).toFixed(1)}M`;
}
