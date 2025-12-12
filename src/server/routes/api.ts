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
import { atifConversationService } from '../processor/conversation/atif/atif.service';
import { type ATIFToolCall, type ATIFObservationResult } from '../processor/conversation/atif/atif.types';
import { convertATIFToChatMessages } from '../processor/conversation/atif/atif.utils';

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

    // Get or create conversation BEFORE starting research
    if (conversationId) {
        const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
        conversation = results[0];
        if (conversation && conversation.trajectory) {
            // Extract message history from ATIF trajectory for research function
            history = convertATIFToChatMessages(conversation.trajectory);
        }
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

    // Add user message to conversation immediately
    await atifConversationService.addStep(
        conversation.id,
        'user',
        message
    );

    // Run research and add steps as they happen
    console.log(`[API] 🔬 Starting research...`);
    let finalResponse = '';
    let iterationCount = 0;

    for await (const iteration of research({
        query: message,
        chatHistory: history,
        maxIterations: 15,
        currentDate: new Date().toISOString().split('T')[0],
        dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
        user: user,
    })) {
        iterationCount++;

        // Log tool calls
        for (const tc of iteration.toolCalls) {
            console.log(`[API] 🔧 Tool: ${tc.name}`, tc.args ? JSON.stringify(tc.args).slice(0, 100) : '');
        }
        if (iteration.toolCalls.length > 1) {
            console.log(`[API] ⚡ Executing ${iteration.toolCalls.length} tools in parallel`);
        }

        if (iteration.warning) {
            console.warn(`[API] ⚠️ Research warning: ${iteration.warning}`);
            continue;
        }

        // Check for text tool (final response)
        const textTool = iteration.toolCalls.find(tc => tc.name === 'text');
        if (textTool) {
            finalResponse = textTool.args.response || '';
            // Don't add the text tool as a step, we'll add it as the final response
            break;
        }

        // Add the entire iteration as a single step in the trajectory
        if (iteration.toolCalls.length > 0 && iteration.toolResults) {
            const toolCalls: ATIFToolCall[] = iteration.toolCalls.map(tc => ({
                tool_call_id: tc.id,
                function_name: tc.name,
                arguments: tc.args || {},
            }));

            const observationResults: ATIFObservationResult[] = iteration.toolResults.map(tr => ({
                source_call_id: tr.toolCall.id,
                content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
            }));

            await atifConversationService.addStep(
                conversation.id,
                'agent',
                '', // No message for tool execution steps
                undefined,
                toolCalls,
                { results: observationResults },
                iteration.thought // Add reasoning as part of the same step
            );
        } else {
            console.warn(`[API] ⚠️ No tool calls or results in iteration`);
        }
    }

    // If no final response was generated, create one
    if (!finalResponse) {
        finalResponse = 'Failed to generate response.';
    }

    // Add final response as the last agent step
    await atifConversationService.addStep(
        conversation.id,
        'agent',
        finalResponse
    );

    console.log(`[API] ✅ Research complete`);
    console.log(`[API] Iterations: ${iterationCount}`);
    console.log(`[API] Response length: ${finalResponse.length} chars`);
    console.log(`[API] Conversation ID: ${conversation?.id}`);
    console.log(`${'='.repeat(60)}\n`);

    return c.json({ response: finalResponse, conversationId: conversation?.id, iterations: iterationCount });
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

    // Convert ATIF trajectory to frontend-compatible format
    const history = convertATIFToChatMessages(conversation.trajectory);

    return c.json({ history });
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
        trajectory: Conversation.trajectory,
    })
    .from(Conversation)
    .where(eq(Conversation.userId, adminUser.id))
    .orderBy(desc(Conversation.updatedAt));

    // Map to include a preview from first message
    const result = conversations.map(conv => {
        // Find first user message in trajectory
        const firstUserStep = conv.trajectory?.steps?.find(s => s.source === 'user');
        const preview = firstUserStep?.message
            ? firstUserStep.message.slice(0, 100)
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
        z.uuid().parse(conversationId);
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


// Mount the OpenAPI documentation
api.route('/', openapi);

export default api;
