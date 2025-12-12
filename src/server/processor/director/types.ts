// Minimal types for research director

export interface ToolCall {
    name: string;
    args: Record<string, any>;
    id: string | null;
}

export interface ResearchIteration {
    query: ToolCall | string | null;
    context?: any[];
    summarizedResult?: string;
    warning?: string;
    raw_response?: any[];
    thought?: string;
}
