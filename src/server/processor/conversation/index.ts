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
    deepThought: boolean = false,
    fastMode: boolean = false,
    agentChatModel?: typeof ChatModel.$inferSelect,
    user?: typeof User.$inferSelect,
) {
    const chatModelWithApi: ChatModelWithApi | undefined = await getDefaultChatModel(user, agentChatModel);

    if (!chatModelWithApi) {
        throw new Error('No chat model configured.');
    }

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

    // Depending on the model type, you would call the appropriate function
    if (chatModelWithApi?.chatModel.modelType === 'openai') {
        return sendMessageToGpt(
            messages,
            chatModelWithApi.chatModel.name,
            chatModelWithApi.aiModelApi?.apiKey,
            chatModelWithApi.aiModelApi?.apiBaseUrl,
            tools,
        );
    }
}