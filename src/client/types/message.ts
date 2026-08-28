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
    authInfo?: {
        code: 'session_expired';
        message: string;
    };
    runErrorInfo?: {
        message: string;
    };
    /** Paths of files attached by the user (extracted from <attached_files> block) */
    attachedFiles?: string[];
    /** ISO timestamp of when the message was recorded; for an agent message, when its run ended */
    createdAt?: string;
    /** ISO timestamp of when the run behind an agent message began */
    startedAt?: string;
    /** True for user messages waiting in the soft-interrupt queue (run_started not yet received). */
    isQueued?: boolean;
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
    /** True while this is a live preview from the model's stream, superseded once the step lands */
    isStreaming?: boolean;
    /** Characters of tool call arguments the model has written so far */
    argChars?: number;
    stepGroupId?: string; // Groups flattened thoughts/tool calls that came from the same trajectory step
};
