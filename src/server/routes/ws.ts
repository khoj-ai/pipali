import type { ServerWebSocket } from "bun";
import { research } from "../processor/director";
import { db } from "../db";
import { Conversation, User, type ChatMessage } from "../db/schema";
import { eq } from "drizzle-orm";
import { getDefaultUser } from "../utils";

export type WebSocketData = {
    conversationId?: string;
};

export const websocketHandler = {
    async message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
        if (typeof message !== "string") return;

        let data: { message: string, conversationId?: string };
        try {
            data = JSON.parse(message);
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
            return;
        }

        const { message: userQuery, conversationId } = data;
        console.log(`ws: 💬 Received message: ${userQuery} for ${conversationId || 'new conversation'}`);

        let conversation;
        let history: ChatMessage[] = [];

        if (conversationId) {
            const results = await db.select().from(Conversation).where(eq(Conversation.id, conversationId));
            conversation = results[0];
            if (conversation && conversation.conversationLog) {
                history = conversation.conversationLog.chat;
            }
        }

        // Run research
        const researchIterations = [];
        let finalResponse = '';

        try {
            for await (const iteration of research({
                query: userQuery,
                chatHistory: history,
                maxIterations: 5,
                currentDate: new Date().toISOString().split('T')[0],
                dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
            })) {
                // Send iteration event
                ws.send(JSON.stringify({
                    type: 'iteration',
                    data: iteration
                }));

                if (iteration.query && typeof iteration.query !== 'string' && iteration.query.name === 'text') {
                    finalResponse = iteration.query.args.response || '';
                }
                researchIterations.push(iteration);
            }
        } catch (error) {
             console.error("Research error:", error);
             ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
             return;
        }

        // If no final response was generated, create one from the last iteration
        if (!finalResponse && researchIterations.length > 0) {
            const lastIteration = researchIterations[researchIterations.length - 1];
            finalResponse = lastIteration?.summarizedResult || 'Research completed but no final response generated.';
        } else if (!finalResponse) {
            finalResponse = 'Failed to generate response.';
        }

        // Save to DB
        const turnId = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const userMessageToLog: ChatMessage = { by: 'user', message: userQuery, created: createdAt, turnId };
        const aiMessageToLog: ChatMessage = { by: 'assistant', message: finalResponse, created: createdAt, turnId };

        if (conversation) {
             const updatedLog = { chat: [...(conversation.conversationLog?.chat || []), userMessageToLog, aiMessageToLog] };
             await db.update(Conversation).set({ conversationLog: updatedLog }).where(eq(Conversation.id, conversation.id));
        } else {
             const [adminUser] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
             if (adminUser) {
                 const newConversation = await db.insert(Conversation).values({ conversationLog: { chat: [userMessageToLog, aiMessageToLog] }, userId: adminUser.id }).returning();
                 conversation = newConversation[0];
             } else {
                 ws.send(JSON.stringify({ type: 'error', error: 'Admin user not found.' }));
                 return;
             }
        }

        ws.send(JSON.stringify({
            type: 'complete',
            data: {
                response: finalResponse,
                conversationId: conversation?.id
            }
        }));
    },
    open(ws: ServerWebSocket<WebSocketData>) {
        console.log("ws: connected");
    },
    close(ws: ServerWebSocket<WebSocketData>) {
        console.log("ws: disconnected");
    }
};
