/**
 * Cron Scheduler
 *
 * Manages cron-based automation triggers using the croner library.
 * Loads active cron automations from DB and schedules them.
 */

import { Cron } from 'croner';
import { db } from '../../db';
import { Automation } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { queueExecution } from '../executor';
import type { CronTriggerConfig, TriggerEventData } from '../types';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'automation' });

// Map of automation ID -> Cron job instance
const cronJobs = new Map<string, Cron>();

/**
 * Start the cron scheduler and load all active cron automations
 */
export async function startCronScheduler(): Promise<void> {
    // Load all active cron automations
    const automations = await db.select()
        .from(Automation)
        .where(
            and(
                eq(Automation.triggerType, 'cron'),
                eq(Automation.status, 'active')
            )
        );

    for (const automation of automations) {
        scheduleCronJob(automation);
    }

    log.info(`Scheduled ${automations.length} cron jobs`);
}

/**
 * Schedule a cron job for an automation
 */
export function scheduleCronJob(automation: typeof Automation.$inferSelect): void {
    const config = automation.triggerConfig as CronTriggerConfig;

    // Stop existing job if any
    stopCronJob(automation.id);

    try {
        // Create new cron job
        // Use system timezone by default (undefined lets croner use local time)
        const job = new Cron(config.schedule, {
            timezone: config.timezone,
        }, async () => {
            const triggerData: TriggerEventData = {
                type: 'cron',
                timestamp: new Date().toISOString(),
                scheduledTime: new Date().toISOString(),
            };

            await queueExecution(automation.id, triggerData);
        });

        cronJobs.set(automation.id, job);

        // Update next scheduled time in DB
        const nextRun = job.nextRun();
        if (nextRun) {
            db.update(Automation)
                .set({ nextScheduledAt: nextRun })
                .where(eq(Automation.id, automation.id))
                .execute()
                .catch(err => log.error({ err }, 'Failed to update next scheduled time'));
        }

        log.info(`Scheduled cron job for ${automation.name} (${config.schedule})`);
    } catch (error) {
        log.error({ err: error, name: automation.name }, 'Failed to schedule cron job');
    }
}

/**
 * Stop a cron job for an automation
 */
export function stopCronJob(automationId: string): void {
    const job = cronJobs.get(automationId);
    if (job) {
        job.stop();
        cronJobs.delete(automationId);
        log.info(`Stopped cron job for ${automationId}`);
    }
}

/**
 * Stop all cron jobs
 */
export function stopAllCronJobs(): void {
    for (const [id, job] of cronJobs) {
        job.stop();
    }
    cronJobs.clear();
    log.info(`Stopped all cron jobs`);
}

/**
 * Get the next scheduled run time for an automation
 */
export function getNextRunTime(automationId: string): Date | null {
    const job = cronJobs.get(automationId);
    if (job) {
        return job.nextRun();
    }
    return null;
}

/**
 * Check if a cron job is running for an automation
 */
export function isCronJobActive(automationId: string): boolean {
    return cronJobs.has(automationId);
}

/**
 * Get count of active cron jobs
 */
export function getActiveCronJobCount(): number {
    return cronJobs.size;
}

/**
 * Reload a single automation's cron job (for updates)
 */
export async function reloadCronJob(automationId: string): Promise<void> {
    const [automation] = await db.select()
        .from(Automation)
        .where(eq(Automation.id, automationId));

    if (!automation) {
        stopCronJob(automationId);
        return;
    }

    if (automation.triggerType !== 'cron' || automation.status !== 'active') {
        stopCronJob(automationId);
        return;
    }

    scheduleCronJob(automation);
}
