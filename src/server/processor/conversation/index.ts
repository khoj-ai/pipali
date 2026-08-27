import { getDefaultChatModel, getChatModelById } from '../../db';
import { User, type ChatModelWithApi } from '../../db/schema';
import { type ToolDefinition, type ChatMessage, type LlmStreamEvent, type ResponseWithThought } from './conversation';
import { generateChatmlMessagesWithContext } from './utils';
import { sendMessageToGpt } from './openai';
import type { ATIFTrajectory } from './atif/atif.types';
import { withTokenRefresh, PlatformAuthError } from '../../http/platform-fetch';
import { isAuthenticated, getPlatformUrl } from '../../auth';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'llm' });

// Test mock interface - set by E2E test preload scripts via globalThis.
// `history` lets a scenario react to earlier tool results, e.g. feeding an id returned
// by one tool call into the next. `messages` is the request as a provider would receive
// it, so a scenario can stand in for provider-side validation of it.
declare global {
    var __pipaliMockLLM:
        | ((query: string, ctx?: {
            conversationId?: string;
            sessionId?: string;
            runId?: string;
            history?: ATIFTrajectory;
            messages?: ChatMessage[];
        }) => ResponseWithThought | Promise<ResponseWithThought>)
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
    conversationId?: string,
    runId?: string,
    onStreamEvent?: (event: LlmStreamEvent) => void,
    chatModelAlias?: string,
) {
    // Check for test mock (E2E tests inject this via preload)
    if (globalThis.__pipaliMockLLM) {
        const actualQuery = query || history?.steps?.findLast(s => s.source === 'user')?.message || '';
        log.debug({ query: actualQuery.substring(0, 50) }, 'Using mock LLM');
        return globalThis.__pipaliMockLLM(actualQuery, {
            conversationId,
            sessionId: history?.session_id,
            runId,
            history,
            messages: generateChatmlMessagesWithContext(query, history?.steps, systemMessage),
        });
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

    const requestedModelName = chatModelAlias ?? chatModelWithApi.chatModel.name;
    const modelName = chatModelAlias ?? chatModelWithApi.chatModel.friendlyName ?? chatModelWithApi.chatModel.name;
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

    // Pipali Platform exposes an OpenAI-compatible Responses API for all model types
    // (openai, anthropic, google), so route all platform models through sendMessageToGpt
    if (aiModelApiName === 'Pipali') {
        try {
            const response = await withTokenRefresh(async (token) => {
                return sendMessageToGpt(
                    messages,
                    requestedModelName,
                    token,
                    chatModelWithApi.aiModelApi?.apiBaseUrl,
                    tools,
                    toolChoice,
                    pricing,
                    conversationId,
                    runId,
                    onStreamEvent,
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
        try {
            const response = await sendMessageToGpt(
                messages,
                chatModelWithApi.chatModel.name,
                chatModelWithApi.aiModelApi?.apiKey,
                chatModelWithApi.aiModelApi?.apiBaseUrl,
                tools,
                toolChoice,
                pricing,
                conversationId,
                runId,
                onStreamEvent,
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

/**
 * Logical platform model: 'pipali:fast' is not a chat_models row — the
 * platform's /responses endpoint resolves it to the operator's configured
 * fast model (else the platform default). Kept row-less on purpose: a row
 * would need fake pricing, sync special-casing, and selector filtering.
 */
export const PLATFORM_FAST_MODEL = 'pipali:fast';

export type PlatformModelTier = 'flagship' | 'balanced' | 'lite';

/** Model tier aliases resolved by the platform. */
export const PLATFORM_TIER_MODELS = {
    flagship: 'pipali:flagship',
    balanced: 'pipali:balanced',
    lite: 'pipali:lite',
} as const satisfies Record<PlatformModelTier, string>;

/**
 * One-shot utility call to the fastest model available: the platform's fast
 * model when signed in, else whichever model the user configured in the app.
 * For small internal jobs — spoken summaries, chat titles, etc.
 */
export async function sendMessageToFastModel(
    query: string,
    systemMessage?: string,
): Promise<ResponseWithThought | undefined> {
    if (globalThis.__pipaliMockLLM) {
        return globalThis.__pipaliMockLLM(query);
    }

    if (await isAuthenticated()) {
        const messages: ChatMessage[] = [
            ...(systemMessage ? [{ role: 'system', content: systemMessage } satisfies ChatMessage] : []),
            { role: 'user', content: query },
        ];
        return withTokenRefresh((token) =>
            sendMessageToGpt(messages, PLATFORM_FAST_MODEL, token, `${getPlatformUrl()}/openai/v1`));
    }

    return sendMessageToModel(query, undefined, systemMessage);
}
