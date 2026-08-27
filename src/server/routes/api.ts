import os from 'os';
import path from 'path';
import { realpath } from 'fs/promises';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db, getDefaultChatModel } from '../db';
import { Automation, Conversation } from '../db/schema';
import { asc, eq, desc, and, sql } from 'drizzle-orm';
import { AiModelApi, ChatModel, User, UserChatModel } from '../db/schema';
import { isAllowedOrigin } from './origin-guard';
import openapi from './openapi';
import automations from './automations';
import mcp from './mcp';
import auth from './auth';

import { getDefaultUser } from '../utils';
import { atifConversationService } from '../processor/conversation/atif/atif.service';
import { runResearchToCompletion } from '../processor/research-runner';
import { getActiveStatus } from '../sessions';
import { transcribeAudio, synthesizeSpeech, summarizeForSpeech, VoiceUnavailableError } from '../voice';
import { PlatformAuthError } from '../http/platform-fetch';
import { PlatformBillingError } from '../http/billing-errors';
import { loadSkills, getLoadedSkills, createSkill, getSkill, deleteSkill, updateSkill, toggleSkillVisibility, resetBuiltinSkill } from '../skills';
import { loadUserContext, saveUserContext } from '../user-context';
import { deleteAllMemories, deleteMemory, getMemory, listMemories } from '../memory';
import { loadMemorySettings, saveMemorySettings } from '../memory/settings';
import { stopDreaming } from '../memory/dream';
import { syncPlatformModels, syncPlatformWebTools } from '../auth';
import { createChildLogger } from '../logger';
import { IS_COMPILED_BINARY, EMBEDDED_CHANGELOG } from '../embedded-assets';
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
api.use('*', cors({
    origin: (origin, c) => {
        // Allow Tauri app, localhost dev servers, and same-origin requests
        if (!origin) return '*'; // Same-origin or non-browser requests
        return isAllowedOrigin(origin, c.req.header('Host')) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// CORS hides disallowed responses but does not stop simple cross-origin writes.
api.use('*', async (c, next) => {
    const origin = c.req.header('Origin');
    const safeMethod = c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS';
    if (origin && !safeMethod && !isAllowedOrigin(origin, c.req.header('Host'))) {
        return c.json({ error: 'Forbidden origin' }, 403);
    }
    await next();
});

// Health check endpoint for Tauri sidecar readiness detection
api.get('/health', (c) => c.json({ status: 'ok' }));

// Get release notes for current version from CHANGELOG.md
api.get('/changelog', async (c) => {
    try {
        const { version } = await import('../../../package.json');

        // Use embedded changelog in compiled single-file builds
        if (IS_COMPILED_BINARY && EMBEDDED_CHANGELOG) {
            return c.json({ version, notes: EMBEDDED_CHANGELOG });
        }

        // Read from disk: Tauri resource dir, or project root in dev
        const resourceDir = process.env.PIPALI_SERVER_RESOURCE_DIR;
        const changelogPath = resourceDir
            ? `${resourceDir}/CHANGELOG.md`
            : new URL('../../../CHANGELOG.md', import.meta.url).pathname;
        const text = await Bun.file(changelogPath).text();

        // Extract section for current version (between "## <version>" and next "## ")
        const header = `## ${version}`;
        const startIdx = text.indexOf(header);
        if (startIdx === -1) {
            return c.json({ version, notes: null });
        }
        const afterHeader = startIdx + header.length;
        const nextSection = text.indexOf('\n## ', afterHeader);
        const notes = (nextSection === -1 ? text.slice(afterHeader) : text.slice(afterHeader, nextSection)).trim();
        return c.json({ version, notes });
    } catch {
        return c.json({ version: null, notes: null });
    }
});

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

    const conversation = await atifConversationService.getConversation(conversationId);

    if (!conversation) {
        return c.json({ error: 'Conversation not found' }, 404);
    }

    // Pass chat history to frontend
    const history = conversation.trajectory.steps;

    return c.json({ history, chatModelId: conversation.chatModelId });
});

// Get all conversations for the user (with optional full-text search via ?q=)
/**
 * One row per conversation, with the preview and reasoning line the sidebar shows.
 *
 * Each of those is a single step, found through the primary key on
 * (conversation_id, step_id) rather than by reading the conversation's steps - or, as
 * this once did, every step every conversation ever recorded, to keep one per
 * conversation and throw the rest away. That scan grew with the whole history and ran
 * on the same thread as the agent loop.
 */
function conversationListQuery(userId: number, searchPattern: string | undefined) {
    const searching = searchPattern !== undefined;

    // Steps a search looks through: what the user wrote and what the agent said back,
    // never a tool call or a compaction summary.
    const searchableStep = sql`(s.source = 'user' OR (s.source = 'agent' AND NOT s.step ? 'tool_calls'))
        AND NOT coalesce(s.step->'extra' ? 'is_compaction', false)`;

    const matchLookup = searching
        ? sql`
            LEFT JOIN LATERAL (
                SELECT s.step->>'message' AS message
                FROM conversation_step s
                WHERE s.conversation_id = c.id
                  AND s.step->>'message' ILIKE ${searchPattern}
                  AND ${searchableStep}
                ORDER BY s.step_id ASC
                LIMIT 1
            ) hit ON true`
        : sql``;

    return sql`
        SELECT
            c.id,
            c.title,
            c.created_at,
            c.updated_at,
            c.chat_model_id,
            c.automation_id,
            c.parent_conversation_id,
            c.is_pinned,
            preview.message_preview,
            reasoning.reasoning
            ${searching ? sql`, hit.message AS match_message` : sql``}
        FROM conversation c
        LEFT JOIN LATERAL (
            SELECT s.message_preview
            FROM conversation_step s
            WHERE s.conversation_id = c.id
              AND s.source = 'user'
              AND NOT coalesce(s.step->'extra' ? 'is_compaction', false)
            ORDER BY s.step_id ASC
            LIMIT 1
        ) preview ON true
        LEFT JOIN LATERAL (
            SELECT s.step->>'reasoning_content' AS reasoning
            FROM conversation_step s
            WHERE s.conversation_id = c.id
              AND s.source = 'agent'
              AND s.step->>'reasoning_content' <> ''
            ORDER BY s.step_id DESC
            LIMIT 1
        ) reasoning ON true
        ${matchLookup}
        WHERE c.user_id = ${userId}
        ${searching ? sql`AND (c.title ILIKE ${searchPattern} OR hit.message IS NOT NULL)` : sql``}
        ORDER BY c.updated_at DESC
    `;
}

interface ConversationListRow {
    id: string;
    title: string | null;
    created_at: Date;
    updated_at: Date;
    chat_model_id: number | null;
    automation_id: string | null;
    parent_conversation_id: string | null;
    is_pinned: boolean;
    message_preview: string | null;
    reasoning: string | null;
    match_message?: string | null;
}

/** A snippet of the matched message, with enough either side to read it in context. */
function matchSnippetFor(message: string | null | undefined, q: string): string | undefined {
    if (!message) return undefined;
    const matchIndex = message.toLowerCase().indexOf(q.toLowerCase());
    if (matchIndex === -1) return undefined;

    const contextRadius = 50;
    const start = Math.max(0, matchIndex - contextRadius);
    const end = Math.min(message.length, matchIndex + q.length + contextRadius);
    return `${start > 0 ? '...' : ''}${message.slice(start, end)}${end < message.length ? '...' : ''}`;
}

api.get('/conversations', async (c) => {
    const [adminUser] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!adminUser) {
        return c.json({ error: 'User not found' }, 404);
    }

    const q = c.req.query('q')?.trim();
    const searchPattern = q ? `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%` : undefined;

    const { rows } = await db.execute(conversationListQuery(adminUser.id, searchPattern));

    const result = (rows as unknown as ConversationListRow[]).map(conv => {
        const preview = conv.message_preview?.slice(0, 100) ?? '';

        // A running conversation reports its own reasoning; a settled one is read back
        // from the last step that recorded any.
        const sessionStatus = getActiveStatus(conv.id);
        const latestReasoning = sessionStatus?.latestReasoning
            ?? conv.reasoning?.split('\n')[0]?.replace(/^\*\*|\*\*$/g, '').slice(0, 80);

        // A title match is already visible, so only a match in the messages needs showing.
        const shownTitle = conv.title || preview || '';
        const matchSnippet = q && !shownTitle.toLowerCase().includes(q.toLowerCase())
            ? matchSnippetFor(conv.match_message, q)
            : undefined;

        return {
            id: conv.id,
            title: shownTitle || 'New conversation',
            preview,
            createdAt: conv.created_at,
            updatedAt: conv.updated_at,
            chatModelId: conv.chat_model_id,
            isActive: sessionStatus?.isActive ?? false,
            isAutomation: !!conv.automation_id,
            parentConversationId: conv.parent_conversation_id,
            isPinned: conv.is_pinned,
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

    const deleted = await db.delete(Conversation).where(eq(Conversation.id, conversationId)).returning();
    if (deleted.length === 0) {
        return c.json({ error: 'Conversation not found' }, 404);
    }
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
        tier: ChatModel.tier,
        tagline: ChatModel.tagline,
        costTier: ChatModel.costTier,
        recommended: ChatModel.recommended,
    })
    .from(ChatModel)
    .leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id))
    .orderBy(asc(ChatModel.sortOrder), asc(ChatModel.id));

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
    language: z.string().optional(),
    instructions: z.string().optional(),
});

api.put('/user/context', zValidator('json', userContextSchema), async (c) => {
    try {
        const body = c.req.valid('json');
        // Merge with existing context so partial updates (e.g. language-only) don't erase other fields
        const existing = await loadUserContext();
        await saveUserContext({
            name: body.name ?? existing.name,
            location: body.location ?? existing.location,
            language: body.language ?? existing.language,
            instructions: body.instructions ?? existing.instructions,
        });
        return c.json({ success: true });
    } catch (err) {
        log.error({ err }, 'Failed to save user context');
        return c.json({ error: 'Failed to save user context' }, 500);
    }
});

api.get('/memory/settings', async (c) => {
    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }

    try {
        return c.json(await loadMemorySettings(user.id));
    } catch (err) {
        log.error({ err }, 'Failed to load memory settings');
        return c.json({ error: 'Failed to load memory settings' }, 500);
    }
});

const memorySettingsSchema = z.object({
    memoriesEnabled: z.boolean().optional(),
});

api.put('/memory/settings', zValidator('json', memorySettingsSchema), async (c) => {
    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!user) {
        return c.json({ error: 'User not found' }, 404);
    }

    try {
        const settings = await saveMemorySettings(user.id, c.req.valid('json'));
        if (!settings.memoriesEnabled) {
            await stopDreaming(user.id);
        }
        return c.json(settings);
    } catch (err) {
        log.error({ err }, 'Failed to save memory settings');
        return c.json({ error: 'Failed to save memory settings' }, 500);
    }
});

api.get('/memory', async (c) => {
    try {
        return c.json({ memories: await listMemories() });
    } catch (err) {
        log.error({ err }, 'Failed to list memories');
        return c.json({ error: 'Failed to list memories' }, 500);
    }
});

api.get('/memory/:file', async (c) => {
    try {
        const memory = await getMemory(c.req.param('file'));
        return memory
            ? c.json({ memory })
            : c.json({ error: 'Memory not found' }, 404);
    } catch (err) {
        log.error({ err }, 'Failed to load memory');
        return c.json({ error: 'Failed to load memory' }, 500);
    }
});

api.delete('/memory', async (c) => {
    try {
        return c.json({ success: true, deleted: await deleteAllMemories() });
    } catch (err) {
        log.error({ err }, 'Failed to delete memories');
        return c.json({ error: 'Failed to delete memories' }, 500);
    }
});

api.delete('/memory/:file', async (c) => {
    try {
        const deleted = await deleteMemory(c.req.param('file'));
        return deleted
            ? c.json({ success: true })
            : c.json({ error: 'Memory not found' }, 404);
    } catch (err) {
        log.error({ err }, 'Failed to delete memory');
        return c.json({ error: 'Failed to delete memory' }, 500);
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

// Toggle skill visibility
const toggleVisibilitySchema = z.object({
    visible: z.boolean(),
});

api.patch('/skills/:name/visibility', zValidator('json', toggleVisibilitySchema), async (c) => {
    const name = c.req.param('name');
    const { visible } = c.req.valid('json');

    const result = await toggleSkillVisibility(name, visible);

    if (!result.success) {
        return c.json({ error: result.error }, 400);
    }

    return c.json({ success: true, skill: result.skill });
});

// Restore a builtin skill to the version shipped with this build
api.post('/skills/:name/reset', async (c) => {
    const name = c.req.param('name');
    log.info(`♻️  Resetting builtin skill "${name}"`);

    const result = await resetBuiltinSkill(name);

    if (!result.success) {
        log.warn(`⚠️  Failed to reset skill: ${result.error}`);
        return c.json({ error: result.error }, 400);
    }

    log.info(`✅ Reset skill "${name}"`);
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

// Upload files to Pipali's system temp directory (web mode file attachment)
api.post('/upload', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const files = body['files'];
    if (!files) return c.json({ error: 'No files provided' }, 400);

    const fileArray = Array.isArray(files) ? files : [files];
    const uploadDir = path.resolve(os.tmpdir(), 'pipali', 'uploads');
    await Bun.$`mkdir -p ${uploadDir}`.quiet();

    const results = [];
    for (const file of fileArray) {
        if (typeof file === 'string') continue;
        const uuid = crypto.randomUUID().slice(0, 8);
        const fileName = path.basename((file.name || 'unknown').replaceAll('\\', '/')) || 'unknown';
        const destName = `${uuid}-${fileName}`;
        const destPath = path.resolve(uploadDir, destName);
        if (path.dirname(destPath) !== uploadDir) {
            return c.json({ error: 'Invalid file name' }, 400);
        }
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

// ============================================
// Voice (speech-to-text / text-to-speech)
// ============================================

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI upload cap
// MediaRecorder emits webm/opus on Chromium and mp4/aac on WKWebView; audio-only
// recordings are often labeled with the video container MIME, so accept those too.
const ALLOWED_AUDIO_MIME = new Set([
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a',
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac',
    'video/webm', 'video/mp4', 'video/ogg',
]);
function isAllowedAudioMime(type: string): boolean {
    const base = type.split(';')[0]!.trim().toLowerCase();
    return base.startsWith('audio/') || ALLOWED_AUDIO_MIME.has(base);
}

function voiceErrorResponse(c: Context, error: unknown) {
    if (error instanceof VoiceUnavailableError) return c.json({ error: error.message, code: 'voice_unavailable' }, 503);
    if (error instanceof PlatformAuthError) return c.json({ error: error.message, code: 'auth_error' }, 401);
    if (error instanceof PlatformBillingError) return c.json({ error: error.message, code: 'billing_error' }, 402);
    log.error({ err: error }, 'Voice request failed');
    return c.json({ error: error instanceof Error ? error.message : 'Voice request failed', code: 'voice_error' }, 500);
}

api.post('/voice/transcribe', async (c) => {
    let body: Record<string, unknown>;
    try {
        body = await c.req.parseBody();
    } catch {
        return c.json({ error: 'Invalid multipart form data' }, 400);
    }
    const file = body['file'];
    if (!(file instanceof File)) return c.json({ error: 'Missing audio file field "file"' }, 400);
    if (file.size > MAX_AUDIO_BYTES) return c.json({ error: 'Audio file exceeds 25MB limit' }, 413);
    if (!isAllowedAudioMime(file.type)) return c.json({ error: `Unsupported audio type '${file.type}'` }, 415);

    const model = typeof body['model'] === 'string' ? body['model'] : undefined;
    const language = typeof body['language'] === 'string' ? body['language'] : undefined;
    const prompt = typeof body['prompt'] === 'string' ? body['prompt'].slice(0, 500) : undefined;
    try {
        return c.json(await transcribeAudio({ file, model, language, prompt }));
    } catch (error) {
        return voiceErrorResponse(c, error);
    }
});

const voiceSpeechSchema = z.object({
    text: z.string().min(1).max(4096),
    voice: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(128).optional(),
    format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
});
api.post('/voice/speech', zValidator('json', voiceSpeechSchema), async (c) => {
    const { text, voice, model, format } = c.req.valid('json');
    try {
        const result = await synthesizeSpeech({ text, voice, model, format });
        return new Response(result.stream, {
            status: 200,
            headers: { 'Content-Type': result.contentType },
        });
    } catch (error) {
        return voiceErrorResponse(c, error);
    }
});

// Cap kept in sync with SUMMARIZE_TEXT_CAP in src/client/utils/voice/voice-config.ts.
const voiceSummarizeSchema = z.object({
    text: z.string().min(1).max(50_000),
    kind: z.enum(['response', 'action']).optional(),
});
api.post('/voice/summarize', zValidator('json', voiceSummarizeSchema), async (c) => {
    const { text, kind } = c.req.valid('json');
    try {
        return c.json(await summarizeForSpeech(text, kind));
    } catch (error) {
        return voiceErrorResponse(c, error);
    }
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
