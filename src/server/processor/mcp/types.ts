import type { McpServer } from '../../db/schema';

/**
 * Configuration for an MCP server, derived from database schema
 */
export type McpServerConfig = typeof McpServer.$inferSelect;

/**
 * Confirmation mode for MCP server tool calls
 */
export type McpConfirmationMode = 'always' | 'unsafe_only' | 'never';

/**
 * Operation type for MCP tool calls - indicates whether the tool has lasting side effects
 * The agent specifies this when calling an MCP tool to inform the confirmation system.
 * - safe: No lasting side effects, can be undone (e.g., fetch page, list items, fill form, draft email, add to cart)
 * - unsafe: Has lasting side effects, cannot be easily undone (e.g., send email, submit order, delete item, post message)
 */
export type McpToolOperationType = 'safe' | 'unsafe';

/**
 * Information about a tool from an MCP server, with namespacing
 */
export interface McpToolInfo {
    /** Original tool name from MCP server */
    originalName: string;
    /** Namespaced name: "{server_name}__{tool_name}" */
    namespacedName: string;
    /** Server this tool belongs to */
    serverName: string;
    /** Tool description */
    description: string;
    /** JSON Schema for tool input */
    inputSchema: Record<string, unknown>;
}

/**
 * Content types that can be returned from MCP tool execution
 */
export type McpContentType =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'audio'; data: string; mimeType: string };

/**
 * Result from executing an MCP tool
 */
export interface McpToolCallResult {
    success: boolean;
    content: McpContentType[];
    error?: string;
}

/**
 * Status of an MCP client connection
 */
export type McpClientStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
