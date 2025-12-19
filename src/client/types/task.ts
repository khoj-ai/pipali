// Active task type for home page display

export type ActiveTask = {
    conversationId: string;
    title: string;           // Latest user query
    reasoning?: string;      // Latest step/thought
    isPaused: boolean;
    stepCount?: number;      // Number of tool calls/steps taken
};
