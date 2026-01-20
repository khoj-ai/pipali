import { getDefaultChatModel } from '../../db';
import { User, type ChatModelWithApi } from '../../db/schema';
import { type ToolDefinition, type ChatMessage, type ResponseWithThought } from './conversation';
import { generateChatmlMessagesWithContext } from './utils';
import { sendMessageToGpt } from './openai';
import type { ATIFTrajectory } from './atif/atif.types';
import { withTokenRefresh, PlatformAuthError } from '../../http/platform-fetch';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'llm' });

// Test mock interface - set by E2E test preload scripts via globalThis
declare global {
    var __pipaliMockLLM: ((query: string) => ResponseWithThought) | undefined;
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
) {
    // Check for test mock (E2E tests inject this via preload)
    if (globalThis.__pipaliMockLLM) {
        const actualQuery = query || history?.steps?.findLast(s => s.source === 'user')?.message || '';
        log.debug({ query: actualQuery.substring(0, 50) }, 'Using mock LLM');
        return globalThis.__pipaliMockLLM(actualQuery);
    }

    const chatModelWithApi: ChatModelWithApi | undefined = await getDefaultChatModel(user);

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

    // Depending on the model type, you would call the appropriate function
    if (aiModelType === 'openai') {
        const startTime = Date.now();

        // For Pipali provider, use withTokenRefresh for automatic 401 retry
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

        // For non-Pipali providers, use the stored API key directly
        try {
            const response = await sendMessageToGpt(
                messages,
                chatModelWithApi.chatModel.name,
                chatModelWithApi.aiModelApi?.apiKey,
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
