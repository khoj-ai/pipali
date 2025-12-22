/**
 * Automation System
 *
 * Event-triggered tasks that run automatically based on
 * cron schedules or file system changes.
 */

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
    console.log('[Automation] System started');
}

/**
 * Stop the automation system
 */
export function stopAutomationSystem(): void {
    const { stopSchedulers } = require('./scheduler');
    stopSchedulers();
    console.log('[Automation] System stopped');
}

/**
 * Activate an automation (start its scheduler/watcher)
 */
export async function activateAutomation(automation: {
    id: string;
    triggerType: 'cron' | 'file_watch';
    triggerConfig: unknown;
    status: string;
    name: string;
}): Promise<void> {
    if (automation.status !== 'active') return;

    if (automation.triggerType === 'cron') {
        const { scheduleCronJob } = await import('./scheduler/cron');
        scheduleCronJob(automation as any);
    } else if (automation.triggerType === 'file_watch') {
        const { setupFileWatcher } = await import('./scheduler/file-watcher');
        await setupFileWatcher(automation as any);
    }
}

/**
 * Deactivate an automation (stop its scheduler/watcher)
 */
export function deactivateAutomation(automationId: string): void {
    const { stopCronJob } = require('./scheduler/cron');
    const { stopFileWatcher } = require('./scheduler/file-watcher');

    stopCronJob(automationId);
    stopFileWatcher(automationId);
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
