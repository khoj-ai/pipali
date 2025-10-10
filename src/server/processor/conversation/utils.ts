import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { type ChatMessage } from '../../db/schema';
import type { ChatMessageModel } from './conversation';

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
    let chatHistory: ChatMessageModel[] = [];
    if (!!history) {
        chatHistory = history?.map((msg) => {
            if (msg.by === 'user') {
                return new HumanMessage(msg.message);
            } else {
                return new AIMessage(msg.message);
            }
        });
    }

    const messages: ChatMessageModel[] = [...chatHistory, new HumanMessage(query)];
    return messages;
}