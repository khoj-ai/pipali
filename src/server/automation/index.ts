/**
 * Automation System
 *
 * Event-triggered tasks that run automatically based on
 * cron schedules or file system changes.
 */

import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'automation' });

export * from './types';

export {
    queueExecution,
    respondToConfirmation,
    getPendingConfirmations,
    cancelExecution,
    getRunningExecutionCount,
    getQueueLength,
    cleanupOrphanedExecutions,
} from './executor';

export {
    startSchedulers,
    stopSchedulers,
    scheduleCronJob,
    stopCronJob,
    reloadCronJob,
    setupFileWatcher,
    stopFileWatcher,
    reloadFileWatcher,
    getNextRunTime,
    isCronJobActive,
    isFileWatcherActive,
    getActiveCronJobCount,
    getActiveFileWatcherCount,
} from './scheduler';

/**
 * Start the automation system
 */
export async function startAutomationSystem(): Promise<void> {
    // Clean up any orphaned executions from previous server instance
    const { cleanupOrphanedExecutions } = await import('./executor');
    await cleanupOrphanedExecutions();

    // Start the schedulers
    const { startSchedulers } = await import('./scheduler');
    await startSchedulers();
    log.info('System started');
}

/**
 * Stop the automation system
 */
export async function stopAutomationSystem(): Promise<void> {
    const { stopSchedulers } = await import('./scheduler');
    await stopSchedulers();
    log.info('System stopped');
}

/**
 * Activate an automation (start its scheduler/watcher)
 * Note: Automations without triggers (manual-only) are valid but won't start any scheduler
 */
export async function activateAutomation(automation: {
    id: string;
    triggerType: 'cron' | 'file_watch' | null;
    triggerConfig: unknown;
    status: string;
    name: string;
}): Promise<void> {
    if (automation.status !== 'active') return;

    // Manual-only automations have no trigger to activate
    if (!automation.triggerType || !automation.triggerConfig) return;

    if (automation.triggerType === 'cron') {
        const { scheduleCronJob } = await import('./scheduler/cron');
        scheduleCronJob(automation as any);
    } else if (automation.triggerType === 'file_watch') {
        const { setupFileWatcher } = await import('./scheduler/file-watcher');
        await setupFileWatcher(automation as any);
    }
}

/**
 * Deactivate an automation (stop its scheduler/watcher and cancel any running execution)
 */
export async function deactivateAutomation(automationId: string): Promise<void> {
    const { stopCronJob } = await import('./scheduler/cron');
    const { stopFileWatcher } = await import('./scheduler/file-watcher');
    const { cancelExecution } = await import('./executor');

    stopCronJob(automationId);
    stopFileWatcher(automationId);
    cancelExecution(automationId);
}

/**
 * Reload an automation (for updates)
 */
export async function reloadAutomation(automationId: string): Promise<void> {
    const { reloadCronJob } = await import('./scheduler/cron');
    const { reloadFileWatcher } = await import('./scheduler/file-watcher');

    await Promise.all([
        reloadCronJob(automationId),
        reloadFileWatcher(automationId),
    ]);
}
