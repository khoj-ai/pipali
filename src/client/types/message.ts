// Message and Thought types for chat messages

export type Message = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    thoughts?: Thought[];
    isStreaming?: boolean;
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
