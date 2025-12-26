import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { ChatMessage } from './conversation';
import type { ATIFStep, ATIFToolCall } from './atif/atif.types';

export function generateChatmlMessagesWithContext(
    query: string,
    history?: ATIFStep[],
    systemMessage?: string,
    chatModel?: { name: string; visionEnabled: boolean },
    deepThought?: boolean,
    fastMode?: boolean,
): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (systemMessage) {
        messages.push(new SystemMessage(systemMessage));
    }

    for (const msg of history || []) {
        if (msg.source === 'user') {
            messages.push(new HumanMessage(msg.message || ''));
        } else if (msg.source === 'agent') {
            messages.push(new AIMessage({
                content: msg.message || '',
                tool_calls: msg.tool_calls?.map((item: ATIFToolCall) => ({
                    args: item.arguments,
                    id: item.tool_call_id,
                    name: item.function_name
                } as ToolCall)),
                additional_kwargs: {
                    reasoning_content: msg.reasoning_content,
                }
            }));

            if (msg.observation?.results && msg.observation.results.length > 0) {
                // Each observation result becomes a separate ToolMessage
                for (const result of msg.observation.results) {
                    messages.push(new ToolMessage({
                        tool_call_id: result.source_call_id,
                        content: result.content,
                    }));
                }
            }
        }
    }

    if (!!query) {
        messages.push(new HumanMessage(query));
    }

    return messages;
}