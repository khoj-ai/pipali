import { getDefaultChatModel } from '../../db';
import { User, type ChatModelWithApi } from '../../db/schema';
import { type ToolDefinition, type ChatMessage } from './conversation';
import { generateChatmlMessagesWithContext } from './utils';
import { sendMessageToGpt } from './openai';
import type { ATIFTrajectory } from './atif/atif.types';

// Test mock interface - set by E2E test preload scripts via globalThis
declare global {
    var __paniniMockLLM: ((query: string) => {
        message?: string;
        raw: Array<{ name: string; args: Record<string, unknown>; id: string }>;
        thought?: string;
    }) | undefined;
}

export async function sendMessageToModel(
    // Context
    query: string,
    queryFiles?: string[],
    queryImages?: string[],
    context?: string,
    history?: ATIFTrajectory,
    systemMessage?: string,
    // Model Config
    tools?: ToolDefinition[],
    toolChoice: string = 'auto',
    deepThought: boolean = false,
    fastMode: boolean = false,
    user?: typeof User.$inferSelect,
) {
    // Check for test mock (E2E tests inject this via preload)
    if (globalThis.__paniniMockLLM) {
        const actualQuery = query || history?.steps?.findLast(s => s.source === 'user')?.message || '';
        console.log(`[Model] 🧪 Using mock for: "${actualQuery.substring(0, 50)}..."`);
        return globalThis.__paniniMockLLM(actualQuery);
    }

    const chatModelWithApi: ChatModelWithApi | undefined = await getDefaultChatModel(user);

    if (!chatModelWithApi) {
        console.error(`[Model] ❌ No chat model configured`);
        throw new Error('No chat model configured.');
    }

    console.log(`[Model] 🤖 Using: ${chatModelWithApi.chatModel.name} (${chatModelWithApi.chatModel.modelType})`);
    console.log(`[Model] Provider: ${chatModelWithApi.aiModelApi?.name || 'Unknown'}`);

    const messages: ChatMessage[] = generateChatmlMessagesWithContext(
        query,
        queryFiles,
        queryImages,
        context,
        history?.steps,
        systemMessage,
        chatModelWithApi.chatModel,
        deepThought,
        fastMode,
    );

    console.log(`[Model] Messages: ${messages.length}, Tools: ${tools?.length || 0}`);

    // Depending on the model type, you would call the appropriate function
    if (chatModelWithApi?.chatModel.modelType === 'openai') {
        const startTime = Date.now();
        const response = await sendMessageToGpt(
            messages,
            chatModelWithApi.chatModel.name,
            chatModelWithApi.aiModelApi?.apiKey,
            chatModelWithApi.aiModelApi?.apiBaseUrl,
            tools,
            toolChoice,
        );
        console.log(`[Model] ⏱️ Response received in ${(Date.now() - startTime) / 1000.0}ms`);
        return response;
    }

    console.warn(`[Model] ⚠️ Unsupported model type: ${chatModelWithApi.chatModel.modelType}`);
}
