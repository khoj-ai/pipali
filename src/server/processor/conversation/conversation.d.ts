import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

export type ChatMessageModel = HumanMessage | AIMessage | ToolMessage | SystemMessage;

export interface ResponseWithThought {
    message?: string;
    thought?: string;
    raw?: any[];
};

export interface ToolDefinition {
    schema: Record<string, any>;
    name: string;
    description?: string;
}