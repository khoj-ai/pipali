import type { ServerWebSocket } from "bun";
import { research } from "../processor/director";
import { db, getDefaultChatModel } from "../db";
import { Conversation, User, type ChatMessage, type TrainOfThought } from "../db/schema";
import { eq } from "drizzle-orm";
import { getDefaultUser } from "../utils";
import type { ResearchIteration } from "../processor/director/types";

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
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[WS] 💬 New message received`);
        console.log(`[WS] Query: "${userQuery.slice(0, 100)}${userQuery.length > 100 ? '...' : ''}"`);
        console.log(`[WS] Conversation: ${conversationId || 'new'}`);

        // Get the user
        const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
        if (!user) {
            console.error(`[WS] ❌ User not found: ${getDefaultUser().email}`);
            ws.send(JSON.stringify({ type: 'error', error: 'User not found' }));
            return;
        }
        console.log(`[WS] User: ${user.email} (id: ${user.id})`);

        // Get the user's selected model
        const chatModelWithApi = await getDefaultChatModel(user);
        if (chatModelWithApi) {
            console.log(`[WS] 🤖 Model: ${chatModelWithApi.chatModel.name} (${chatModelWithApi.chatModel.modelType})`);
            console.log(`[WS] Provider: ${chatModelWithApi.aiModelApi?.name || 'Unknown'}`);
        } else {
            console.warn(`[WS] ⚠️ No chat model configured`);
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

        // Run research
        console.log(`[WS] 🔬 Starting research...`);
        const researchIterations = [];
        let finalResponse = '';

        try {
            for await (const iteration of research({
                query: userQuery,
                chatHistory: history,
                maxIterations: 15,
                currentDate: new Date().toISOString().split('T')[0],
                dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
                user: user,
            })) {
                // Log tool calls
                for (const tc of iteration.toolCalls) {
                    console.log(`[WS] 🔧 Tool: ${tc.name}`, tc.args ? JSON.stringify(tc.args).slice(0, 100) : '');
                }
                if (iteration.toolCalls.length > 1) {
                    console.log(`[WS] ⚡ Executing ${iteration.toolCalls.length} tools in parallel`);
                }
                if (iteration.warning) {
                    console.warn(`[WS] ⚠️ Warning: ${iteration.warning}`);
                }

                // Check for text tool (final response)
                const textTool = iteration.toolCalls.find(tc => tc.name === 'text');
                if (textTool) {
                    finalResponse = textTool.args.response || '';
                } else {
                    // Send iteration update to client.
                    // Exclude final response as it is rendered via 'complete' message
                    ws.send(JSON.stringify({ type: 'iteration', data: iteration }));
                }

                researchIterations.push(iteration);
            }
        } catch (error) {
             console.error(`[WS] ❌ Research error:`, error);
             ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
             return;
        }

        // If no final response was generated, create one from the last iteration's tool results
        if (!finalResponse && researchIterations.length > 0) {
            const lastIteration = researchIterations[researchIterations.length - 1];
            const lastResults = lastIteration?.toolResults?.map(tr => tr.result).join('\n\n');
            finalResponse = lastResults || 'Research completed but no final response generated.';
        } else if (!finalResponse) {
            finalResponse = 'Failed to generate response.';
        }

        // Convert research iterations to trainOfThought format for storage
        const trainOfThought: TrainOfThought[] = researchIterations.flatMap((iteration: ResearchIteration) => {
            const thoughts: TrainOfThought[] = [];

            // Add reasoning/thought if present
            if (iteration.thought) {
                thoughts.push({ type: 'thought', data: iteration.thought });
            }

            // Add each tool call with its result
            for (const toolCall of iteration.toolCalls) {
                if (toolCall.name === 'text') continue; // Skip final response tool

                const matchingResult = iteration.toolResults?.find(tr => tr.toolCall.id === toolCall.id);
                thoughts.push({
                    type: 'tool_call',
                    data: JSON.stringify({
                        id: toolCall.id,
                        name: toolCall.name,
                        args: toolCall.args,
                        result: matchingResult?.result,
                    }),
                });
            }

            return thoughts;
        });

        // Save to DB
        const turnId = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const userMessageToLog: ChatMessage = { by: 'user', message: userQuery, created: createdAt, turnId };
        const aiMessageToLog: ChatMessage = { by: 'assistant', message: finalResponse, created: createdAt, turnId, trainOfThought };

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

        console.log(`[WS] ✅ Research complete`);
        console.log(`[WS] Iterations: ${researchIterations.length}`);
        console.log(`[WS] Response length: ${finalResponse.length} chars`);
        console.log(`[WS] Conversation ID: ${conversation?.id}`);
        console.log(`${'='.repeat(60)}\n`);

        ws.send(JSON.stringify({
            type: 'complete',
            data: {
                response: finalResponse,
                conversationId: conversation?.id
            }
        }));
    },
    open(_ws: ServerWebSocket<WebSocketData>) {
        console.log("[WS] 🔌 Client connected");
    },
    close(_ws: ServerWebSocket<WebSocketData>) {
        console.log("[WS] 🔌 Client disconnected");
    }
};
