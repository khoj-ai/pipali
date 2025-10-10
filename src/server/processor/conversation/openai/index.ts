import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { ResponseWithThought, ToolDefinition } from '../conversation';
import { toOpenaiTools } from './utils';

export async function sendMessageToGpt(
    messages: (HumanMessage | AIMessage)[],
    model: string,
    apiKey?: string,
    apiBaseUrl?: string | null,
    tools?: ToolDefinition[],
): Promise<ResponseWithThought> {
    const chat = new ChatOpenAI({
        apiKey: apiKey,
        model: model,
        configuration: {
            baseURL: apiBaseUrl,
        },
    }).withConfig({
        tools: toOpenaiTools(tools),
    });

    const response = await chat.invoke(messages);

    return { message: response.text };
}