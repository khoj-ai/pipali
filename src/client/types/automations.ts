// Automation types for the frontend client

import type { ConfirmationRequest } from './confirmation';

export type TriggerType = 'cron' | 'file_watch';

export type CronTriggerConfig = {
    type: 'cron';
    schedule: string;
    timezone?: string;
};

export type FileWatchTriggerConfig = {
    type: 'file_watch';
    paths: string[];
    events: ('create' | 'modify' | 'delete')[];
    pattern?: string;
    debounceMs?: number;
};

export type TriggerConfig = CronTriggerConfig | FileWatchTriggerConfig;

export type AutomationStatus = 'active' | 'paused' | 'error';

export type AutomationInfo = {
    id: string;
    name: string;
    description?: string;
    prompt: string;
    triggerType?: TriggerType;
    triggerConfig?: TriggerConfig;
    status: AutomationStatus;
    conversationId?: string;
    maxIterations?: number;
    maxExecutionsPerDay?: number;
    maxExecutionsPerHour?: number;
    lastExecutedAt?: string;
    nextScheduledAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type AutomationsResponse = {
    automations: AutomationInfo[];
};

// Frequency types for the create modal
export type FrequencyType = 'hour' | 'day' | 'week' | 'month';

export type DayOfWeek = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export const DAYS_OF_WEEK: { value: DayOfWeek; label: string }[] = [
    { value: 'sunday', label: 'Sunday' },
    { value: 'monday', label: 'Monday' },
    { value: 'tuesday', label: 'Tuesday' },
    { value: 'wednesday', label: 'Wednesday' },
    { value: 'thursday', label: 'Thursday' },
    { value: 'friday', label: 'Friday' },
    { value: 'saturday', label: 'Saturday' },
];

export const TIME_OPTIONS = Array.from({ length: 24 }, (_, i) => {
    const hour = i % 12 || 12;
    const period = i < 12 ? 'AM' : 'PM';
    const minuteIntervals = ['00', '15', '30', '45'];
    return minuteIntervals.map(minute => ({
        value: `${i}:${minute}`,
        label: `${hour}:${minute} ${period}`
    }));
}).flat();

export const DAY_OF_MONTH_OPTIONS = Array.from({ length: 31 }, (_, i) => ({
    value: i + 1,
    label: `${i + 1}`,
}));

export const MINUTE_OPTIONS = Array.from({ length: 4 }, (_, i) => ({
    value: i*15,
    label: `:${(i*15).toString().padStart(2, '0')}`,
}));

// Pending confirmation from an automation execution (API response type)
export type AutomationPendingConfirmation = {
    id: string;
    executionId: string;
    automationId: string;
    automationName: string;
    request: ConfirmationRequest;
    expiresAt: string;
};
