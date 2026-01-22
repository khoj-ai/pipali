// Message and Thought types for chat messages

export type Message = {
    id: string;
    stableId: string; // Never changes, used as React key to prevent remounting
    role: 'user' | 'assistant';
    content: string;
    thoughts?: Thought[];
    isStreaming?: boolean;
    billingInfo?: {
        code: 'insufficient_credits' | 'spend_limit_reached';
        message: string;
    };
};

export type Thought = {
    id: string;
    type: 'thought' | 'tool_call' | 'tool_result';
    content: string;
    toolName?: string;
    toolArgs?: any;
    toolResult?: string;
    isInternalThought?: boolean; // True for model's internal reasoning (rendered in italics)
    isPending?: boolean; // True for tool calls that are currently executing (no results yet)
};
