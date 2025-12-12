import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db, getDefaultChatModel } from '../db';
import { Conversation } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { AiModelApi, ChatModel, User, UserChatModel } from '../db/schema';
import openapi from './openapi';

import { type ChatMessage } from '../db/schema';
import { getDefaultUser } from '../utils';
import { research } from '../processor/director';

const api = new Hono().basePath('/api');

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

    let conversation;
    let history: ChatMessage[] = [];

    if (conversationId) {
        const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
        conversation = results[0];
        if (conversation && conversation.conversationLog) {
            history = conversation.conversationLog.chat;
        }
    }

    // Use research agent to handle the query
    console.log(`[API] 🔬 Starting research...`);
    const researchIterations = [];
    let finalResponse = '';

    for await (const iteration of research({
        query: message,
        chatHistory: history,
        maxIterations: 5,
        currentDate: new Date().toISOString().split('T')[0],
        dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
        user: user,
    })) {
        // Log iteration
        if (iteration.query && typeof iteration.query !== 'string') {
            console.log(`[API] 🔧 Tool: ${iteration.query.name}`, iteration.query.args ? JSON.stringify(iteration.query.args).slice(0, 100) : '');
        }

        if (iteration.warning) {
            console.warn(`[API] ⚠️ Research warning: ${iteration.warning}`);
            continue;
        }

        if (iteration.query && typeof iteration.query !== 'string' && iteration.query.name === 'text') {
            // Final response from text tool
            finalResponse = iteration.query.args.response || '';
            break;
        }

        researchIterations.push(iteration);
    }

    console.log(`[API] ✅ Research complete`);
    console.log(`[API] Iterations: ${researchIterations.length}`);
    console.log(`[API] Response length: ${finalResponse.length} chars`);
    console.log(`[API] Conversation ID: ${conversation?.id}`);
    console.log(`${'='.repeat(60)}\n`);

    // If no final response was generated, create one from the last iteration
    if (!finalResponse && researchIterations.length > 0) {
        const lastIteration = researchIterations[researchIterations.length - 1];
        finalResponse = lastIteration?.summarizedResult || 'Research completed but no final response generated.';
    } else if (!finalResponse) {
        finalResponse = 'Failed to generate response.';
    }

    const turnId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const userMessageToLog: ChatMessage = { by: 'user', message, created: createdAt, turnId };
    const aiMessageToLog: ChatMessage = { by: 'assistant', message: finalResponse, created: createdAt, turnId };

    if (conversation) {
        const updatedLog = { chat: [...(conversation.conversationLog?.chat || []), userMessageToLog, aiMessageToLog] };
        await db.update(Conversation).set({ conversationLog: updatedLog }).where(eq(Conversation.id, conversation.id));
    } else {
        const [adminUser] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
        if (!adminUser) {
            return c.json({ error: 'Admin user not found. Please set PANINI_ADMIN_EMAIL and PANINI_ADMIN_PASSWORD environment variables.' }, 500);
        }
        const newConversation = await db.insert(Conversation).values({ conversationLog: { chat: [userMessageToLog, aiMessageToLog] }, userId: adminUser.id }).returning();
        conversation = newConversation[0];
    }

    return c.json({ response: finalResponse, conversationId: conversation?.id, iterations: researchIterations.length });
});

api.get('/chat/:conversationId/history', async (c) => {
    const conversationId = c.req.param('conversationId');
    // validate uuid
    try {
        z.string().uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
    const conversation = results[0];

    if (!conversation) {
        return c.json({ error: 'Conversation not found' }, 404);
    }

    return c.json({ history: conversation.conversationLog?.chat || [] });
});

// Get all conversations for the user
api.get('/conversations', async (c) => {
    const [adminUser] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!adminUser) {
        return c.json({ error: 'User not found' }, 404);
    }

    const conversations = await db.select({
        id: Conversation.id,
        title: Conversation.title,
        createdAt: Conversation.createdAt,
        updatedAt: Conversation.updatedAt,
        conversationLog: Conversation.conversationLog,
    })
    .from(Conversation)
    .where(eq(Conversation.userId, adminUser.id))
    .orderBy(desc(Conversation.updatedAt));

    // Map to include a preview from first message
    const result = conversations.map(conv => {
        const firstUserMsg = conv.conversationLog?.chat?.find(m => m.by === 'user');
        const preview = firstUserMsg
            ? (typeof firstUserMsg.message === 'string' ? firstUserMsg.message : JSON.stringify(firstUserMsg.message)).slice(0, 100)
            : '';
        return {
            id: conv.id,
            title: conv.title || preview || 'New conversation',
            preview,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
        };
    });

    return c.json({ conversations: result });
});

// Delete a conversation
api.delete('/conversations/:conversationId', async (c) => {
    const conversationId = c.req.param('conversationId');
    try {
        z.string().uuid().parse(conversationId);
    } catch (e) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    await db.delete(Conversation).where(eq(Conversation.id, conversationId));
    return c.json({ success: true });
});

// Get all available chat models
api.get('/models', async (c) => {
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

// Mount the OpenAPI documentation
api.route('/', openapi);

export default api;
