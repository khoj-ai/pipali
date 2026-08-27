import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { McpServer } from '../../db/schema';
import type { ToolDefinition } from '../conversation/conversation';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import { McpClient, isMcpOAuthUnauthorizedError } from './client';
import type { McpServerConfig, McpContentType, McpToolCallResult, McpToolInfo } from './types';
import { getMcpOAuthState } from './oauth-provider';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'mcp' });

/**
 * Global registry of active MCP clients
 */
const activeClients: Map<string, McpClient> = new Map();
type McpConnectOptions = { oauthInteractive?: boolean; callbackOrigin?: string };
type McpConnectResult = 'connected' | 'auth_pending';
const MCP_OAUTH_REAUTHORIZE_MESSAGE = 'OAuth authorization is required. Reconnect this MCP server from the Tools page.';

async function markMcpServerAuthRequired(serverName: string, lastError: string = MCP_OAUTH_REAUTHORIZE_MESSAGE): Promise<void> {
    await db
        .update(McpServer)
        .set({
            oauthStatus: 'auth_required',
            lastError,
            updatedAt: new Date(),
        })
        .where(eq(McpServer.name, serverName));
}

export async function handleFailedMcpToolResult(
    serverName: string,
    namespacedName: string,
    result: McpToolCallResult
): Promise<string> {
    if (result.authRequired) {
        await markMcpServerAuthRequired(serverName, result.error ?? MCP_OAUTH_REAUTHORIZE_MESSAGE);
    }

    let errorMessage = `Error executing MCP tool ${namespacedName}: ${result.error}`;

    // Add Chrome-specific setup guidance
    if (serverName === 'chrome-browser' && result.error?.includes('chrome://inspect/#remote-debugging')) {
        errorMessage +=
            '\n\nIf Chrome is already installed and running, the user may need to ' +
            '1. Open chrome://inspect/#remote-debugging on Chrome and 2. Tick "Allow remote debugging for this browser instance" to enable chrome browser use for you.';
    }

    return errorMessage;
}

export function createMcpToolDefinition(tool: McpToolInfo): ToolDefinition {
    return {
        name: tool.namespacedName,
        description: `[MCP: ${tool.serverName}] ${tool.description}`,
        schema: augmentSchemaWithOperationType(tool.inputSchema),
    };
}

/**
 * What one connection attempt tells us about whether to attempt again.
 * 'retryable' is the network, a server that is down, a machine that just woke:
 * causes that heal on their own. 'unauthorized' and 'auth_pending' need the user.
 */
type McpAttemptOutcome = 'connected' | 'auth_pending' | 'unauthorized' | 'retryable';

/**
 * Backoff before re-attempting a server that failed, following the retry
 * schedule the automation executor already uses. The last delay repeats for as
 * long as the app runs: the user has no way to know a connection died, so
 * giving up would leave their tools gone until they happened to look.
 */
const MCP_RETRY_DELAYS = [5_000, 20_000, 60_000, 300_000]; // 5s, 20s, 1m, 5m

/** Never due again, until a user action clears the entry */
const PARKED = Number.POSITIVE_INFINITY;

type McpRetryState = { attempts: number; dueAt: number };

/** When each server that is not connected may be attempted again */
const retrySchedule = new Map<string, McpRetryState>();

/**
 * Servers with an attempt in flight. Connecting closes any existing client
 * first, so a sweep landing on a server the startup pass is still working
 * through would tear down the handshake it is waiting on.
 */
const connecting = new Set<string>();

/** Delay before attempt number `attempt` (0-based); the last delay repeats */
export function mcpRetryDelay(attempt: number): number {
    return MCP_RETRY_DELAYS[attempt] ?? MCP_RETRY_DELAYS[MCP_RETRY_DELAYS.length - 1]!;
}

/**
 * How loudly to report an attempt, given the server's state going into it.
 *
 * Only state changes are worth a line. A server that is down all day is
 * retried on every sweep tick, and one identical error per tick would bury
 * everything else in the log; the transition into failure already carries the
 * error, and the transition back out reports the recovery.
 */
export function mcpAttemptLogLevel(
    outcome: McpAttemptOutcome,
    previous?: McpRetryState,
): 'info' | 'error' | 'debug' {
    if (outcome === 'connected') {
        return 'info';
    }
    // Parked servers wait on the user, so re-reporting them says nothing new
    if (outcome === 'unauthorized' || outcome === 'auth_pending') {
        if (previous?.dueAt === PARKED) return 'debug';
        return outcome === 'unauthorized' ? 'error' : 'info';
    }
    return previous ? 'debug' : 'error';
}

/** Report an attempt at the volume its state change warrants */
function logMcpAttempt(
    server: McpServerConfig,
    outcome: McpAttemptOutcome,
    previous: McpRetryState | undefined,
    error?: unknown,
): void {
    const context = { server: server.name, attempts: (previous?.attempts ?? 0) + 1 };
    switch (outcome) {
        case 'connected':
            if (previous) {
                log.info(context, 'MCP server reconnected');
            } else {
                log.info(`Connected to server: ${server.name}`);
            }
            return;
        case 'auth_pending':
            log[mcpAttemptLogLevel(outcome, previous)](
                context, `OAuth authorization pending for server: ${server.name}`);
            return;
        case 'unauthorized':
            log[mcpAttemptLogLevel(outcome, previous)](
                { err: error, ...context },
                'MCP server needs authorization; not retrying until it is reconnected from the Tools page');
            return;
        case 'retryable':
            log[mcpAttemptLogLevel(outcome, previous)](
                { err: error, ...context }, 'Failed to connect to MCP server');
    }
}

/** Record what an attempt cost, so the next sweep knows when to try again */
function noteMcpAttempt(serverName: string, outcome: McpAttemptOutcome, now: number): void {
    if (outcome === 'connected') {
        retrySchedule.delete(serverName);
        return;
    }
    const attempts = (retrySchedule.get(serverName)?.attempts ?? 0) + 1;
    const dueAt = outcome === 'retryable' ? now + mcpRetryDelay(attempts - 1) : PARKED;
    retrySchedule.set(serverName, { attempts, dueAt });
}

/**
 * Connect one server and record the outcome against it.
 *
 * Shared by the startup pass and the reconnect sweep so both write the same
 * lastError and lastConnectedAt, and both classify failures the same way.
 */
async function attemptMcpConnection(server: McpServerConfig): Promise<McpAttemptOutcome> {
    const previous = retrySchedule.get(server.name);
    connecting.add(server.name);
    try {
        const result = await connectMcpServer(server, { oauthInteractive: false });
        if (result === 'auth_pending') {
            logMcpAttempt(server, 'auth_pending', previous);
            return 'auth_pending';
        }

        await db
            .update(McpServer)
            .set({ lastConnectedAt: new Date(), lastError: null })
            .where(eq(McpServer.id, server.id));
        logMcpAttempt(server, 'connected', previous);
        return 'connected';
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const causeMessage = error instanceof Error && error.cause
            ? (error.cause instanceof Error ? error.cause.message : String(error.cause))
            : undefined;
        const fullError = causeMessage ? `${errorMessage}\nCause: ${causeMessage}` : errorMessage;

        const unauthorized = isMcpOAuthUnauthorizedError(error);
        const oauthUpdate = unauthorized || server.authType === 'oauth'
            ? { oauthStatus: 'auth_required' as const }
            : {};

        // Store the error in the database
        await db
            .update(McpServer)
            .set({ lastError: fullError, ...oauthUpdate })
            .where(eq(McpServer.id, server.id));

        const outcome = unauthorized ? 'unauthorized' : 'retryable';
        logMcpAttempt(server, outcome, previous, error);
        return outcome;
    } finally {
        connecting.delete(server.name);
    }
}

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

    const now = Date.now();
    await Promise.allSettled(servers.map(async (server) => {
        noteMcpAttempt(server.name, await attemptMcpConnection(server), now);
    }));
}

/**
 * Re-attempt every enabled server that is not connected and is due another try.
 *
 * A failed connection used to be terminal. The server stays out of
 * activeClients, so every tool snapshot from then on reports - truthfully, and
 * uselessly - that the user's tools do not exist, and the only ways back were
 * the Tools page's Reload button and editing the server. A transient network
 * failure at startup therefore cost the user their MCP tools for as long as it
 * took them to notice and reconnect by hand.
 *
 * Servers already connected are left alone, so this also picks up a connection
 * that dropped after a successful start. Returns the servers it reconnected.
 */
export async function reconnectFailedMcpServers(now: number = Date.now()): Promise<string[]> {
    const servers = await db
        .select()
        .from(McpServer)
        .where(eq(McpServer.enabled, true));

    const due = servers.filter(server => {
        if (connecting.has(server.name)) return false;
        if (activeClients.get(server.name)?.status === 'connected') return false;
        return (retrySchedule.get(server.name)?.dueAt ?? 0) <= now;
    });

    const reconnected: string[] = [];
    await Promise.allSettled(due.map(async (server) => {
        const outcome = await attemptMcpConnection(server);
        noteMcpAttempt(server.name, outcome, now);
        if (outcome === 'connected') {
            reconnected.push(server.name);
        }
    }));

    return reconnected;
}

/**
 * Make every server that is merely waiting out a backoff due immediately.
 *
 * Backoff assumes the delay was spent trying. Time the machine spent asleep was
 * not, so a lid opened after eight hours would otherwise leave the user without
 * their tools for another five minutes while a rung that accrued over sleep
 * runs down. Parked servers are left alone: waking does not sign anyone in.
 */
export function resetMcpRetryBackoff(): void {
    for (const [serverName, state] of retrySchedule) {
        if (state.dueAt !== PARKED) {
            retrySchedule.delete(serverName);
        }
    }
}

/** How often to look for MCP servers that need reconnecting */
const MCP_RETRY_SWEEP_MS = 15_000;

/**
 * How many missed sweeps mean the process was not running, rather than merely
 * running late. Ordinary scheduler jitter under load is a fraction of one
 * interval; a machine that slept skips many.
 */
const MCP_WAKE_GAP_TICKS = 4;

/** Whether the gap between two sweep ticks is too long to be scheduler jitter */
export function isWakeGap(gapMs: number, intervalMs: number): boolean {
    return gapMs > intervalMs * MCP_WAKE_GAP_TICKS;
}

let retrySweep: ReturnType<typeof setInterval> | undefined;
let sweepInFlight = false;

/**
 * Start healing MCP connections in the background. Idempotent, so a second
 * caller cannot leave two sweeps running against the same schedule.
 */
export function startMcpRetrySweep(intervalMs: number = MCP_RETRY_SWEEP_MS): void {
    if (retrySweep) return;
    let lastTickAt = Date.now();
    retrySweep = setInterval(() => {
        const now = Date.now();
        const gap = now - lastTickAt;
        lastTickAt = now;
        // Ticks this far apart mean the process was not running - the machine
        // slept, or the app was suspended. Whatever the network was doing then,
        // it is worth one immediate try now rather than after the backoff.
        if (isWakeGap(gap, intervalMs)) {
            log.info({ gapMs: gap }, 'Resumed after a gap; retrying failed MCP servers now');
            resetMcpRetryBackoff();
        }

        // A slow server must not let the next tick start a second pass over it
        if (sweepInFlight) return;
        sweepInFlight = true;
        reconnectFailedMcpServers()
            .catch(error => log.warn({ err: error }, 'MCP reconnect sweep failed'))
            .finally(() => { sweepInFlight = false; });
    }, intervalMs);
    retrySweep.unref?.();
}

export function stopMcpRetrySweep(): void {
    if (!retrySweep) return;
    clearInterval(retrySweep);
    retrySweep = undefined;
}

/**
 * Connect to a specific MCP server
 */
async function connectMcpServer(config: McpServerConfig, options: McpConnectOptions = {}): Promise<McpConnectResult> {
    // Close existing connection if any
    const existingClient = activeClients.get(config.name);
    if (existingClient) {
        await existingClient.close();
        activeClients.delete(config.name);
    }

    // Create and connect new client
    const client = new McpClient(config, options);
    try {
        await client.connect();
        if (config.authType === 'oauth') {
            const oauthState = await getMcpOAuthState(config.id);
            if (!oauthState?.tokens) {
                await client.close();
                await db
                    .update(McpServer)
                    .set({
                        oauthStatus: 'auth_pending',
                        lastError: 'OAuth authorization is required. Complete the browser sign-in flow to connect this MCP server.',
                        updatedAt: new Date(),
                    })
                    .where(eq(McpServer.id, config.id));
                return 'auth_pending';
            }

            activeClients.set(config.name, client);
            await db
                .update(McpServer)
                .set({ oauthStatus: 'connected', lastError: null, updatedAt: new Date() })
                .where(eq(McpServer.id, config.id));
            return 'connected';
        }

        activeClients.set(config.name, client);
        return 'connected';
    } catch (error) {
        if (config.authType === 'oauth' && isMcpOAuthUnauthorizedError(error)) {
            await db
                .update(McpServer)
                .set({
                    oauthStatus: 'auth_pending',
                    lastError: 'OAuth authorization is required. Complete the browser sign-in flow to connect this MCP server.',
                    updatedAt: new Date(),
                })
                .where(eq(McpServer.id, config.id));
        }
        throw error;
    }
}

/**
 * Reconnect a specific MCP server (e.g., after config update)
 */
export async function reconnectMcpServer(serverName: string, options: McpConnectOptions = {}): Promise<void> {
    // Get server config from database
    const [server] = await db
        .select()
        .from(McpServer)
        .where(eq(McpServer.name, serverName));

    if (!server) {
        throw new Error(`MCP server not found: ${serverName}`);
    }

    await connectMcpServer(server, options);
}

/**
 * Disconnect a specific MCP server if it is currently active.
 */
export async function disconnectMcpServer(serverName: string): Promise<void> {
    const existingClient = activeClients.get(serverName);
    if (!existingClient) {
        return;
    }

    await existingClient.close();
    activeClients.delete(serverName);
}

/**
 * Get all MCP tools as ToolDefinition[] for the director.
 * Each tool's schema is augmented with an `operation_type` property that the agent
 * must specify to indicate whether the tool call is safe or unsafe.
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

                toolDefinitions.push(createMcpToolDefinition(tool));
            }

        } catch (error) {
            log.error({ err: error, server: client.serverName }, 'Failed to get tools from MCP server');
        }
    }

    return toolDefinitions;
}

/**
 * Get the configured description of each connected MCP server, by server name.
 * Used as the namespace description when MCP tools are grouped per server.
 */
export function getMcpServerDescriptions(): Map<string, string> {
    const descriptions = new Map<string, string>();
    for (const client of activeClients.values()) {
        if (client.status === 'connected' && client.serverDescription) {
            descriptions.set(client.serverName, client.serverDescription);
        }
    }
    return descriptions;
}

/**
 * Augment a tool's input schema with the operation_type property.
 * This property is required for all MCP tool calls so the confirmation system
 * can determine whether confirmation is needed based on server settings.
 */
export function augmentSchemaWithOperationType(originalSchema: Record<string, unknown>): Record<string, unknown> {
    const schema = { ...originalSchema };

    // Ensure properties object exists
    const properties = (schema.properties as Record<string, unknown>) || {};
    schema.properties = {
        ...properties,
        operation_type: {
            type: 'string',
            enum: ['safe', 'unsafe'],
            description: `
Indicate whether this action is safe (no lasting side effects, can be undone) or unsafe (has lasting side effects, cannot be easily undone).
Use safe for search, read, list, draft, and fill operations.
Use unsafe for send, submit, delete, post, and publish style actions with permanent effects.
Examples:
- Filling a form is safe, submitting it is unsafe.
- Filling a shopping cart is safe, placing the order is unsafe.
- Drafting an email is safe, sending it is unsafe.
- Doing a web search is safe, posting on social media is unsafe.
`.trim(),
        },
    };

    // Add operation_type to required array
    const required = Array.isArray(schema.required) ? [...schema.required] : [];
    if (!required.includes('operation_type')) {
        required.push('operation_type');
    }
    schema.required = required;

    return schema;
}

/**
 * Determine if confirmation is required based on server's confirmation mode and the operation type.
 *
 * @param confirmationMode - The server's confirmation mode setting
 * @param operationType - The operation type specified by the agent ('safe' or 'unsafe')
 * @returns true if confirmation should be requested, false otherwise
 */
export function shouldRequireConfirmation(
    confirmationMode: 'always' | 'unsafe_only' | 'never',
    operationType: 'safe' | 'unsafe' | undefined
): boolean {
    switch (confirmationMode) {
        case 'never':
            // Never require confirmation regardless of operation type
            return false;

        case 'always':
            // Always require confirmation regardless of operation type
            return true;

        case 'unsafe_only':
            // Only require confirmation for unsafe operations (those with lasting side effects)
            // If operation_type is not specified, default to requiring confirmation (safer)
            return operationType !== 'safe';

        default:
            // Unknown mode, default to requiring confirmation (safer)
            return true;
    }
}

/**
 * Parse a namespaced tool name into server name and tool name.
 */
export function parseNamespacedToolName(namespacedName: string): { serverName: string; toolName: string } | null {
    const separatorIndex = namespacedName.indexOf('__');
    if (separatorIndex === -1) {
        return null;
    }

    return {
        serverName: namespacedName.slice(0, separatorIndex),
        toolName: namespacedName.slice(separatorIndex + 2), // Skip the '__' separator
    };
}

export function getMcpConfirmationSubType(serverName: string, operationType: 'safe' | 'unsafe' | undefined): string {
    const opTypeStr = operationType === 'safe' ? 'safe' : 'unsafe';
    return `${serverName}:${opTypeStr}`;
}

/**
 * Execute an MCP tool by its namespaced name
 * @param namespacedName - e.g., "github__create_issue"
 * @param args - Tool arguments (should include operation_type)
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

    // Extract operation_type from args (agent must provide this)
    let operationType = args.operation_type as 'safe' | 'unsafe' | undefined;

    // For evaluate_script_file, the _safe.js / _unsafe.js suffix is authoritative
    if (toolName === 'evaluate_script_file' && serverName === 'chrome-browser') {
        const filePath = args.file_path as string | undefined;
        const suffixType = filePath?.match(/_(?<type>safe|unsafe)\.js$/)?.groups?.type as 'safe' | 'unsafe' | undefined;
        if (suffixType) operationType = suffixType;
    }

    // Check if confirmation is required based on server's confirmation mode and operation type
    const needsConfirmation = shouldRequireConfirmation(client.confirmationMode, operationType);

    if (needsConfirmation && confirmationContext) {
        // Map operation_type to the format expected by confirmation service
        // Include server name in the subtype for per-server "don't ask again" preferences
        // e.g., "github:safe" -> key becomes "mcp_tool_call:github:safe"
        const operationSubType = getMcpConfirmationSubType(serverName, operationType);

        const result = await requestOperationConfirmation(
            'mcp_tool_call',
            namespacedName,
            confirmationContext,
            {
                toolName: namespacedName,
                toolArgs: args,
                operationSubType,
            }
        );
        if (!result.approved) {
            return result.denialReason || `MCP tool call "${namespacedName}" was denied by user.`;
        }
    }

    // Remove operation_type from args before passing to MCP server (it's not part of the actual tool schema)
    const { operation_type: _, ...toolArgs } = args;

    // Translate synthetic tools to their real MCP counterparts before execution
    let realToolName = toolName;
    let realToolArgs = toolArgs;
    if (toolName === 'evaluate_script_file' && serverName === 'chrome-browser') {
        try {
            [realToolName, realToolArgs] = await translateScriptFileArgs(toolArgs);
        } catch (err) {
            return `Error executing MCP tool ${namespacedName}: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    // Execute the tool
    const result = await client.runTool(realToolName, realToolArgs);

    if (!result.success) {
        return handleFailedMcpToolResult(serverName, namespacedName, result);
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
    // A manual reload goes through here; let it retry servers the sweep parked
    retrySchedule.clear();
}

/**
 * Translate evaluate_script_file args into evaluate_script args.
 * Reads the JS file from disk and returns the real tool name + args
 * so the standard executeMcpTool flow handles confirmation, errors, etc.
 */
async function translateScriptFileArgs(
    args: Record<string, unknown>
): Promise<[string, Record<string, unknown>]> {
    const filePath = args.file_path as string;
    if (!filePath) throw new Error('evaluate_script_file: file_path is required');

    // Resolve ~ and relative paths
    const resolvedPath = filePath.startsWith('~')
        ? path.join(os.homedir(), filePath.slice(1))
        : path.resolve(filePath);

    // Read the script from disk
    const scriptContent = await fs.readFile(resolvedPath, 'utf-8');

    // chrome-devtools-mcp expects a function declaration string.
    // Wrap bare scripts that aren't already a function expression.
    const isWrapped = /^\s*(\(\s*\)|async\s*\(\s*\)|function[\s(])/.test(scriptContent);
    const functionString = isWrapped ? scriptContent : `() => {\n${scriptContent}\n}`;

    log.debug(`evaluate_script_file: running ${resolvedPath} (${scriptContent.length} bytes)`);

    const { file_path: _, ...rest } = args;
    return ['evaluate_script', { ...rest, function: functionString }];
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
