import type { ToolDefinition, ChatMessageModel } from "../conversation";
import type { ToolDefinition as LcToolDefinition } from '@langchain/core/language_models/base';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';

export function toOpenaiTools(tools?: ToolDefinition[]): LcToolDefinition[] {
    if (!tools) return [];
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.schema,
        }
    }));
}

/**
 * Format messages for OpenAI API by converting ToolMessages with image content
 * into proper user messages with multimodal content.
 *
 * OpenAI's API requires that:
 * 1. Tool results must be strings in ToolMessages
 * 2. Images must be sent as part of user messages with multimodal content
 *
 * This function converts ToolMessages containing multimodal content (images)
 * into HumanMessages with the proper structure for OpenAI's vision API.
 *
 * Supports both formats:
 * - Provider-agnostic: { type: 'image', source_type: 'base64', mime_type, data }
 * - OpenAI-native: { type: 'image_url', image_url: { url: 'data:...' } }
 */
export function formatMessagesForOpenAI(messages: ChatMessageModel[]): ChatMessageModel[] {
    const formatted: ChatMessageModel[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;

        // Handle ToolMessage with potential image content
        if (msg instanceof ToolMessage) {
            const content = msg.content;

            // Check if content is multimodal (array with image or image_url)
            if (Array.isArray(content)) {
                // Check for provider-agnostic format (type: 'image') or OpenAI format (type: 'image_url')
                const hasImage = content.some((item: any) =>
                    item.type === 'image' || item.type === 'image_url'
                );

                if (hasImage) {
                    console.log('[OpenAI Formatter] Converting ToolMessage with image to HumanMessage');

                    // Extract text description for the tool result acknowledgment
                    const textContent = content.find((item: any) => item.type === 'text');
                    const textDescription = textContent?.text || 'Image loaded successfully';

                    // Create a text-only ToolMessage for the tool result
                    formatted.push(new ToolMessage({
                        content: textDescription,
                        tool_call_id: msg.tool_call_id,
                        name: msg.name
                    }));

                    // Convert content to OpenAI format and add as HumanMessage
                    const openAIContent = content.map((item: any) => {
                        // Convert provider-agnostic image format to OpenAI format
                        if (item.type === 'image' && item.source_type === 'base64') {
                            return {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${item.mime_type};base64,${item.data}`
                                }
                            };
                        }
                        // Pass through text and already-OpenAI-formatted content
                        return item;
                    });

                    formatted.push(new HumanMessage({
                        content: openAIContent
                    }));

                    continue;
                }
            }
        }

        // For all other messages, pass through unchanged
        formatted.push(msg);
    }

    return formatted;
}
