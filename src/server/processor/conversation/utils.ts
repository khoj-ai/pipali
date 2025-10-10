import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { type ChatMessage } from '../../db/schema';
import type { ChatMessageModel } from './conversation';

type ToolCall = {
    name: string;
    args: Record<string, any>;
    id?: string;
    type?: "tool_call";
};

export function generateChatmlMessagesWithContext(
    query: string,
    queryFiles?: string[],
    queryImages?: string[],
    context?: string,
    history?: ChatMessage[],
    systemMessage?: string,
    chatModel?: { name: string; visionEnabled: boolean },
    deepThought?: boolean,
    fastMode?: boolean,
): ChatMessageModel[] {
    const messages: ChatMessageModel[] = [];

    for (const msg of history || []) {
        if (msg.by === 'user') {
            if (typeof msg.message === 'string') {
                messages.push(new HumanMessage(msg.message as string));
            } else if (Array.isArray(msg.message) && msg.intent?.type === 'tool_result') {
                // Handle tool results
                msg.message
                .filter((item: any) => item.type === 'tool_result' && !!item.id)
                .forEach((item: any) => {
                    messages.push(new ToolMessage({
                        content: item.content,
                        tool_call_id: item.id,
                        name: item.name
                    }));
                });
            } else if (Array.isArray(msg.message)) {
                // If no intent, treat as normal message array
                messages.push(new HumanMessage({
                    content: msg.message
                }));
            }
        } else if (msg.by === 'assistant') {
            if (typeof msg.message === 'string') {
                messages.push(new AIMessage(msg.message as string));
            } else if (Array.isArray(msg.message) && msg.intent?.type === 'tool_call') {
                // Handle tool calls
                const toolCalls: ToolCall[] = msg.message
                .filter((tc: any) => tc.type === 'tool_call' && !!tc.id)
                .map((tc: any) => ({
                    name: tc.name,
                    args: tc.args,
                    id: tc.id,
                    type: 'tool_call' as const
                }));
                messages.push(new AIMessage({
                    content: '',
                    tool_calls: toolCalls
                }));
            } else if (Array.isArray(msg.message)) {
                // If no intent, treat as normal message array
                messages.push(new AIMessage({
                    content: msg.message
                }));
            }
        }
    }

    if (!!query) {
        messages.push(new HumanMessage(query));
    }
    return messages;
}