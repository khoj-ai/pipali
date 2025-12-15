// Minimal types for research director

export interface ToolCall {
    name: string;
    args: Record<string, any>;
    id: string;
}

export interface ToolResult {
    toolCall: ToolCall;
    result: string | Array<{ type: string; [key: string]: any }>;
}

export interface ResearchIteration {
    toolCalls: ToolCall[];
    toolResults?: ToolResult[];
    warning?: string;
    thought?: string;
}
