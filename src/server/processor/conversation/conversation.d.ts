import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { Responses } from 'openai/resources/responses/responses';

export type ChatMessage = HumanMessage | AIMessage | ToolMessage | SystemMessage;

/**
 * Token usage metrics from an LLM API call
 */
export interface UsageMetrics {
    /** Number of prompt/input tokens */
    prompt_tokens: number;
    /** Number of completion/output tokens */
    completion_tokens: number;
    /** Number of cached read tokens */
    cached_tokens?: number;
    /** Number of cache write tokens */
    cache_write_tokens?: number;
    /** Cost in USD for this call */
    cost_usd: number;
}

export interface ResponseWithThought {
    message?: string;
    thought?: string;
    /** Raw LLM response. Store in trajectory for multi-turn passthrough */
    raw?: Responses.ResponseOutputItem[];
    /** Token usage metrics from the API call */
    usage?: UsageMetrics;
};

export interface ToolDefinition {
    schema: Record<string, any>;
    name: string;
    description?: string;
}