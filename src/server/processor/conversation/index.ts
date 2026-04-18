import { getDefaultChatModel, getChatModelById } from '../../db';
import { User, type ChatModelWithApi } from '../../db/schema';
import { type ToolDefinition, type ChatMessage, type ResponseWithThought } from './conversation';
import { generateChatmlMessagesWithContext } from './utils';
import { sendMessageToGpt } from './openai';
import { sendMessageViaChatCompletions } from './openai/chat-completions';
import type { ATIFTrajectory } from './atif/atif.types';
import { withTokenRefresh, PlatformAuthError } from '../../http/platform-fetch';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'llm' });

// Test mock interface - set by E2E test preload scripts via globalThis
declare global {
    var __pipaliMockLLM:
        | ((query: string, ctx?: { sessionId?: string }) => ResponseWithThought)
        | undefined;
}

export async function sendMessageToModel(
    // Context
    query: string,
    history?: ATIFTrajectory,
    systemMessage?: string,
    // Model Config
    tools?: ToolDefinition[],
    toolChoice: string = 'auto',
    deepThought: boolean = false,
    fastMode: boolean = false,
    user?: typeof User.$inferSelect,
    chatModelId?: number,
) {
    // Check for test mock (E2E tests inject this via preload)
    if (globalThis.__pipaliMockLLM) {
        const actualQuery = query || history?.steps?.findLast(s => s.source === 'user')?.message || '';
        log.debug({ query: actualQuery.substring(0, 50) }, 'Using mock LLM');
        return globalThis.__pipaliMockLLM(actualQuery, { sessionId: history?.session_id });
    }

    // Resolve model: use conversation's chatModelId if provided, otherwise user's default
    let chatModelWithApi: ChatModelWithApi | undefined;
    if (chatModelId) {
        chatModelWithApi = await getChatModelById(chatModelId) ?? await getDefaultChatModel(user);
    } else {
        chatModelWithApi = await getDefaultChatModel(user);
    }

    if (!chatModelWithApi) {
        log.error('No chat model configured');
        throw new Error('No chat model configured.');
    }

    const modelName = chatModelWithApi.chatModel.friendlyName || chatModelWithApi.chatModel.name;
    const aiModelApiName = chatModelWithApi.aiModelApi?.name || 'Device';
    const aiModelType = chatModelWithApi.chatModel.modelType;
    log.info({ model: modelName, provider: aiModelApiName }, 'Using model');

    const messages: ChatMessage[] = generateChatmlMessagesWithContext(
        query,
        history?.steps,
        systemMessage,
        chatModelWithApi.chatModel,
        deepThought,
        fastMode,
    );

    log.debug({ messageCount: messages.length, toolCount: tools?.length || 0 }, 'Prepared messages');

    // Extract pricing from chat model for cost calculation
    const pricing = {
        inputCostPerMillion: chatModelWithApi.chatModel.inputCostPerMillion,
        outputCostPerMillion: chatModelWithApi.chatModel.outputCostPerMillion,
        cacheReadCostPerMillion: chatModelWithApi.chatModel.cacheReadCostPerMillion,
        cacheWriteCostPerMillion: chatModelWithApi.chatModel.cacheWriteCostPerMillion,
    };

    const startTime = Date.now();

    // Extract conversation ID from trajectory for platform tracing
    const conversationId = history?.session_id;

    // Pipali Platform exposes an OpenAI-compatible Responses API for all model types
    // (openai, anthropic, google), so route all platform models through sendMessageToGpt
    if (aiModelApiName === 'Pipali') {
        try {
            const response = await withTokenRefresh(async (token) => {
                return sendMessageToGpt(
                    messages,
                    chatModelWithApi.chatModel.name,
                    token,
                    chatModelWithApi.aiModelApi?.apiBaseUrl,
                    tools,
                    toolChoice,
                    pricing,
                    conversationId,
                );
            });
            log.info({ model: modelName, durationMs: Date.now() - startTime }, 'Response received');
            return response;
        } catch (error) {
            if (error instanceof PlatformAuthError) {
                log.error({ model: modelName, provider: aiModelApiName }, 'Platform authentication expired');
            }
            log.error({ err: error, model: modelName, provider: aiModelApiName }, 'LLM request failed');
            throw error;
        }
    }

    // For non-platform providers, route based on model type
    if (aiModelType === 'openai') {
        // Determine API path: Responses API (OpenAI direct) vs Chat Completions (Ollama, LM Studio, etc.)
        // The useResponsesApi flag on the ChatModel row controls this:
        //   - true  → OpenAI Responses API (client.responses.stream)
        //   - false → Chat Completions API (client.chat.completions.create)
        const useResponsesApi = chatModelWithApi.chatModel.useResponsesApi;
        const sendFn = useResponsesApi ? sendMessageToGpt : sendMessageViaChatCompletions;
        log.info({ model: modelName, provider: aiModelApiName, useResponsesApi }, 'Routing to API');

        try {
            const response = await sendFn(
                messages,
                chatModelWithApi.chatModel.name,
                chatModelWithApi.aiModelApi?.apiKey ?? undefined,
                chatModelWithApi.aiModelApi?.apiBaseUrl,
                tools,
                toolChoice,
                pricing,
            );
            log.info({ model: modelName, durationMs: Date.now() - startTime }, 'Response received');
            return response;
        } catch (error) {
            log.error({ err: error, model: modelName, provider: aiModelApiName }, 'LLM request failed');
            throw error;
        }
    }

    log.warn({ modelType: aiModelType }, 'Unsupported model type');
}
