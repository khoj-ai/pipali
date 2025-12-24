/**
 * Automation System Type Definitions
 *
 * Types for event-triggered tasks that run automatically based on
 * cron schedules or file system changes.
 */

/**
 * Base trigger configuration
 */
export interface BaseTriggerConfig {
    type: 'cron' | 'file_watch';
}

/**
 * Cron trigger configuration
 * Example: Run every Monday at 9am
 */
export interface CronTriggerConfig extends BaseTriggerConfig {
    type: 'cron';
    /** Cron expression (e.g., "0 9 * * 1" for Monday 9am) */
    schedule: string;
    /** Timezone (e.g., "America/New_York"). Defaults to UTC */
    timezone?: string;
}

/**
 * File watch trigger configuration
 * Example: Watch ~/Downloads for new bank statements
 */
export interface FileWatchTriggerConfig extends BaseTriggerConfig {
    type: 'file_watch';
    /** Paths to watch (supports ~ for home directory) */
    paths: string[];
    /** Events to trigger on */
    events: Array<'create' | 'modify' | 'delete'>;
    /** Optional file pattern filter (glob, e.g., "*.pdf") */
    pattern?: string;
    /** Debounce in milliseconds (prevents rapid firing). Default: 500 */
    debounceMs?: number;
}

export type TriggerConfig = CronTriggerConfig | FileWatchTriggerConfig;

/**
 * Event data passed when trigger fires
 */
export interface TriggerEventData {
    type: 'cron' | 'file_watch' | 'external';
    timestamp: string;
    /** Cron-specific: when the job was scheduled to run */
    scheduledTime?: string;
    /** File watch specific: details about the file event */
    file?: {
        path: string;
        event: 'create' | 'modify' | 'delete';
        size?: number;
    };
    /** External trigger: API call, script, or future webhook */
    external?: {
        source: 'api' | 'script' | 'webhook';
        metadata?: Record<string, unknown>;
    };
}

/**
 * Automation definition (for API responses)
 */
export interface AutomationDefinition {
    id: string;
    name: string;
    description?: string;
    prompt: string;
    triggerType?: 'cron' | 'file_watch';
    triggerConfig?: TriggerConfig;
    status: 'active' | 'paused' | 'disabled';
    maxIterations: number;
    maxExecutionsPerDay?: number;
    maxExecutionsPerHour?: number;
    lastExecutedAt?: string;
    nextScheduledAt?: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * Execution summary (for API responses)
 */
export interface ExecutionSummary {
    id: string;
    automationId: string;
    automationName: string;
    status: 'pending' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled';
    triggerData?: TriggerEventData;
    startedAt?: string;
    completedAt?: string;
    errorMessage?: string;
    retryCount: number;
}

/**
 * Pending confirmation status
 */
export type PendingConfirmationStatus = 'pending' | 'approved' | 'denied' | 'expired';
