import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db';
import { Conversation } from '../db/schema';
import { eq } from 'drizzle-orm';
import { AiModelApi, ChatModel, User } from '../db/schema';
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

    console.log(`💬 Received message: ${message} for ${conversationId ? conversationId : 'new conversation'}`);
    const [openAIModel] = await db.select().from(ChatModel)
        .leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id))
        .where(eq(ChatModel.modelType, 'openai'));

    if (!openAIModel) {
        return c.json({ error: 'No OpenAI model configured. Please set OPENAI_API_KEY and/or OPENAI_BASE_URL environment variable.' }, 500);
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
    const researchIterations = [];
    let finalResponse = '';

    for await (const iteration of research({
        query: message,
        chatHistory: history,
        maxIterations: 5,
        currentDate: new Date().toISOString().split('T')[0],
        dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    })) {
        if (iteration.warning) {
            console.warn('Research warning:', iteration.warning);
            continue;
        }

        if (iteration.query && typeof iteration.query !== 'string' && iteration.query.name === 'text') {
            // Final response from text tool
            finalResponse = iteration.query.args.response || '';
            break;
        }

        researchIterations.push(iteration);
    }

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

// Mount the OpenAPI documentation
api.route('/', openapi);

export default api;
