// Active task type for home page display

export type TaskStatus = 'running' | 'needs_input' | 'completed' | 'stopped';

export type ActiveTask = {
    conversationId: string;
    title: string;           // Latest user query
    reasoning?: string;      // Latest step/thought
    status: TaskStatus;
    stepCount?: number;      // Number of tool calls/steps taken
};
