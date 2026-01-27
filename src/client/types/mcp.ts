export type McpTransportType = 'stdio' | 'sse';

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Confirmation mode for MCP server tool calls:
 * - 'always': Always require confirmation for all tool calls (most restrictive)
 * - 'unsafe_only': Only require confirmation for unsafe operations (balanced)
 * - 'never': Never require confirmation (least restrictive)
 */
export type McpConfirmationMode = 'always' | 'unsafe_only' | 'never';

export interface McpServerInfo {
    id: number;
    name: string;
    description?: string;
    transportType: McpTransportType;
    path: string;
    apiKey?: string;
    env?: Record<string, string>;
    confirmationMode: McpConfirmationMode;
    enabled: boolean;
    enabledTools?: string[];  // When null/empty, all tools enabled; otherwise only listed tools
    lastConnectedAt?: string;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
    connectionStatus?: McpConnectionStatus;
}

export interface McpToolInfo {
    name: string;
    namespacedName: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface McpServersResponse {
    servers: McpServerInfo[];
}

export interface McpServerResponse {
    server: McpServerInfo;
}

export interface McpTestConnectionResponse {
    success: boolean;
    toolCount?: number;
    tools?: Array<{
        name: string;
        description: string;
    }>;
    error?: string;
}

export interface McpToolsResponse {
    server: string;
    tools: McpToolInfo[];
}

export interface CreateMcpServerInput {
    name: string;
    description?: string;
    transportType: McpTransportType;
    path: string;
    apiKey?: string;
    env?: Record<string, string>;
    confirmationMode?: McpConfirmationMode;
    enabled?: boolean;
}

export interface UpdateMcpServerInput {
    description?: string;
    transportType?: McpTransportType;
    path?: string;
    apiKey?: string;
    env?: Record<string, string>;
    confirmationMode?: McpConfirmationMode;
    enabled?: boolean;
    enabledTools?: string[];
}
