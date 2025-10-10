import { AIMessage, HumanMessage } from '@langchain/core/messages';

export type ChatMessageModel = HumanMessage | AIMessage;

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