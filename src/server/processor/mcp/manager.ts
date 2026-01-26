import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { McpServer } from '../../db/schema';
import type { ToolDefinition } from '../conversation/conversation';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import { McpClient } from './client';
import type { McpServerConfig, McpToolInfo, McpContentType } from './types';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'mcp' });

/**
 * Global registry of active MCP clients
 */
const activeClients: Map<string, McpClient> = new Map();

/**
 * Load and connect to all enabled MCP servers
 */
export async function loadEnabledMcpServers(): Promise<void> {
    // Get all enabled MCP servers from the database
    const servers = await db
        .select()
        .from(McpServer)
        .where(eq(McpServer.enabled, true));

    log.info(`Loading ${servers.length} enabled MCP server(s)...`);

    // Connect to each server
    const connectPromises = servers.map(async (server) => {
        try {
            await connectMcpServer(server);
            log.info(`Connected to server: ${server.name}`);

            // Update lastConnectedAt timestamp
            await db
                .update(McpServer)
                .set({ lastConnectedAt: new Date(), lastError: null })
                .where(eq(McpServer.id, server.id));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error({ err: errorMessage, server: server.name }, 'Failed to connect to MCP server');

            // Store the error in the database
            await db
                .update(McpServer)
                .set({ lastError: errorMessage })
                .where(eq(McpServer.id, server.id));
        }
    });

    await Promise.allSettled(connectPromises);
}

/**
 * Connect to a specific MCP server
 */
async function connectMcpServer(config: McpServerConfig): Promise<void> {
    // Close existing connection if any
    const existingClient = activeClients.get(config.name);
    if (existingClient) {
        await existingClient.close();
    }

    // Create and connect new client
    const client = new McpClient(config);
    await client.connect();
    activeClients.set(config.name, client);
}

/**
 * Reconnect a specific MCP server (e.g., after config update)
 */
export async function reconnectMcpServer(serverName: string): Promise<void> {
    // Get server config from database
    const [server] = await db
        .select()
        .from(McpServer)
        .where(eq(McpServer.name, serverName));

    if (!server) {
        throw new Error(`MCP server not found: ${serverName}`);
    }

    await connectMcpServer(server);
}

/**
 * Get all MCP tools as ToolDefinition[] for the director
 */
export async function getMcpToolDefinitions(): Promise<ToolDefinition[]> {
    const toolDefinitions: ToolDefinition[] = [];

    for (const client of activeClients.values()) {
        if (client.status !== 'connected') {
            continue;
        }

        try {
            const tools = await client.getTools();
            const enabledToolsList = client.enabledTools;

            for (const tool of tools) {
                // If enabledTools is set, only include tools in that list
                if (enabledToolsList && enabledToolsList.length > 0) {
                    if (!enabledToolsList.includes(tool.originalName)) {
                        continue;
                    }
                }

                toolDefinitions.push({
                    name: tool.namespacedName,
                    description: `[MCP: ${tool.serverName}] ${tool.description}`,
                    schema: tool.inputSchema,
                });
            }
        } catch (error) {
            log.error({ err: error, server: client.serverName }, 'Failed to get tools from MCP server');
        }
    }

    return toolDefinitions;
}

/**
 * Parse a namespaced tool name into server name and tool name.
 */
function parseNamespacedToolName(namespacedName: string): { serverName: string; toolName: string } | null {
    const separatorIndex = namespacedName.indexOf('__');
    if (separatorIndex === -1) {
        return null;
    }

    return {
        serverName: namespacedName.slice(0, separatorIndex),
        toolName: namespacedName.slice(separatorIndex + 2), // Skip the '__' separator
    };
}

/**
 * Execute an MCP tool by its namespaced name
 * @param namespacedName - e.g., "github__create_issue"
 * @param args - Tool arguments
 * @param confirmationContext - Optional context for user confirmation
 */
export async function executeMcpTool(
    namespacedName: string,
    args: Record<string, unknown>,
    confirmationContext?: ConfirmationContext
): Promise<string | Array<{ type: string; [key: string]: unknown }>> {
    const parsed = parseNamespacedToolName(namespacedName);
    if (!parsed) {
        throw new Error(`Invalid MCP tool name format: ${namespacedName}. Expected format: server_name__tool_name`);
    }

    const { serverName, toolName } = parsed;

    // Get the client for this server
    const client = activeClients.get(serverName);
    if (!client) {
        throw new Error(`MCP server not found: ${serverName}`);
    }

    if (client.status !== 'connected') {
        throw new Error(`MCP server not connected: ${serverName}`);
    }

    // Check if confirmation is required
    if (client.requiresConfirmation && confirmationContext) {
        const result = await requestOperationConfirmation(
            'mcp_tool_call',
            namespacedName,
            confirmationContext,
            {
                toolName: namespacedName,
                toolArgs: args,
            }
        );
        if (!result.approved) {
            return result.denialReason || `MCP tool call "${namespacedName}" was denied by user.`;
        }
    }

    // Execute the tool
    const result = await client.runTool(toolName, args);

    if (!result.success) {
        let errorMessage = `Error executing MCP tool ${namespacedName}: ${result.error}`;

        // Add Chrome-specific setup guidance
        if (serverName === 'chrome-browser' && result.error?.includes('chrome://inspect/#remote-debugging')) {
            errorMessage +=
                '\n\nIf Chrome is already installed and running, the user may need to ' +
                '1. Open chrome://inspect/#remote-debugging on Chrome and 2. Tick "Allow remote debugging for this browser instance" to enable chrome browser use for you.';
        }

        return errorMessage;
    }

    // Convert result content to the format expected by the director
    return formatMcpResult(result.content);
}

/**
 * Format MCP result content for the director
 */
function formatMcpResult(content: McpContentType[]): string | Array<{ type: string; [key: string]: unknown }> {
    // If there's only text content, return as a simple string
    const hasOnlyText = content.every(item => item.type === 'text');
    if (hasOnlyText) {
        return content.map(item => (item as { type: 'text'; text: string }).text).join('\n');
    }

    // Otherwise, return as multimodal content array
    return content.map(item => {
        if (item.type === 'text') {
            return { type: 'text', text: item.text };
        } else if (item.type === 'image') {
            return {
                type: 'image',
                source_type: 'base64',
                mime_type: item.mimeType,
                data: item.data,
            };
        } else if (item.type === 'audio') {
            return {
                type: 'audio',
                source_type: 'base64',
                mime_type: item.mimeType,
                data: item.data,
            };
        }
        return item;
    });
}

/**
 * Close all MCP client connections
 */
export async function closeMcpClients(): Promise<void> {
    log.info(`Closing ${activeClients.size} MCP client(s)...`);

    const closePromises = Array.from(activeClients.values()).map(async (client) => {
        try {
            await client.close();
        } catch (error) {
            log.error({ err: error, server: client.serverName }, 'Error closing MCP client');
        }
    });

    await Promise.allSettled(closePromises);
    activeClients.clear();
}

/**
 * Get the status of all MCP servers
 */
export function getMcpServerStatuses(): Array<{ name: string; status: string; toolCount: number }> {
    return Array.from(activeClients.entries()).map(([name, client]) => ({
        name,
        status: client.status,
        toolCount: 0, // Will be updated when tools are fetched
    }));
}

/**
 * Check if a tool name is an MCP tool (contains __ separator)
 */
export function isMcpTool(toolName: string): boolean {
    return toolName.includes('__');
}
