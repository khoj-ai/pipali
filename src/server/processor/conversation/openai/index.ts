import { ChatOpenAI } from '@langchain/openai';
import type { ChatMessageModel, ResponseWithThought, ToolDefinition } from '../conversation';
import { toOpenaiTools } from './utils';

export async function sendMessageToGpt(
    messages: ChatMessageModel[],
    model: string,
    apiKey?: string,
    apiBaseUrl?: string | null,
    tools?: ToolDefinition[],
    toolChoice: string = 'auto',
): Promise<ResponseWithThought> {
    const lcTools = toOpenaiTools(tools);
    const chat = new ChatOpenAI({
        apiKey: apiKey,
        model: model,
        configuration: {
            baseURL: apiBaseUrl,
        },
    }).withConfig({
        tools: lcTools,
        tool_choice: toolChoice,
    });

    const response = await chat.invoke(messages);

    return { message: response.text, raw: response.tool_calls };
}