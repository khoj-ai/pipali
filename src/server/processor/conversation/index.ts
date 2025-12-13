import { getDefaultChatModel } from '../../db';
import { type ChatMessage, ChatModel, User, type ChatModelWithApi } from '../../db/schema';
import { type ToolDefinition, type ChatMessageModel } from './conversation';
import { generateChatmlMessagesWithContext } from './utils';
import { sendMessageToGpt } from './openai';

export async function sendMessageToModel(
    // Context
    query: string,
    queryFiles?: string[],
    queryImages?: string[],
    context?: string,
    history?: ChatMessage[],
    systemMessage?: string,
    // Model Config
    tools?: ToolDefinition[],
    toolChoice: string = 'auto',
    deepThought: boolean = false,
    fastMode: boolean = false,
    agentChatModel?: typeof ChatModel.$inferSelect,
    user?: typeof User.$inferSelect,
) {
    console.log(`[Model] 📤 Resolving model... (user: ${user?.id || 'none'}, agent: ${agentChatModel?.name || 'none'})`);

    const chatModelWithApi: ChatModelWithApi | undefined = await getDefaultChatModel(user, agentChatModel);

    if (!chatModelWithApi) {
        console.error(`[Model] ❌ No chat model configured`);
        throw new Error('No chat model configured.');
    }

    console.log(`[Model] 🤖 Using: ${chatModelWithApi.chatModel.name} (${chatModelWithApi.chatModel.modelType})`);
    console.log(`[Model] Provider: ${chatModelWithApi.aiModelApi?.name || 'Unknown'}`);

    const messages: ChatMessageModel[] = generateChatmlMessagesWithContext(
        query,
        queryFiles,
        queryImages,
        context,
        history,
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
