import { ChatOpenAI } from '@langchain/openai';
import type { ChatMessage, ResponseWithThought, ToolDefinition } from '../conversation';
import { toOpenaiTools, formatMessagesForOpenAI, isOpenaiUrl, supportsResponsesApi } from './utils';

export async function sendMessageToGpt(
    messages: ChatMessage[],
    model: string,
    apiKey?: string,
    apiBaseUrl?: string | null,
    tools?: ToolDefinition[],
    toolChoice: string = 'auto',
): Promise<ResponseWithThought> {
    const formattedMessages = formatMessagesForOpenAI(messages);
    const lcTools = toOpenaiTools(tools);
    let modelKwargs: Record<string, any> = {};
    if (isOpenaiUrl(apiBaseUrl)) {
        modelKwargs['reasoning'] = { summary: "auto", effort: "high" };
        modelKwargs['include'] = ["reasoning.encrypted_content"];
    }
    const chat = new ChatOpenAI({
        apiKey: apiKey,
        model: model,
        useResponsesApi: supportsResponsesApi(apiBaseUrl),
        configuration: {
            baseURL: apiBaseUrl,
        },
    }).withConfig({
        tools: lcTools,
        tool_choice: lcTools ? toolChoice : undefined,
    });

    const response = await chat.invoke(formattedMessages, modelKwargs);
    const reasoning: any = response.additional_kwargs?.reasoning;
    const summary = typeof reasoning?.summary === "string"
        ? reasoning.summary
        : Array.isArray(reasoning?.summary)
            ? reasoning.summary.map((s: any) => s.text ?? "").join("")
            : undefined;

    return { thought: summary, message: response.text, raw: response.tool_calls };
}