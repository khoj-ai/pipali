/**
 * File Watcher
 *
 * Watches file system for changes and triggers automations.
 * Uses Node.js fs.watch with recursive option.
 */

import { watch, type FSWatcher, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db } from '../../db';
import { Automation } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { queueExecution } from '../executor';
import type { FileWatchTriggerConfig, TriggerEventData } from '../types';
import { minimatch } from 'minimatch';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'automation' });

// Map of automation ID -> watcher instances
const fileWatchers = new Map<string, FSWatcher[]>();

// Debounce timers per automation per file
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Start file watchers for all active file_watch automations
 */
export async function startFileWatchers(): Promise<void> {
    const automations = await db.select()
        .from(Automation)
        .where(
            and(
                eq(Automation.triggerType, 'file_watch'),
                eq(Automation.status, 'active')
            )
        );

    for (const automation of automations) {
        await setupFileWatcher(automation);
    }

    log.info(`Started ${automations.length} file watchers`);
}

/**
 * Expand a path, handling ~ for home directory
 */
function expandPath(p: string): string {
    if (p.startsWith('~')) {
        return path.join(os.homedir(), p.slice(1));
    }
    return path.resolve(p);
}

/**
 * Check if a path exists and is a directory
 */
function isDirectory(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Set up file watcher for an automation
 */
export async function setupFileWatcher(automation: typeof Automation.$inferSelect): Promise<void> {
    const config = automation.triggerConfig as FileWatchTriggerConfig;

    // Stop existing watchers
    stopFileWatcher(automation.id);

    const watchers: FSWatcher[] = [];

    for (const watchPath of config.paths) {
        const expandedPath = expandPath(watchPath);

        // Check if path exists
        if (!isDirectory(expandedPath)) {
            log.warn(`Watch path does not exist or is not a directory: ${expandedPath}`);
            continue;
        }

        try {
            const watcher = watch(expandedPath, { recursive: true }, (eventType, filename) => {
                if (!filename) return;

                const fullPath = path.join(expandedPath, filename);

                // Check if matches pattern filter
                if (config.pattern && !matchesPattern(filename, config.pattern)) {
                    return;
                }

                // Map fs event to our event types
                // 'rename' can mean create or delete, 'change' means modify
                let event: 'create' | 'modify' | 'delete';
                try {
                    // Check if file exists to determine if it was created or deleted
                    statSync(fullPath);
                    event = eventType === 'rename' ? 'create' : 'modify';
                } catch {
                    event = 'delete';
                }

                // Check if we're interested in this event
                if (!config.events.includes(event)) {
                    return;
                }

                // Debounce the event
                handleFileEvent(
                    automation.id,
                    fullPath,
                    event,
                    config.debounceMs ?? 500
                );
            });

            watcher.on('error', (error) => {
                log.error({ err: error, path: expandedPath }, 'Watcher error');
            });

            watchers.push(watcher);
            log.info(`Watching: ${expandedPath} for ${automation.name}`);
        } catch (error) {
            log.error({ err: error, path: expandedPath }, 'Failed to watch path');
        }
    }

    if (watchers.length > 0) {
        fileWatchers.set(automation.id, watchers);
    }
}

/**
 * Check if a filename matches a glob pattern
 */
function matchesPattern(filename: string, pattern: string): boolean {
    return minimatch(filename, pattern, { matchBase: true });
}

/**
 * Handle a file event with debouncing
 */
function handleFileEvent(
    automationId: string,
    filePath: string,
    event: 'create' | 'modify' | 'delete',
    debounceMs: number
): void {
    const timerKey = `${automationId}:${filePath}`;

    // Clear existing debounce timer
    const existingTimer = debounceTimers.get(timerKey);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const timer = setTimeout(async () => {
        debounceTimers.delete(timerKey);

        // Get file size if it exists
        let size: number | undefined;
        try {
            const stats = statSync(filePath);
            size = stats.size;
        } catch {
            // File may have been deleted
        }

        const triggerData: TriggerEventData = {
            type: 'file_watch',
            timestamp: new Date().toISOString(),
            file: {
                path: filePath,
                event,
                size,
            },
        };

        log.info(`File event: ${event} ${filePath}`);
        await queueExecution(automationId, triggerData);
    }, debounceMs);

    debounceTimers.set(timerKey, timer);
}

/**
 * Stop file watcher for an automation
 */
export function stopFileWatcher(automationId: string): void {
    const watchers = fileWatchers.get(automationId);
    if (watchers) {
        for (const watcher of watchers) {
            watcher.close();
        }
        fileWatchers.delete(automationId);
        log.info(`Stopped file watcher for ${automationId}`);
    }

    // Clear any pending debounce timers for this automation
    for (const [key, timer] of debounceTimers) {
        if (key.startsWith(`${automationId}:`)) {
            clearTimeout(timer);
            debounceTimers.delete(key);
        }
    }
}

/**
 * Stop all file watchers
 */
export function stopAllFileWatchers(): void {
    for (const [id] of fileWatchers) {
        stopFileWatcher(id);
    }
    log.info(`Stopped all file watchers`);
}

/**
 * Check if a file watcher is active for an automation
 */
export function isFileWatcherActive(automationId: string): boolean {
    return fileWatchers.has(automationId);
}

/**
 * Get count of active file watchers
 */
export function getActiveFileWatcherCount(): number {
    return fileWatchers.size;
}

/**
 * Reload a single automation's file watcher (for updates)
 */
export async function reloadFileWatcher(automationId: string): Promise<void> {
    const [automation] = await db.select()
        .from(Automation)
        .where(eq(Automation.id, automationId));

    if (!automation) {
        stopFileWatcher(automationId);
        return;
    }

    if (automation.triggerType !== 'file_watch' || automation.status !== 'active') {
        stopFileWatcher(automationId);
        return;
    }

    await setupFileWatcher(automation);
}
