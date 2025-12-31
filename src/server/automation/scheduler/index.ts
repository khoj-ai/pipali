/**
 * Scheduler Module
 *
 * Coordinates cron and file watch schedulers.
 */

export {
    startCronScheduler,
    scheduleCronJob,
    stopCronJob,
    stopAllCronJobs,
    getNextRunTime,
    isCronJobActive,
    getActiveCronJobCount,
    reloadCronJob,
} from './cron';

export {
    startFileWatchers,
    setupFileWatcher,
    stopFileWatcher,
    stopAllFileWatchers,
    isFileWatcherActive,
    getActiveFileWatcherCount,
    reloadFileWatcher,
} from './file-watcher';

/**
 * Start all schedulers
 */
export async function startSchedulers(): Promise<void> {
    const { startCronScheduler } = await import('./cron');
    const { startFileWatchers } = await import('./file-watcher');

    await Promise.all([
        startCronScheduler(),
        startFileWatchers(),
    ]);
}

/**
 * Stop all schedulers
 */
export async function stopSchedulers(): Promise<void> {
    const { stopAllCronJobs } = await import('./cron');
    const { stopAllFileWatchers } = await import('./file-watcher');

    stopAllCronJobs();
    stopAllFileWatchers();
}
