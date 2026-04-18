/**
 * Chat Completions API adapter for local/custom OpenAI-compatible providers.
 *
 * Pipali's internal message format uses the OpenAI Responses API types
 * (e.g., Responses.EasyInputMessage, ResponseFunctionToolCall). Local LLM
 * servers like Ollama only support the Chat Completions API
 * (POST /v1/chat/completions), which uses a different message schema.
 *
 * This module bridges the gap:
 *   1. Converts Responses-format messages → Chat Completions format
 *   2. Calls client.chat.completions.create() with streaming
 *   3. Maps the response back to Pipali's ResponseWithThought type
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletion } from 'openai/resources/chat/completions';
import type { ChatMessage, ResponseWithThought, ToolDefinition, UsageMetrics } from '../conversation';
import type { Responses } from 'openai/resources/responses/responses';
import { calculateCost, type PricingConfig } from '../costs';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'llm-completions' });

// ---------------------------------------------------------------------------
// Message Format Converters
// ---------------------------------------------------------------------------

/**
 * Convert Pipali's Responses-API-format messages to Chat Completions format.
 *
 * Responses API messages have a `type` discriminator field:
 *   - type: 'message' → { role, content }
 *   - type: 'function_call' → tool call from assistant
 *   - type: 'function_call_output' → tool result
 *
 * Chat Completions API messages use `role` only:
 *   - { role: 'system' | 'user' | 'assistant', content }
 *   - { role: 'assistant', tool_calls: [...] }
 *   - { role: 'tool', tool_call_id, content }
 */
export function convertToCompletionMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];

    // Collect consecutive function_call items to batch them into one assistant message
    let pendingToolCalls: Array<{ call_id: string; name: string; arguments: string }> = [];

    function flushToolCalls() {
        if (pendingToolCalls.length > 0) {
            result.push({
                role: 'assistant' as const,
                content: null,
                tool_calls: pendingToolCalls.map((tc, idx) => ({
                    id: tc.call_id,
                    type: 'function' as const,
                    function: {
                        name: tc.name,
                        arguments: tc.arguments,
                    },
                })),
            });
            pendingToolCalls = [];
        }
    }

    for (const msg of messages) {
        const msgAny = msg as any;
        const msgType = msgAny.type;

        if (msgType === 'message') {
            // Flush any pending tool calls before a new message
            flushToolCalls();

            const role = msgAny.role as string;
            const content = typeof msgAny.content === 'string'
                ? msgAny.content
                : Array.isArray(msgAny.content)
                    ? extractTextFromContent(msgAny.content)
                    : '';

            if (role === 'system') {
                result.push({ role: 'system' as const, content });
            } else if (role === 'user') {
                result.push({ role: 'user' as const, content });
            } else if (role === 'assistant') {
                result.push({ role: 'assistant' as const, content });
            }
        } else if (msgType === 'function_call') {
            // Batch consecutive function calls
            pendingToolCalls.push({
                call_id: msgAny.call_id || `call_${Date.now()}`,
                name: msgAny.name,
                arguments: msgAny.arguments || '{}',
            });
        } else if (msgType === 'function_call_output') {
            // Flush tool calls before adding tool results
            flushToolCalls();

            const output = typeof msgAny.output === 'string'
                ? msgAny.output
                : JSON.stringify(msgAny.output);

            result.push({
                role: 'tool' as const,
                tool_call_id: msgAny.call_id || '',
                content: output,
            });
        } else if (msgType === 'reasoning') {
            // Skip reasoning items — local models don't support them
            continue;
        } else {
            // Unknown type — try to extract as a simple message
            flushToolCalls();
            if (msgAny.role && msgAny.content) {
                result.push({
                    role: (msgAny.role === 'system' ? 'system' : msgAny.role === 'assistant' ? 'assistant' : 'user') as any,
                    content: typeof msgAny.content === 'string' ? msgAny.content : JSON.stringify(msgAny.content),
                });
            }
        }
    }

    // Flush any remaining tool calls
    flushToolCalls();

    return result;
}

/**
 * Extract plain text from multimodal content arrays.
 */
function extractTextFromContent(content: any[]): string {
    return content
        .filter((item: any) => item.type === 'input_text' || item.type === 'text')
        .map((item: any) => item.text)
        .join('\n');
}

// ---------------------------------------------------------------------------
// Tool Format Converter
// ---------------------------------------------------------------------------

/**
 * Convert Pipali's tool definitions to Chat Completions tool format.
 */
export function convertToCompletionTools(tools?: ToolDefinition[]): ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((tool) => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description ?? '',
            parameters: tool.schema,
        },
    }));
}

// ---------------------------------------------------------------------------
// Response Mapper
// ---------------------------------------------------------------------------

/**
 * Map a Chat Completions response back to Pipali's ResponseWithThought type.
 *
 * This bridges the gap between:
 *   - ChatCompletion.choices[0].message  (Completions format)
 *   - ResponseWithThought { message, thought, raw, usage }  (Pipali format)
 */
function mapCompletionToResponse(
    response: ChatCompletion,
    pricing?: PricingConfig,
    modelName?: string,
): ResponseWithThought {
    const choice = response.choices[0];
    if (!choice) {
        throw new Error('No choices returned from model');
    }

    const assistantMessage = choice.message;

    // Extract text content
    const message = assistantMessage.content?.trim() || undefined;

    // No reasoning/thought from local models
    const thought = undefined;

    // Build raw output items in Responses API format for trajectory storage.
    // This allows multi-turn passthrough to work seamlessly even for local models.
    const raw: Responses.ResponseOutputItem[] = [];

    // Add message as a ResponseOutputMessage
    if (message) {
        raw.push({
            type: 'message',
            id: `msg_${Date.now()}`,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: message, annotations: [] }],
        } as Responses.ResponseOutputMessage);
    }

    // Add tool calls as ResponseFunctionToolCall items
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        for (const tc of assistantMessage.tool_calls) {
            // Cast to access function property — standard function tool calls always have it
            const funcCall = tc as { id: string; type: string; function: { name: string; arguments: string } };
            raw.push({
                type: 'function_call',
                id: funcCall.id || `call_${Date.now()}`,
                call_id: funcCall.id || `call_${Date.now()}`,
                name: funcCall.function.name,
                arguments: funcCall.function.arguments,
                status: 'completed',
            } as unknown as Responses.ResponseFunctionToolCall);
        }
    }

    // Calculate usage metrics
    let usage: UsageMetrics | undefined;
    if (response.usage) {
        const promptTokens = response.usage.prompt_tokens || 0;
        const completionTokens = response.usage.completion_tokens || 0;

        // Local models are free — cost is $0
        const costUsd = calculateCost(
            modelName || response.model || 'local',
            promptTokens,
            completionTokens,
            0, 0, 0,
            pricing,
        );

        usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            cached_tokens: 0,
            cache_write_tokens: 0,
            cost_usd: costUsd,
        };
        log.info(`Usage: ${promptTokens} prompt, ${completionTokens} completion, $${costUsd.toFixed(6)}`);
    }

    return { thought, message, raw, usage };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Send a message to a local/custom OpenAI-compatible model via Chat Completions API.
 *
 * This is the counterpart to `sendMessageToGpt` (which uses the Responses API).
 * It handles LLM servers like Ollama, LM Studio, vLLM, llama.cpp, and any provider
 * that exposes a /v1/chat/completions endpoint.
 */
export async function sendMessageViaChatCompletions(
    messages: ChatMessage[],
    model: string,
    apiKey?: string,
    apiBaseUrl?: string | null,
    tools?: ToolDefinition[],
    toolChoice: string = 'auto',
    pricing?: PricingConfig,
    _conversationId?: string,
): Promise<ResponseWithThought> {
    // Convert Responses-format messages to Chat Completions format
    const completionMessages = convertToCompletionMessages(messages);
    const completionTools = convertToCompletionTools(tools);

    log.debug({
        messageCount: completionMessages.length,
        toolCount: completionTools?.length || 0,
        model,
        baseUrl: apiBaseUrl,
    }, 'Sending to Chat Completions API');

    const client = new OpenAI({
        apiKey: apiKey || 'ollama', // Ollama accepts any value; avoid SDK validation error
        baseURL: apiBaseUrl ?? undefined,
    });

    try {
        const response = await client.chat.completions.create({
            model: model,
            messages: completionMessages,
            ...(completionTools && {
                tools: completionTools,
                tool_choice: toolChoice as any,
            }),
        });

        return mapCompletionToResponse(response, pricing, model);
    } catch (error: any) {
        // Provide helpful error messages for common local model issues
        if (error?.code === 'ECONNREFUSED') {
            throw new Error(
                `Could not connect to local model server at ${apiBaseUrl}. ` +
                `Make sure Ollama or your LLM server is running.`
            );
        }
        if (error?.status === 404) {
            throw new Error(
                `Model "${model}" not found on the server at ${apiBaseUrl}. ` +
                `Make sure the model is pulled/downloaded (e.g., "ollama pull ${model}").`
            );
        }
        throw error;
    }
}
