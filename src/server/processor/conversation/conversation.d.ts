import type { Responses } from 'openai/resources/responses/responses';

// OpenAI Responses API message types
export type ChatMessage = Responses.EasyInputMessage | Responses.ResponseInputItem;

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
    /** Compaction summary if context was compacted by platform */
    compactionSummary?: string;
}

export interface ToolDefinition {
    schema: Record<string, any>;
    name: string;
    description?: string;
    /** 'tool_search' emits a provider-native tool search tool; 'namespace' groups child tools */
    type?: 'function' | 'tool_search' | 'namespace';
    /** Defer this tool's schema out of model context until discovered via tool search */
    deferLoading?: boolean;
    /** Child tools of a namespace definition */
    tools?: ToolDefinition[];
}

/**
 * Live signals from the model's response stream, surfaced so the UI can show
 * progress before the response completes.
 */
export type LlmStreamEvent =
    /** Assistant prose */
    | { kind: 'text'; delta: string }
    /** Model's reasoning summary */
    | { kind: 'reasoning'; delta: string }
    /**
     * A tool call the model is emitting. Sent once when the call opens, then on
     * each argument chunk. `argChars` is cumulative, so a late event supersedes
     * every earlier one for the same call.
     */
    | { kind: 'tool_call'; callId: string; name: string; argChars: number };
