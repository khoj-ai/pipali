import os from 'os';
import path from 'path';
import { realpath } from 'fs/promises';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db, getDefaultChatModel } from '../db';
import { Automation, Conversation } from '../db/schema';
import { eq, desc, isNull, and, sql } from 'drizzle-orm';
import { AiModelApi, ChatModel, User, UserChatModel } from '../db/schema';
import openapi from './openapi';
import automations from './automations';
import mcp from './mcp';
import auth from './auth';

import { getDefaultUser } from '../utils';
import { atifConversationService } from '../processor/conversation/atif/atif.service';
import { runResearchToCompletion } from '../processor/research-runner';
import { getActiveStatus } from '../sessions';
import { loadSkills, getLoadedSkills, createSkill, getSkill, deleteSkill, updateSkill } from '../skills';
import { loadUserContext, saveUserContext } from '../user-context';
import { syncPlatformModels, syncPlatformWebTools } from '../auth';
import { createChildLogger } from '../logger';
import { getBus } from '../events/conversation-event-bus';
import {
    getSandboxConfig,
    getDefaultPaths,
    updateSandboxConfig,
    isSandboxEnabled,
    isSandboxSupported,
} from '../sandbox';

const log = createChildLogger({ component: 'api' });

const api = new Hono().basePath('/api');

// Enable CORS for Tauri desktop app and local development
// - macOS/Linux WebView uses tauri://localhost origin
// - Windows WebView2 uses http://tauri.localhost origin
api.use('*', cors({
    origin: (origin) => {
        // Allow Tauri app, localhost dev servers, and same-origin requests
        if (!origin) return '*'; // Same-origin or non-browser requests
        if (origin.startsWith('tauri://')) return origin;
        if (origin === 'http://tauri.localhost') return origin; // Windows WebView2
        if (origin.startsWith('http://localhost:')) return origin;
        if (origin.startsWith('http://127.0.0.1:')) return origin;
        return null; // Reject other origins
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// Health check endpoint for Tauri sidecar readiness detection
api.get('/health', (c) => c.json({ status: 'ok' }));

const schema = z.object({
    message: z.string(),
    conversationId: z.uuid().optional(),
});

api.post('/chat', zValidator('json', schema), async (c) => {
    const { message, conversationId } = c.req.valid('json');

    log.info(`\n${'='.repeat(60)}`);
    log.info(`💬 New message received`);
    log.info(`Query: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);
    log.info(`Conversation: ${conversationId || 'new'}`);

    // Get the user
    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!user) {
        log.error(`❌ User not found: ${getDefaultUser().email}`);
        return c.json({ error: 'User not found' }, 404);
    }
    log.info(`User: ${user.email} (id: ${user.id})`);

    // Get the user's selected model
    const chatModelWithApi = await getDefaultChatModel(user);
    if (chatModelWithApi) {
        log.info(`🤖 Model: ${chatModelWithApi.chatModel.name} (${chatModelWithApi.chatModel.modelType})`);
        log.info(`Provider: ${chatModelWithApi.aiModelApi?.name || 'Unknown'}`);
    } else {
        log.warn(`⚠️ No chat model configured`);
        return c.json({ error: 'No chat model configured. Please configure an AI provider.' }, 500);
    }

    // Get or create conversation BEFORE starting research
    let conversation;
    if (conversationId) {
        const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
        conversation = results[0];
    } else {
        // Create new conversation at the start
        const modelName = chatModelWithApi?.chatModel.name || 'unknown';
        conversation = await atifConversationService.createConversation(
            user,
            'pipali-agent',
            '1.0.0',
            modelName
        );
    }

    // Ensure conversation was created
    if (!conversation) {
        return c.json({ error: 'Failed to create or find conversation' }, 500);
    }

    // Run research using shared runner
    log.info(`🔬 Starting research...`);

    const result = await runResearchToCompletion({
        conversationId: conversation.id,
        user,
        userMessage: message,
    });

    log.info(`✅ Research complete`);
    log.info(`Iterations: ${result.iterationCount}`);
    log.info(`Response length: ${result.response.length} chars`);
    log.info(`Conversation ID: ${conversation.id}`);
    log.info(`${'='.repeat(60)}\n`);

    return c.json({
        response: result.response,
        conversationId: conversation.id,
        iterations: result.iterationCount
    });
});

api.get('/chat/:conversationId/history', async (c) => {
    const conversationId = c.req.param('conversationId');
    // validate uuid
    try {
        z.uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
    const conversation = results[0];

    if (!conversation) {
        return c.json({ error: 'Conversation not found' }, 404);
    }

    // Pass chat history to frontend
    const history = conversation.trajectory.steps;

    return c.json({ history, chatModelId: conversation.chatModelId });
});

// Get all conversations for the user (with optional full-text search via ?q=)
api.get('/conversations', async (c) => {
    const [adminUser] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!adminUser) {
        return c.json({ error: 'User not found' }, 404);
    }

    const q = c.req.query('q')?.trim();

    // Base filter: user's conversations (including automation conversations)
    const baseWhere = eq(Conversation.userId, adminUser.id);

    // When searching, add JSONB full-text search across user messages and agent final responses
    const searchPattern = q ? `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%` : '';
    const whereClause = q
        ? and(baseWhere, sql`(
            ${Conversation.title} ILIKE ${searchPattern}
            OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(${Conversation.trajectory}->'steps') AS step
                WHERE step->>'message' ILIKE ${searchPattern}
                  AND (step->>'source' = 'user' OR (step->>'source' = 'agent' AND NOT step ? 'tool_calls'))
                  AND NOT coalesce(step->'extra' ? 'is_compaction', false)
            )
          )`)
        : baseWhere;

    const conversations = await db.select({
        id: Conversation.id,
        title: Conversation.title,
        createdAt: Conversation.createdAt,
        updatedAt: Conversation.updatedAt,
        trajectory: Conversation.trajectory,
        automationId: Conversation.automationId,
        isPinned: Conversation.isPinned,
    })
    .from(Conversation)
    .where(whereClause)
    .orderBy(desc(Conversation.updatedAt));

    // Map to include a preview, active status, and latest reasoning
    const result = conversations.map(conv => {
        // Find first user message in trajectory
        const firstUserStep = conv.trajectory?.steps?.find(s => s.source === 'user');
        const preview = firstUserStep?.message
            ? firstUserStep.message.slice(0, 100)
            : '';

        // Check if conversation has an active session
        const sessionStatus = getActiveStatus(conv.id);
        const isActive = sessionStatus?.isActive ?? false;

        // Get latest reasoning from active session or from trajectory
        let latestReasoning = sessionStatus?.latestReasoning;
        if (!latestReasoning) {
            // Find latest agent step with reasoning from trajectory
            const latestAgentWithReasoning = [...(conv.trajectory?.steps || [])]
                .reverse()
                .find(s => s.source === 'agent' && s.reasoning_content);
            latestReasoning = latestAgentWithReasoning?.reasoning_content
                ?.split('\n')[0]              // First line only
                ?.replace(/^\*\*|\*\*$/g, '') // Strip leading, ending **
                ?.slice(0, 80);               // Truncate
        }

        // Extract a match snippet when searching (for matches in message content, not title)
        let matchSnippet: string | undefined;
        if (q) {
            const lowerQ = q.toLowerCase();
            const title = conv.title || preview || '';
            if (!title.toLowerCase().includes(lowerQ)) {
                // Search through user messages and agent final responses for the match
                for (const step of conv.trajectory?.steps || []) {
                    if (!step.message) continue;
                    // Skip non-user/agent steps, tool-call steps, and compaction steps
                    const isUserMsg = step.source === 'user';
                    const isAgentFinal = step.source === 'agent' && !step.tool_calls;
                    const isCompaction = step.extra?.is_compaction;
                    if ((!isUserMsg && !isAgentFinal) || isCompaction) continue;

                    const matchIndex = step.message.toLowerCase().indexOf(lowerQ);
                    if (matchIndex !== -1) {
                        const contextRadius = 50;
                        const start = Math.max(0, matchIndex - contextRadius);
                        const end = Math.min(step.message.length, matchIndex + q.length + contextRadius);
                        const prefix = start > 0 ? '...' : '';
                        const suffix = end < step.message.length ? '...' : '';
                        matchSnippet = `${prefix}${step.message.slice(start, end)}${suffix}`;
                        break;
                    }
                }
            }
        }

        return {
            id: conv.id,
            title: conv.title || preview || 'New conversation',
            preview,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            isActive,
            isAutomation: !!conv.automationId,
            isPinned: conv.isPinned,
            latestReasoning,
            ...(matchSnippet !== undefined && { matchSnippet }),
        };
    });

    return c.json({ conversations: result });
});

// Update a conversation's chat model
api.put('/conversations/:conversationId/model', async (c) => {
    const conversationId = c.req.param('conversationId');
    try {
        z.uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const body = await c.req.json();
    const { chatModelId } = body;
    if (typeof chatModelId !== 'number') {
        return c.json({ error: 'chatModelId must be a number' }, 400);
    }
    await db.update(Conversation).set({ chatModelId }).where(eq(Conversation.id, conversationId));
    return c.json({ success: true });
});

// Rename a conversation
api.put('/conversations/:conversationId/title', async (c) => {
    const conversationId = c.req.param('conversationId');
    try {
        z.uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const body = await c.req.json();
    const title = body.title;
    if (typeof title !== 'string' || !title.trim()) {
        return c.json({ error: 'title must be a non-empty string' }, 400);
    }
    const trimmedTitle = title.trim();
    await db.update(Conversation).set({ title: trimmedTitle }).where(eq(Conversation.id, conversationId));

    // Sync title to linked automation
    const [conv] = await db.select({ automationId: Conversation.automationId })
        .from(Conversation).where(eq(Conversation.id, conversationId));
    if (conv?.automationId) {
        // strip "Routine: " prefix for the automation name
        const automationName = trimmedTitle.replace(/^Routine:\s*/i, '');
        await db.update(Automation).set({ name: automationName }).where(eq(Automation.id, conv.automationId));
    }

    return c.json({ success: true });
});

// Toggle pin status for a conversation
api.put('/conversations/:conversationId/pin', async (c) => {
    const conversationId = c.req.param('conversationId');
    try {
        z.uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const body = await c.req.json();
    const isPinned = body.isPinned;
    if (typeof isPinned !== 'boolean') {
        return c.json({ error: 'isPinned must be a boolean' }, 400);
    }
    await db.update(Conversation).set({ isPinned }).where(eq(Conversation.id, conversationId));
    return c.json({ success: true });
});

// Delete a conversation
api.delete('/conversations/:conversationId', async (c) => {
    const conversationId = c.req.param('conversationId');
    try {
        z.uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    await db.delete(Conversation).where(eq(Conversation.id, conversationId));
    return c.json({ success: true });
});

// Delete a message from a conversation
// For user messages: deletes just that step
// For assistant messages: deletes all associated agent steps (reasoning, tool calls, etc.)
api.delete('/conversations/:conversationId/messages/:stepId', async (c) => {
    const conversationId = c.req.param('conversationId');
    const stepIdParam = c.req.param('stepId');
    const role = c.req.query('role'); // 'user' or 'assistant'

    // Validate conversation ID
    try {
        z.uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    // Validate step ID is a number
    const stepId = parseInt(stepIdParam, 10);
    if (isNaN(stepId) || stepId < 1) {
        return c.json({ error: 'Invalid step ID' }, 400);
    }

    try {
        if (role === 'assistant') {
            // Delete all agent steps associated with this assistant message
            const deletedCount = await atifConversationService.deleteAgentMessage(conversationId, stepId);
            if (deletedCount === 0) {
                return c.json({ error: 'Message not found' }, 404);
            }
            getBus(conversationId)?.publish({
                type: 'message_deleted',
                conversationId,
                data: { stepId, role: 'assistant' },
            });
            return c.json({ success: true, deletedCount });
        } else {
            // Delete user message and the following assistant message (if any)
            const deletedCount = await atifConversationService.deleteTurn(conversationId, stepId);
            if (deletedCount === 0) {
                return c.json({ error: 'Message not found' }, 404);
            }
            getBus(conversationId)?.publish({
                type: 'message_deleted',
                conversationId,
                data: { stepId, role: 'user' },
            });
            return c.json({ success: true, deletedCount });
        }
    } catch (error) {
        log.error({ err: error }, 'Error deleting message');
        return c.json({ error: error instanceof Error ? error.message : 'Failed to delete message' }, 500);
    }
});

// Get all available chat models
api.get('/models', async (c) => {
    // Sync latest chat models and web tools from platform, if authenticated
    await syncPlatformModels();
    syncPlatformWebTools(); // Run in background - doesn't affect models response

    // Return updated models list from local DB
    const models = await db.select({
        id: ChatModel.id,
        name: ChatModel.name,
        friendlyName: ChatModel.friendlyName,
        modelType: ChatModel.modelType,
        visionEnabled: ChatModel.visionEnabled,
        inputCostPerMillion: ChatModel.inputCostPerMillion,
        outputCostPerMillion: ChatModel.outputCostPerMillion,
    })
    .from(ChatModel)
    .leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id));

    return c.json({ models });
});

// Get user's selected model
api.get('/user/model', async (c) => {
    const [adminUser] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!adminUser) {
        return c.json({ error: 'User not found' }, 404);
    }

    const [userModel] = await db.select({
        id: UserChatModel.modelId,
        name: ChatModel.name,
        friendlyName: ChatModel.friendlyName,
        modelType: ChatModel.modelType,
        inputCostPerMillion: ChatModel.inputCostPerMillion,
        outputCostPerMillion: ChatModel.outputCostPerMillion,
    })
    .from(UserChatModel)
    .leftJoin(ChatModel, eq(UserChatModel.modelId, ChatModel.id))
    .where(eq(UserChatModel.userId, adminUser.id));

    if (!userModel) {
        // Return first available model as default
        const [defaultModel] = await db.select({
            id: ChatModel.id,
            name: ChatModel.name,
            friendlyName: ChatModel.friendlyName,
            modelType: ChatModel.modelType,
            inputCostPerMillion: ChatModel.inputCostPerMillion,
            outputCostPerMillion: ChatModel.outputCostPerMillion,
        })
        .from(ChatModel)
        .limit(1);

        return c.json({ model: defaultModel || null });
    }

    return c.json({ model: userModel });
});

// Set user's selected model
const selectModelSchema = z.object({
    modelId: z.number(),
});

api.put('/user/model', zValidator('json', selectModelSchema), async (c) => {
    const { modelId } = c.req.valid('json');

    const [adminUser] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!adminUser) {
        return c.json({ error: 'User not found' }, 404);
    }

    // Verify model exists
    const [model] = await db.select().from(ChatModel).where(eq(ChatModel.id, modelId));
    if (!model) {
        return c.json({ error: 'Model not found' }, 404);
    }

    // Upsert user model selection
    const [existing] = await db.select().from(UserChatModel).where(eq(UserChatModel.userId, adminUser.id));

    if (existing) {
        await db.update(UserChatModel)
            .set({ modelId, updatedAt: new Date() })
            .where(eq(UserChatModel.userId, adminUser.id));
    } else {
        await db.insert(UserChatModel).values({
            userId: adminUser.id,
            modelId,
        });
    }

    return c.json({ success: true, modelId });
});

// Get user context (bio, location, instructions)
api.get('/user/context', async (c) => {
    try {
        const context = await loadUserContext();
        return c.json(context);
    } catch (err) {
        log.error({ err }, 'Failed to load user context');
        return c.json({ error: 'Failed to load user context' }, 500);
    }
});

// Update user context
const userContextSchema = z.object({
    name: z.string().optional(),
    location: z.string().optional(),
    instructions: z.string().optional(),
});

api.put('/user/context', zValidator('json', userContextSchema), async (c) => {
    try {
        const body = c.req.valid('json');
        await saveUserContext({
            name: body.name,
            location: body.location,
            instructions: body.instructions,
        });
        return c.json({ success: true });
    } catch (err) {
        log.error({ err }, 'Failed to save user context');
        return c.json({ error: 'Failed to save user context' }, 500);
    }
});

// ATIF Export endpoint - Export a conversation in ATIF format
api.get('/conversations/:conversationId/export/atif', async (c) => {
    const conversationId = c.req.param('conversationId');

    // Validate UUID
    try {
        z.uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    try {
        const atifJson = await atifConversationService.exportConversationAsATIF(conversationId);

        // Set headers for file download
        c.header('Content-Type', 'application/json');
        c.header('Content-Disposition', `attachment; filename="conversation_${conversationId}.atif.json"`);

        return c.text(atifJson);
    } catch (error) {
        log.error({ err: error }, 'Error exporting conversation');
        return c.json({ error: error instanceof Error ? error.message : 'Failed to export conversation' }, 500);
    }
});

// ATIF Import endpoint - Import a conversation from ATIF format
const importSchema = z.object({
    atifData: z.string(),
    title: z.string().optional(),
});

api.post('/conversations/import/atif', zValidator('json', importSchema), async (c) => {
    const { atifData, title } = c.req.valid('json');

    // Get the current user
    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }

    try {
        const newConversation = await atifConversationService.importConversationFromATIF(
            user.id,
            atifData,
            title
        );

        return c.json({
            success: true,
            conversationId: newConversation.id,
            title: newConversation.title,
        });
    } catch (error) {
        log.error({ err: error }, 'Error importing conversation');
        return c.json({ error: error instanceof Error ? error.message : 'Failed to import conversation' }, 400);
    }
});


// Skills endpoints

// Get currently loaded skills
api.get('/skills', async (c) => {
    const skills = getLoadedSkills();
    return c.json({ skills });
});

// Reload skills from disk
api.post('/skills/reload', async (c) => {
    log.info('🔄 Reloading skills...');
    const result = await loadSkills();

    if (result.errors.length > 0) {
        for (const error of result.errors) {
            log.warn(`⚠️  ${error.path}: ${error.message}`);
        }
    }

    log.info(`🎯 Loaded ${result.skills.length} skill(s)`);

    return c.json({
        success: true,
        skills: result.skills,
        errors: result.errors,
    });
});

// Create a new skill
const createSkillSchema = z.object({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1024),
    instructions: z.string().optional(),
});

api.post('/skills', zValidator('json', createSkillSchema), async (c) => {
    const input = c.req.valid('json');
    log.info(`✨ Creating skill "${input.name}"`);

    const result = await createSkill(input);

    if (!result.success) {
        log.warn(`⚠️  Failed to create skill: ${result.error}`);
        return c.json({ error: result.error }, 400);
    }

    // Reload skills to include the new one
    await loadSkills();

    log.info(`🎯 Created skill "${input.name}"`);
    return c.json({ success: true, skill: result.skill });
});

// Get a specific skill with its instructions
api.get('/skills/:name', async (c) => {
    const name = c.req.param('name');
    log.info(`📖 Getting skill "${name}"`);

    const result = await getSkill(name);

    if (!result.success) {
        return c.json({ error: result.error }, 404);
    }

    return c.json({
        skill: result.skill,
        instructions: result.instructions,
    });
});

// Update a skill
const updateSkillSchema = z.object({
    description: z.string().min(1).max(1024),
    instructions: z.string().optional(),
});

api.put('/skills/:name', zValidator('json', updateSkillSchema), async (c) => {
    const name = c.req.param('name');
    const input = c.req.valid('json');
    log.info(`✏️  Updating skill "${name}"`);

    const result = await updateSkill(name, input);

    if (!result.success) {
        log.warn(`⚠️  Failed to update skill: ${result.error}`);
        return c.json({ error: result.error }, 400);
    }

    log.info(`✅ Updated skill "${name}"`);
    return c.json({ success: true, skill: result.skill });
});

// Delete a skill
api.delete('/skills/:name', async (c) => {
    const name = c.req.param('name');
    log.info(`🗑️  Deleting skill "${name}"`);

    const result = await deleteSkill(name);

    if (!result.success) {
        log.warn(`⚠️  Failed to delete skill: ${result.error}`);
        return c.json({ error: result.error }, 400);
    }

    log.info(`✅ Deleted skill "${name}"`);
    return c.json({ success: true });
});

// Sandbox settings endpoints

// Get sandbox status (enabled, supported, platform)
api.get('/sandbox/status', async (c) => {
    return c.json({
        enabled: isSandboxEnabled(),
        supported: isSandboxSupported(),
        platform: process.platform,
    });
});

// Get sandbox settings (includes default paths so the UI can filter them out)
api.get('/user/sandbox', async (c) => {
    try {
        const config = getSandboxConfig();
        const defaults = getDefaultPaths();
        return c.json({ ...config, defaults });
    } catch (err) {
        log.error({ err }, 'Failed to load sandbox settings');
        return c.json({ error: 'Failed to load sandbox settings' }, 500);
    }
});

// Update sandbox settings
const sandboxSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    allowedWritePaths: z.array(z.string()).optional(),
    deniedWritePaths: z.array(z.string()).optional(),
    deniedReadPaths: z.array(z.string()).optional(),
    allowedDomains: z.array(z.string()).optional(),
    allowLocalBinding: z.boolean().optional(),
});

api.put('/user/sandbox', zValidator('json', sandboxSettingsSchema), async (c) => {
    try {
        const body = c.req.valid('json');
        await updateSandboxConfig(body);
        log.info('Sandbox settings updated');
        return c.json({ success: true });
    } catch (err) {
        log.error({ err }, 'Failed to save sandbox settings');
        return c.json({ error: 'Failed to save sandbox settings' }, 500);
    }
});

// Upload files to /tmp/pipali/uploads/ (web mode file attachment)
api.post('/upload', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const files = body['files'];
    if (!files) return c.json({ error: 'No files provided' }, 400);

    const fileArray = Array.isArray(files) ? files : [files];
    const uploadDir = path.join(os.tmpdir(), 'pipali', 'uploads');
    await Bun.$`mkdir -p ${uploadDir}`.quiet();

    const results = [];
    for (const file of fileArray) {
        if (typeof file === 'string') continue;
        const uuid = crypto.randomUUID().slice(0, 8);
        const fileName = file.name || 'unknown';
        const destName = `${uuid}-${fileName}`;
        const destPath = path.join(uploadDir, destName);
        await Bun.write(destPath, file);
        results.push({ fileName, filePath: destPath, sizeBytes: file.size });
    }

    return c.json({ files: results });
});

// Serve local image files referenced in model responses
const IMAGE_MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp',
};

const ALLOWED_IMAGE_ROOTS_RAW = [
    os.homedir(),
    '/tmp/pipali',
    '/private/tmp/pipali', // macOS: /tmp symlinks to /private/tmp
    os.tmpdir(),
];

// Resolve symlinks in allowed roots so realpath-resolved file paths still match.
// On macOS, /var → /private/var, so os.tmpdir() "/var/folders/..." resolves to "/private/var/folders/...".
let resolvedImageRoots: string[] | null = null;
async function getAllowedImageRoots(): Promise<string[]> {
    if (resolvedImageRoots) return resolvedImageRoots;
    const roots = new Set(ALLOWED_IMAGE_ROOTS_RAW);
    for (const root of ALLOWED_IMAGE_ROOTS_RAW) {
        try { roots.add(await realpath(root)); } catch {}
    }
    resolvedImageRoots = [...roots];
    return resolvedImageRoots;
}

function isUnderAllowedRoot(filePath: string, roots: string[]): boolean {
    return roots.some(root => filePath.startsWith(root + '/'));
}

api.get('/files', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'Missing path parameter' }, 400);

    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_MIME[ext]) return c.json({ error: 'Only image files can be served' }, 403);

    const roots = await getAllowedImageRoots();
    const resolved = path.resolve(filePath);
    if (!isUnderAllowedRoot(resolved, roots)) {
        return c.json({ error: 'Path not within allowed directories' }, 403);
    }

    try {
        const real = await realpath(resolved);
        if (!isUnderAllowedRoot(real, roots)) {
            return c.json({ error: 'Path not within allowed directories' }, 403);
        }

        const file = Bun.file(real);
        if (!await file.exists()) return c.json({ error: 'File not found' }, 404);

        return c.body(await file.arrayBuffer(), 200, {
            'Content-Type': IMAGE_MIME[ext],
            'Cache-Control': 'private, max-age=3600',
        });
    } catch (err) {
        log.error({ err, path: resolved }, 'Failed to serve file');
        return c.json({ error: 'Failed to read file' }, 500);
    }
});

// Client-side error telemetry
const clientErrorSchema = z.object({
    message: z.string(),
    stack: z.string().optional(),
    url: z.string().optional(),
    componentStack: z.string().optional(),
});
api.post('/telemetry/client-error', zValidator('json', clientErrorSchema), async (c) => {
    const { message, stack, url, componentStack } = c.req.valid('json');
    log.error(
        { err: { message, stack }, component: 'client', url, componentStack },
        `Client error: ${message}`,
    );
    return c.json({ received: true });
});

// Mount the automations router
api.route('/automations', automations);

// Mount the MCP router
api.route('/mcp', mcp);

// Mount the OpenAPI documentation
api.route('/', openapi);

// Mount the auth router
api.route('/auth', auth);

export default api;
