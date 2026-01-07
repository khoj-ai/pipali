import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db, getDefaultChatModel } from '../db';
import { Conversation } from '../db/schema';
import { eq, desc, isNull, and } from 'drizzle-orm';
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
import { syncPlatformModels } from '../auth';

const api = new Hono().basePath('/api');

// Enable CORS for Tauri desktop app (tauri://localhost origin) and local development
api.use('*', cors({
    origin: (origin) => {
        // Allow Tauri app, localhost dev servers, and same-origin requests
        if (!origin) return '*'; // Same-origin or non-browser requests
        if (origin.startsWith('tauri://')) return origin;
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

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[API] 💬 New message received`);
    console.log(`[API] Query: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);
    console.log(`[API] Conversation: ${conversationId || 'new'}`);

    // Get the user
    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!user) {
        console.error(`[API] ❌ User not found: ${getDefaultUser().email}`);
        return c.json({ error: 'User not found' }, 404);
    }
    console.log(`[API] User: ${user.email} (id: ${user.id})`);

    // Get the user's selected model
    const chatModelWithApi = await getDefaultChatModel(user);
    if (chatModelWithApi) {
        console.log(`[API] 🤖 Model: ${chatModelWithApi.chatModel.name} (${chatModelWithApi.chatModel.modelType})`);
        console.log(`[API] Provider: ${chatModelWithApi.aiModelApi?.name || 'Unknown'}`);
    } else {
        console.warn(`[API] ⚠️ No chat model configured`);
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
            'panini-agent',
            '1.0.0',
            modelName
        );
    }

    // Ensure conversation was created
    if (!conversation) {
        return c.json({ error: 'Failed to create or find conversation' }, 500);
    }

    // Run research using shared runner
    console.log(`[API] 🔬 Starting research...`);

    const result = await runResearchToCompletion({
        conversationId: conversation.id,
        user,
        userMessage: message,
    });

    console.log(`[API] ✅ Research complete`);
    console.log(`[API] Iterations: ${result.iterationCount}`);
    console.log(`[API] Response length: ${result.response.length} chars`);
    console.log(`[API] Conversation ID: ${conversation.id}`);
    console.log(`${'='.repeat(60)}\n`);

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

    return c.json({ history });
});

// Get all conversations for the user
api.get('/conversations', async (c) => {
    const [adminUser] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!adminUser) {
        return c.json({ error: 'User not found' }, 404);
    }

    // Filter out automation conversations (those with automationId set)
    const conversations = await db.select({
        id: Conversation.id,
        title: Conversation.title,
        createdAt: Conversation.createdAt,
        updatedAt: Conversation.updatedAt,
        trajectory: Conversation.trajectory,
    })
    .from(Conversation)
    .where(and(
        eq(Conversation.userId, adminUser.id),
        isNull(Conversation.automationId)
    ))
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

        return {
            id: conv.id,
            title: conv.title || preview || 'New conversation',
            preview,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            isActive,
            latestReasoning,
        };
    });

    return c.json({ conversations: result });
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
            return c.json({ success: true, deletedCount });
        } else {
            // Delete just the single step (user message or legacy behavior)
            const deleted = await atifConversationService.deleteStep(conversationId, stepId);
            if (!deleted) {
                return c.json({ error: 'Message not found' }, 404);
            }
            return c.json({ success: true, deletedCount: 1 });
        }
    } catch (error) {
        console.error('[API] Error deleting message:', error);
        return c.json({ error: error instanceof Error ? error.message : 'Failed to delete message' }, 500);
    }
});

// Get all available chat models
api.get('/models', async (c) => {
    // Sync latest chat models from platform, if authenticated
    await syncPlatformModels();

    // Return updated models list from local DB
    const models = await db.select({
        id: ChatModel.id,
        name: ChatModel.name,
        friendlyName: ChatModel.friendlyName,
        modelType: ChatModel.modelType,
        visionEnabled: ChatModel.visionEnabled,
        providerName: AiModelApi.name,
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
        modelId: UserChatModel.modelId,
        modelName: ChatModel.name,
        friendlyName: ChatModel.friendlyName,
        modelType: ChatModel.modelType,
        providerName: AiModelApi.name,
    })
    .from(UserChatModel)
    .leftJoin(ChatModel, eq(UserChatModel.modelId, ChatModel.id))
    .leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id))
    .where(eq(UserChatModel.userId, adminUser.id));

    if (!userModel) {
        // Return first available model as default
        const [defaultModel] = await db.select({
            id: ChatModel.id,
            name: ChatModel.name,
            friendlyName: ChatModel.friendlyName,
            modelType: ChatModel.modelType,
            providerName: AiModelApi.name,
        })
        .from(ChatModel)
        .leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id))
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
        console.error('[API] Error exporting conversation:', error);
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
        console.error('[API] Error importing conversation:', error);
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
    console.log('[API] 🔄 Reloading skills...');
    const result = await loadSkills();

    if (result.errors.length > 0) {
        for (const error of result.errors) {
            console.warn(`[Skills] ⚠️  ${error.path}: ${error.message}`);
        }
    }

    console.log(`[API] 🎯 Loaded ${result.skills.length} skill(s)`);

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
    source: z.enum(['global', 'local']),
});

api.post('/skills', zValidator('json', createSkillSchema), async (c) => {
    const input = c.req.valid('json');
    console.log(`[API] ✨ Creating skill "${input.name}" (${input.source})`);

    const result = await createSkill(input);

    if (!result.success) {
        console.warn(`[API] ⚠️  Failed to create skill: ${result.error}`);
        return c.json({ error: result.error }, 400);
    }

    // Reload skills to include the new one
    await loadSkills();

    console.log(`[API] 🎯 Created skill "${input.name}"`);
    return c.json({ success: true, skill: result.skill });
});

// Get a specific skill with its instructions
api.get('/skills/:name', async (c) => {
    const name = c.req.param('name');
    console.log(`[API] 📖 Getting skill "${name}"`);

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
    console.log(`[API] ✏️  Updating skill "${name}"`);

    const result = await updateSkill(name, input);

    if (!result.success) {
        console.warn(`[API] ⚠️  Failed to update skill: ${result.error}`);
        return c.json({ error: result.error }, 400);
    }

    console.log(`[API] ✅ Updated skill "${name}"`);
    return c.json({ success: true, skill: result.skill });
});

// Delete a skill
api.delete('/skills/:name', async (c) => {
    const name = c.req.param('name');
    console.log(`[API] 🗑️  Deleting skill "${name}"`);

    const result = await deleteSkill(name);

    if (!result.success) {
        console.warn(`[API] ⚠️  Failed to delete skill: ${result.error}`);
        return c.json({ error: result.error }, 400);
    }

    console.log(`[API] ✅ Deleted skill "${name}"`);
    return c.json({ success: true });
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
