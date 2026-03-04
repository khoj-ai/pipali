// Active task type for home page display

import type { ToolCategory } from '../utils/formatting';

export type TaskStatus = 'running' | 'needs_input' | 'completed' | 'stopped' | 'pinned';

export type ActiveTask = {
    conversationId: string;
    title: string;           // Latest user query
    reasoning?: string;      // Latest step/thought
    status: TaskStatus;
    toolCategories?: Partial<Record<ToolCategory, number>>;
    isPinned?: boolean;
    onTogglePin?: () => void;
};
