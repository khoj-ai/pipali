import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db';
import { McpServer } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
    loadEnabledMcpServers,
    reconnectMcpServer,
    getMcpServerStatuses,
    closeMcpClients,
} from '../processor/mcp';
import { McpClient } from '../processor/mcp/client';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'mcp' });

const mcp = new Hono();

// Validation schemas
const createMcpServerSchema = z.object({
    name: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'Name must be lowercase alphanumeric with dashes/underscores'),
    description: z.string().max(512).optional(),
    transportType: z.enum(['stdio', 'sse']),
    path: z.string().min(1),
    apiKey: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    requiresConfirmation: z.boolean().optional(),
    enabled: z.boolean().optional(),
    enabledTools: z.array(z.string()).optional(),
});

const updateMcpServerSchema = createMcpServerSchema.partial().omit({ name: true });

// GET /api/mcp/servers - List all MCP servers
mcp.get('/servers', async (c) => {
    log.info('📋 Listing MCP servers');

    const servers = await db.select().from(McpServer);

    // Get connection statuses
    const statuses = getMcpServerStatuses();
    const statusMap = new Map(statuses.map(s => [s.name, s.status]));

    const result = servers.map(server => ({
        ...server,
        connectionStatus: statusMap.get(server.name) || 'disconnected',
    }));

    return c.json({ servers: result });
});

// POST /api/mcp/servers - Create new MCP server
mcp.post('/servers', zValidator('json', createMcpServerSchema), async (c) => {
    const input = c.req.valid('json');
    log.info(`✨ Creating MCP server "${input.name}"`);

    // Check if name already exists
    const [existing] = await db.select().from(McpServer).where(eq(McpServer.name, input.name));
    if (existing) {
        return c.json({ error: `MCP server with name "${input.name}" already exists` }, 400);
    }

    try {
        const results = await db.insert(McpServer).values({
            name: input.name,
            description: input.description,
            transportType: input.transportType,
            path: input.path,
            apiKey: input.apiKey,
            env: input.env,
            requiresConfirmation: input.requiresConfirmation ?? true,
            enabled: input.enabled ?? true,
            enabledTools: input.enabledTools,
        }).returning();

        const server = results[0];
        if (!server) {
            return c.json({ error: 'Failed to create MCP server' }, 500);
        }

        log.info(`✅ Created MCP server "${input.name}" (id: ${server.id})`);

        // If enabled, connect to the server
        if (server.enabled) {
            try {
                await reconnectMcpServer(server.name);
                log.info(`🔗 Connected to MCP server "${server.name}"`);
            } catch (error) {
                log.warn({ err: error }, 'Failed to connect to server');
                // Update last error
                await db.update(McpServer)
                    .set({ lastError: error instanceof Error ? error.message : String(error) })
                    .where(eq(McpServer.id, server.id));
            }
        }

        return c.json({ success: true, server });
    } catch (error) {
        log.error({ err: error }, 'Failed to create server');
        return c.json({ error: 'Failed to create MCP server' }, 500);
    }
});

// GET /api/mcp/servers/:id - Get single server
mcp.get('/servers/:id', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const [server] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!server) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    // Get connection status
    const statuses = getMcpServerStatuses();
    const status = statuses.find(s => s.name === server.name);

    return c.json({
        server: {
            ...server,
            connectionStatus: status?.status || 'disconnected',
        }
    });
});

// PUT /api/mcp/servers/:id - Update server
mcp.put('/servers/:id', zValidator('json', updateMcpServerSchema), async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const input = c.req.valid('json');
    log.info(`✏️ Updating MCP server ${id}`);

    const [existing] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!existing) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    try {
        // Build update object with only defined fields
        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (input.description !== undefined) updateData.description = input.description;
        if (input.transportType !== undefined) updateData.transportType = input.transportType;
        if (input.path !== undefined) updateData.path = input.path;
        if (input.apiKey !== undefined) updateData.apiKey = input.apiKey;
        if (input.env !== undefined) updateData.env = input.env;
        if (input.requiresConfirmation !== undefined) updateData.requiresConfirmation = input.requiresConfirmation;
        if (input.enabled !== undefined) updateData.enabled = input.enabled;
        if (input.enabledTools !== undefined) updateData.enabledTools = input.enabledTools;

        const results = await db.update(McpServer)
            .set(updateData)
            .where(eq(McpServer.id, id))
            .returning();

        const updated = results[0];
        if (!updated) {
            return c.json({ error: 'Failed to update MCP server' }, 500);
        }

        log.info(`✅ Updated MCP server "${updated.name}"`);

        // Reconnect if enabled
        if (updated.enabled) {
            try {
                await reconnectMcpServer(updated.name);
                log.info(`🔗 Reconnected to MCP server "${updated.name}"`);
            } catch (error) {
                log.warn({ err: error }, 'Failed to reconnect');
            }
        }

        return c.json({ success: true, server: updated });
    } catch (error) {
        log.error({ err: error }, 'Failed to update server');
        return c.json({ error: 'Failed to update MCP server' }, 500);
    }
});

// DELETE /api/mcp/servers/:id - Delete server
mcp.delete('/servers/:id', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const [existing] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!existing) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    log.info(`🗑️ Deleting MCP server "${existing.name}"`);

    await db.delete(McpServer).where(eq(McpServer.id, id));

    // Reload servers to remove the client
    await closeMcpClients();
    await loadEnabledMcpServers();

    log.info(`✅ Deleted MCP server "${existing.name}"`);
    return c.json({ success: true });
});

// POST /api/mcp/servers/:id/test - Test connection to server
mcp.post('/servers/:id/test', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const [server] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!server) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    log.info(`🧪 Testing connection to MCP server "${server.name}"`);

    try {
        const client = new McpClient(server);
        await client.connect();
        const tools = await client.getTools();
        await client.close();

        // Update last connected timestamp
        await db.update(McpServer)
            .set({ lastConnectedAt: new Date(), lastError: null })
            .where(eq(McpServer.id, id));

        log.info(`✅ Connection test successful - ${tools.length} tools available`);

        return c.json({
            success: true,
            toolCount: tools.length,
            tools: tools.map(t => ({
                name: t.originalName,
                description: t.description,
            })),
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ err: errorMessage }, 'Connection test failed');

        // Update last error
        await db.update(McpServer)
            .set({ lastError: errorMessage })
            .where(eq(McpServer.id, id));

        return c.json({ success: false, error: errorMessage }, 500);
    }
});

// GET /api/mcp/servers/:id/tools - List tools from a specific server
mcp.get('/servers/:id/tools', async (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) {
        return c.json({ error: 'Invalid server ID' }, 400);
    }

    const [server] = await db.select().from(McpServer).where(eq(McpServer.id, id));
    if (!server) {
        return c.json({ error: 'MCP server not found' }, 404);
    }

    log.info(`📋 Listing tools from MCP server "${server.name}"`);

    try {
        const client = new McpClient(server);
        await client.connect();
        const tools = await client.getTools();
        await client.close();

        return c.json({
            server: server.name,
            tools: tools.map(t => ({
                name: t.originalName,
                namespacedName: t.namespacedName,
                description: t.description,
                inputSchema: t.inputSchema,
            })),
        });
    } catch (error) {
        log.error({ err: error }, 'Failed to list tools');
        return c.json({
            error: error instanceof Error ? error.message : 'Failed to list tools'
        }, 500);
    }
});

// POST /api/mcp/reload - Reload all MCP servers
mcp.post('/reload', async (c) => {
    log.info('Reloading all MCP servers...');

    try {
        await closeMcpClients();
        await loadEnabledMcpServers();

        const statuses = getMcpServerStatuses();
        log.info({ count: statuses.length }, 'Reloaded MCP servers');

        return c.json({
            success: true,
            servers: statuses,
        });
    } catch (error) {
        log.error({ err: error }, 'Failed to reload servers');
        return c.json({ error: 'Failed to reload MCP servers' }, 500);
    }
});

export default mcp;
