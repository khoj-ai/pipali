import type { Responses } from 'openai/resources/responses/responses';
import type { ChatMessage } from './conversation';
import type { ATIFStep } from './atif/atif.types';

/**
 * Sanitize a raw output item for use as input.
 * Removes fields that are not accepted by the API (like parsed_arguments).
 */
function sanitizeOutputItemForInput(item: Responses.ResponseOutputItem): Responses.ResponseInputItem {
    if (item.type === 'function_call') {
        // Remove parsed_arguments which is not accepted by API
        const { parsed_arguments, ...rest } = item as any;
        return rest as Responses.ResponseInputItem;
    }
    return item as unknown as Responses.ResponseInputItem;
}

/**
 * Convert provider-agnostic image format to OpenAI's input_image format.
 */
function convertToOpenAIImageContent(content: any[]): Responses.ResponseInputMessageContentList {
    return content.map((item: any) => {
        if (item.type === 'image' && item.source_type === 'base64') {
            return {
                type: 'input_image' as const,
                image_url: `data:${item.mime_type};base64,${item.data}`
            };
        }
        if (item.type === 'text') {
            return {
                type: 'input_text' as const,
                text: item.text
            };
        }
        return item;
    }) as Responses.ResponseInputMessageContentList;
}

/**
 * Check if content array contains provider-agnostic images that need conversion.
 */
function hasProviderAgnosticImage(content: any[]): boolean {
    return content.some((item: any) => item.type === 'image' && item.source_type === 'base64');
}

/**
 * Find the index of the most recent compaction step in history.
 * Returns -1 if no compaction step found.
 *
 * Compaction steps are marked with extra.is_compaction = true and contain
 * a summary of the conversation history up to that point.
 */
function findMostRecentCompactionIndex(history: ATIFStep[]): number {
    for (let i = history.length - 1; i >= 0; i--) {
        const step = history[i]!;
        if (step.extra?.is_compaction === true) {
            return i;
        }
    }
    return -1;
}

export function generateChatmlMessagesWithContext(
    query: string,
    history?: ATIFStep[],
    systemMessage?: string,
    chatModel?: { name: string; visionEnabled: boolean },
    deepThought?: boolean,
    fastMode?: boolean,
): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let hasProcessedConversationStep = false;

    if (systemMessage) {
        messages.push({
            type: 'message',
            role: 'system',
            content: systemMessage,
        } as Responses.EasyInputMessage);
    }

    // Find the most recent compaction step and only process steps from that point onwards.
    // This avoids sending the full history when context has been compacted by the platform.
    // The compaction step itself is included as it contains the summary of earlier history.
    let stepsToProcess = history || [];
    if (history && history.length > 0) {
        const compactionIndex = findMostRecentCompactionIndex(history);
        if (compactionIndex >= 0) {
            stepsToProcess = history.slice(compactionIndex);
        }
    }

    for (const msg of stepsToProcess) {
        if (msg.source === 'system') {
            // Skip base system messages. They're injected via `systemMessage`, not inline in conversation history.
            if (!hasProcessedConversationStep) continue;
            messages.push({
                type: 'message',
                role: 'system',
                content: msg.message || '',
            } as Responses.EasyInputMessage);
        } else if (msg.source === 'user') {
            if (!hasProcessedConversationStep) hasProcessedConversationStep = true;
            messages.push({
                type: 'message',
                role: 'user',
                content: msg.message || '',
            } as Responses.EasyInputMessage);
        } else if (msg.source === 'agent') {
            if (!hasProcessedConversationStep) hasProcessedConversationStep = true;
            // Include raw output items from previous response for multi-turn passthrough
            const rawOutput = msg.extra?.raw_output as Responses.ResponseOutputItem[] | undefined;
            if (rawOutput && Array.isArray(rawOutput) && rawOutput.length > 0) {
                // Pass through raw output items (includes reasoning, messages, tool calls)
                // Sanitize to remove fields not accepted by API (like parsed_arguments)
                for (const item of rawOutput) {
                    messages.push(sanitizeOutputItemForInput(item));
                }
            } else {
                // Fallback: construct assistant message and tool calls manually
                if (msg.message) {
                    messages.push({
                        type: 'message',
                        role: 'assistant',
                        content: msg.message,
                    } as Responses.EasyInputMessage);
                }

                // Add tool calls if present (as function_call items)
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    for (const toolCall of msg.tool_calls) {
                        messages.push({
                            type: 'function_call',
                            call_id: toolCall.tool_call_id,
                            name: toolCall.function_name,
                            arguments: JSON.stringify(toolCall.arguments),
                        } as Responses.ResponseFunctionToolCall);
                    }
                }
            }

            // Add tool results as function_call_output items
            if (msg.observation?.results && msg.observation.results.length > 0) {
                for (const result of msg.observation.results) {
                    // Handle multimodal content (images from view_file, MCP tools, etc.)
                    if (Array.isArray(result.content) && hasProviderAgnosticImage(result.content)) {
                        // Add text-only function output for the tool result
                        messages.push({
                            type: 'function_call_output',
                            call_id: result.source_call_id,
                            output: convertToOpenAIImageContent(result.content),
                        } as Responses.ResponseInputItem.FunctionCallOutput);
                    } else {
                        // Standard text output
                        messages.push({
                            type: 'function_call_output',
                            call_id: result.source_call_id,
                            output: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
                        } as Responses.ResponseInputItem.FunctionCallOutput);
                    }
                }
            }
        }
    }

    if (!!query) {
        messages.push({
            type: 'message',
            role: 'user',
            content: query,
        } as Responses.EasyInputMessage);
    }

    return messages;
}
