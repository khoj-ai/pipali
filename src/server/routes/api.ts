import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { db } from '../db';
import { conversations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { aiModelApis, chatModels, users } from '../db/schema';
import openapi from './openapi';

import { type ChatMessage } from '../db/schema';
import { getDefaultUser } from '../utils';

const api = new Hono();

const schema = z.object({
    message: z.string(),
    conversationId: z.uuid().optional(),
});

api.post('/chat', zValidator('json', schema), async (c) => {
    const { message, conversationId } = c.req.valid('json');

    console.log(`💬 Received message: ${message} for ${conversationId ? conversationId : 'new conversation'}`);
    const [openAIModel] = await db.select().from(chatModels)
        .leftJoin(aiModelApis, eq(chatModels.aiModelApiId, aiModelApis.id))
        .where(eq(chatModels.modelType, 'openai'));

    if (!openAIModel) {
        return c.json({ error: 'No OpenAI model configured. Please set OPENAI_API_KEY environment variable.' }, 500);
    }

    const chat = new ChatOpenAI({
        openAIApiKey: openAIModel.ai_model_apis?.apiKey,
        modelName: openAIModel.chat_models.name,
        configuration: {
            baseURL: openAIModel.ai_model_apis?.apiBaseUrl,
        }
    });

    let conversation;
    let history: (HumanMessage | AIMessage)[] = [];

    if (conversationId) {
        const results = await db.select().from(conversations).where(eq(conversations.id, conversationId));
        conversation = results[0];
        if (conversation && conversation.conversationLog) {
            history = conversation.conversationLog.chat.map((msg) => {
                if (msg.by === 'user') {
                    return new HumanMessage(msg.message);
                } else {
                    return new AIMessage(msg.message);
                }
            });
        }
    }

    const response = await chat.invoke([
        ...history,
        new HumanMessage(message),
    ]);

    const aiMessage = response.content as string;
    const turnId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const userMessageToLog: ChatMessage = { by: 'user', message, created: createdAt, turnId };
    const aiMessageToLog: ChatMessage = { by: 'assistant', message: aiMessage, created: createdAt, turnId };

    if (conversation) {
        const updatedLog = { chat: [...(conversation.conversationLog?.chat || []), userMessageToLog, aiMessageToLog] };
        await db.update(conversations).set({ conversationLog: updatedLog }).where(eq(conversations.id, conversation.id));
    } else {
        const [adminUser] = await db.select().from(users).where(eq(users.email, getDefaultUser().email));
        if (!adminUser) {
            return c.json({ error: 'Admin user not found. Please set KHOJ_ADMIN_EMAIL and KHOJ_ADMIN_PASSWORD environment variables.' }, 500);
        }
        const newConversation = await db.insert(conversations).values({ conversationLog: { chat: [userMessageToLog, aiMessageToLog] }, userId: adminUser.id }).returning();
        conversation = newConversation[0];
    }

    return c.json({ response: aiMessage, conversationId: conversation?.id });
});

// Mount the OpenAPI documentation
api.route('/', openapi);

export default api;
