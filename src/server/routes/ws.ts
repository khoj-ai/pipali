import type { ServerWebSocket } from "bun";
import { research } from "../processor/director";
import { db, getDefaultChatModel } from "../db";
import { Conversation, User, type ChatMessage } from "../db/schema";
import { eq } from "drizzle-orm";
import { getDefaultUser } from "../utils";
import type { ResearchIteration } from "../processor/director/types";
import { atifConversationService } from "../processor/conversation/atif/atif.service";
import { type ATIFToolCall, type ATIFObservationResult } from "../processor/conversation/atif/atif.types";
import { convertATIFToChatMessages } from "../processor/conversation/atif/atif.utils";

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
            ws.send(JSON.stringify({ type: 'error', error: 'Failed to create or find conversation' }));
            return;
        }

        // Add user message to conversation immediately
        await atifConversationService.addStep(
            conversation.id,
            'user',
            userQuery
        );

        // Run research and add steps as they happen
        console.log(`[WS] 🔬 Starting research...`);
        let finalResponse = '';
        let iterationCount = 0;

        try {
            for await (const iteration of research({
                query: userQuery,
                chatHistory: history,
                maxIterations: 15,
                currentDate: new Date().toISOString().split('T')[0],
                dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
                user: user,
            })) {
                iterationCount++;

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
                    // Don't add the text tool as a step, we'll add it as the final response
                // Add the entire iteration as a single step in the trajectory
                } else if (iteration.toolCalls.length > 0 && iteration.toolResults) {
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

                    // Send iteration update to client
                    ws.send(JSON.stringify({ type: 'iteration', data: iteration }));
                } else {
                    console.warn(`[WS] ⚠️ No tool calls or results in iteration`);
                }
            }
        } catch (error) {
             console.error(`[WS] ❌ Research error:`, error);
             ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
             return;
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

        console.log(`[WS] ✅ Research complete`);
        console.log(`[WS] Iterations: ${iterationCount}`);
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
