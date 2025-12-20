// Minimal types for research director

import type { ATIFObservationResult, ATIFToolCall } from "../conversation/atif/atif.types";
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
    /** Pending confirmation request that needs user response */
    pendingConfirmation?: {
        requestId: string;
        toolCallId: string;
    };
    /** True when yielding tool calls before execution (no results yet) */
    isToolCallStart?: boolean;
}

/**
 * Context passed to tool execution for confirmation support
 */
export interface ToolExecutionContext {
    /** Confirmation context for requesting user approval */
    confirmation?: ConfirmationContext;
}
