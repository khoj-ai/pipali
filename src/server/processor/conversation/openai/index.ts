import { ChatOpenAI } from '@langchain/openai';
import { AIMessageChunk } from '@langchain/core/messages';
import type { ChatMessage, ResponseWithThought, ToolDefinition, UsageMetrics } from '../conversation';
import { toOpenaiTools, formatMessagesForOpenAI } from './utils';
import { calculateCost, type PricingConfig } from '../costs';

export async function sendMessageToGpt(
    messages: ChatMessage[],
    model: string,
    apiKey?: string,
    apiBaseUrl?: string | null,
    tools?: ToolDefinition[],
    toolChoice: string = 'auto',
    pricing?: PricingConfig,
): Promise<ResponseWithThought> {
    const formattedMessages = formatMessagesForOpenAI(messages);
    const lcTools = toOpenaiTools(tools);

    // Use Responses API
    const chat = new ChatOpenAI({
        apiKey: apiKey,
        model: model,
        useResponsesApi: true,
        configuration: {
            baseURL: apiBaseUrl,
        },
        __includeRawResponse: true,
        streamUsage: true,
    }).withConfig({
        tools: lcTools,
        tool_choice: lcTools ? toolChoice : undefined,
    });

    // Use streaming to avoid timeout issues - accumulate chunks into final response
    const stream = await chat.stream(formattedMessages);
    let response: AIMessageChunk | undefined;
    for await (const chunk of stream) {
        response = response ? response.concat(chunk) : chunk;
    }

    if (!response) {
        throw new Error('No response received from model');
    }

    const reasoning: any = response.additional_kwargs?.reasoning;
    const summary = typeof reasoning?.summary === "string"
        ? reasoning.summary
        : Array.isArray(reasoning?.summary)
            ? reasoning.summary.map((s: any) => s.text ?? "").join("")
            : undefined;

    // Extract usage metrics from response metadata
    let usage: UsageMetrics | undefined;
    if (response.usage_metadata) {
        const usageData = response.usage_metadata;
        const promptTokens = usageData.input_tokens || 0;
        const completionTokens = usageData.output_tokens || 0;
        const promptDetails = usageData.input_token_details;
        const cachedReadTokens = promptDetails?.cache_read || 0;
        const cacheWriteTokens = promptDetails?.cache_creation || 0;

        // Use cost from platform if available, else fallback to estimate it locally
        const metadata: Record<string, any> = (response.additional_kwargs?.__raw_response as any)?.metadata;
        const rawCostUsd = metadata?.cost_usd ?? metadata?.["cost_usd"];
        const platformCostUsd = typeof rawCostUsd === 'number' ? rawCostUsd : (rawCostUsd ? parseFloat(rawCostUsd) : undefined);
        const costUsd = platformCostUsd || calculateCost(model, promptTokens, completionTokens, cachedReadTokens, cacheWriteTokens, 0, pricing);

        usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            cached_tokens: cachedReadTokens,
            cache_write_tokens: cacheWriteTokens,
            cost_usd: costUsd,
        };
        console.log(`[LLM] Usage: ${promptTokens} prompt, ${completionTokens} completion, ${cachedReadTokens} cache read, ${cacheWriteTokens} cache write, $${costUsd.toFixed(6)}`);
    }

    return { thought: summary, message: response.text, raw: response.tool_calls, usage };
}