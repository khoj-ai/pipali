// Minimal types for research director

import type { Responses } from 'openai/resources/responses/responses';
import type { ATIFMetrics, ATIFObservationResult, ATIFToolCall } from "../conversation/atif/atif.types";
import type { ConfirmationContext } from "../confirmation";

export interface ToolCall {
    name: string;
    args: Record<string, any>;
    id: string;
}

export interface ToolResult {
    toolCall: ATIFToolCall;
    result: string | Array<{ type: string; [key: string]: any }>;
}

export interface ResearchIteration {
    toolCalls: ATIFToolCall[];
    toolResults?: ATIFObservationResult[];
    warning?: string;
    thought?: string;
    message?: string;
    /** Token usage metrics from the LLM API call for this iteration */
    metrics?: ATIFMetrics;
    /** Raw LLM response. Store in trajectory for multi-turn passthrough */
    raw?: Responses.ResponseOutputItem[];
    /** Pending confirmation request that needs user response */
    pendingConfirmation?: {
        requestId: string;
        toolCallId: string;
    };
    /** True when yielding tool calls before execution (no results yet) */
    isToolCallStart?: boolean;
    /** System prompt used for this research session (only set on first iteration) */
    systemPrompt?: string;
}

/**
 * Accumulator for aggregating LLM usage metrics from tool executions
 */
export interface MetricsAccumulator {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    cost_usd: number;
}

/**
 * Context passed to tool execution for confirmation support
 */
export interface ToolExecutionContext {
    /** Confirmation context for requesting user approval */
    confirmation?: ConfirmationContext;
    /** Accumulator for LLM usage metrics from tool executions */
    metricsAccumulator?: MetricsAccumulator;
}
