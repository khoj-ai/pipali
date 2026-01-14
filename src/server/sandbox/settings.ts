/**
 * Database operations for sandbox settings.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { SandboxSettings } from '../db/schema';
import { type SandboxConfig, getDefaultConfig } from './config';

/**
 * Load sandbox settings for a user from the database.
 * Returns default config if no settings exist.
 */
export async function loadSandboxSettings(userId: number): Promise<SandboxConfig> {
    const rows = await db
        .select()
        .from(SandboxSettings)
        .where(eq(SandboxSettings.userId, userId))
        .limit(1);

    const settings = rows[0];
    if (!settings) {
        return getDefaultConfig();
    }

    return {
        enabled: settings.enabled,
        allowedWritePaths: settings.allowedWritePaths,
        deniedWritePaths: settings.deniedWritePaths,
        deniedReadPaths: settings.deniedReadPaths,
        allowedDomains: settings.allowedDomains,
        allowLocalBinding: settings.allowLocalBinding,
    };
}

/**
 * Save sandbox settings for a user to the database.
 * Creates new record if none exists, otherwise updates existing.
 */
export async function saveSandboxSettings(
    userId: number,
    config: Partial<SandboxConfig>
): Promise<void> {
    const existing = await db
        .select({ id: SandboxSettings.id })
        .from(SandboxSettings)
        .where(eq(SandboxSettings.userId, userId))
        .limit(1);

    const now = new Date();

    if (existing.length === 0) {
        // Insert new record with defaults merged with provided config
        const defaults = getDefaultConfig();
        await db.insert(SandboxSettings).values({
            userId,
            enabled: config.enabled ?? defaults.enabled,
            allowedWritePaths: config.allowedWritePaths ?? defaults.allowedWritePaths,
            deniedWritePaths: config.deniedWritePaths ?? defaults.deniedWritePaths,
            deniedReadPaths: config.deniedReadPaths ?? defaults.deniedReadPaths,
            allowedDomains: config.allowedDomains ?? defaults.allowedDomains,
            allowLocalBinding: config.allowLocalBinding ?? defaults.allowLocalBinding,
            createdAt: now,
            updatedAt: now,
        });
    } else {
        // Update existing record
        await db
            .update(SandboxSettings)
            .set({
                ...config,
                updatedAt: now,
            })
            .where(eq(SandboxSettings.userId, userId));
    }
}

/**
 * Ensure sandbox settings exist for a user, creating defaults if needed.
 * Returns the settings (existing or newly created).
 */
export async function ensureSandboxSettings(userId: number): Promise<SandboxConfig> {
    const existing = await loadSandboxSettings(userId);

    // Check if we actually have a record in the database
    const rows = await db
        .select({ id: SandboxSettings.id })
        .from(SandboxSettings)
        .where(eq(SandboxSettings.userId, userId))
        .limit(1);

    if (rows.length === 0) {
        // Create default settings
        await saveSandboxSettings(userId, existing);
    }

    return existing;
}
