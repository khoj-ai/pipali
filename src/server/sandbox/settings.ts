/**
 * Database operations for sandbox settings.
 *
 * The DB only stores user-added paths/domains, not defaults.
 * Defaults are merged at load time from config.ts, so code updates
 * to defaults take effect immediately without DB migrations.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { SandboxSettings } from '../db/schema';
import { type SandboxConfig, getDefaultConfig } from './config';

/** Remove default entries from a list, returning only user-added items. */
function stripDefaults(paths: string[], defaults: string[]): string[] {
    const defaultSet = new Set(defaults);
    return paths.filter(p => !defaultSet.has(p));
}

/** Merge user-added items with current defaults (defaults first, then user additions). */
function mergeWithDefaults(userPaths: string[], defaults: string[]): string[] {
    return [...defaults, ...userPaths.filter(p => !defaults.includes(p))];
}

/**
 * Strip all default paths/domains from a config, returning only user-added values.
 * Used before writing to DB so we never persist defaults.
 */
function toUserOnly(config: Partial<SandboxConfig>): Partial<SandboxConfig> {
    const defaults = getDefaultConfig();
    const result: Partial<SandboxConfig> = { ...config };
    if (result.allowedWritePaths) {
        result.allowedWritePaths = stripDefaults(result.allowedWritePaths, defaults.allowedWritePaths);
    }
    if (result.deniedWritePaths) {
        result.deniedWritePaths = stripDefaults(result.deniedWritePaths, defaults.deniedWritePaths);
    }
    if (result.deniedReadPaths) {
        result.deniedReadPaths = stripDefaults(result.deniedReadPaths, defaults.deniedReadPaths);
    }
    if (result.allowedDomains) {
        result.allowedDomains = stripDefaults(result.allowedDomains, defaults.allowedDomains);
    }
    return result;
}

/**
 * The settings that applying this update would produce.
 *
 * Saving strips defaults and loading merges them back, so a list the update sets lands as
 * the defaults plus whatever else it names, and a field it leaves out does not move.
 */
export function previewSandboxSettings(
    current: SandboxConfig,
    update: Partial<SandboxConfig>
): SandboxConfig {
    const defaults = getDefaultConfig();
    return {
        enabled: update.enabled ?? current.enabled,
        allowedWritePaths: update.allowedWritePaths
            ? mergeWithDefaults(update.allowedWritePaths, defaults.allowedWritePaths)
            : current.allowedWritePaths,
        deniedWritePaths: update.deniedWritePaths
            ? mergeWithDefaults(update.deniedWritePaths, defaults.deniedWritePaths)
            : current.deniedWritePaths,
        deniedReadPaths: update.deniedReadPaths
            ? mergeWithDefaults(update.deniedReadPaths, defaults.deniedReadPaths)
            : current.deniedReadPaths,
        allowedDomains: update.allowedDomains
            ? mergeWithDefaults(update.allowedDomains, defaults.allowedDomains)
            : current.allowedDomains,
        allowLocalBinding: update.allowLocalBinding ?? current.allowLocalBinding,
    };
}

/**
 * Load sandbox settings for a user from the database.
 * DB stores only user-added paths; this merges them with current defaults.
 * Returns default config if no settings exist.
 */
export async function loadSandboxSettings(userId: number): Promise<SandboxConfig> {
    const rows = await db
        .select()
        .from(SandboxSettings)
        .where(eq(SandboxSettings.userId, userId))
        .limit(1);

    const defaults = getDefaultConfig();
    const settings = rows[0];
    if (!settings) {
        return defaults;
    }

    return {
        enabled: settings.enabled,
        allowedWritePaths: mergeWithDefaults(settings.allowedWritePaths, defaults.allowedWritePaths),
        deniedWritePaths: mergeWithDefaults(settings.deniedWritePaths, defaults.deniedWritePaths),
        deniedReadPaths: mergeWithDefaults(settings.deniedReadPaths, defaults.deniedReadPaths),
        allowedDomains: mergeWithDefaults(settings.allowedDomains, defaults.allowedDomains),
        allowLocalBinding: settings.allowLocalBinding,
    };
}

/**
 * Save sandbox settings for a user to the database.
 * Strips defaults before writing so only user-added paths are persisted.
 */
export async function saveSandboxSettings(
    userId: number,
    config: Partial<SandboxConfig>
): Promise<void> {
    const userOnly = toUserOnly(config);

    const existing = await db
        .select({ id: SandboxSettings.id })
        .from(SandboxSettings)
        .where(eq(SandboxSettings.userId, userId))
        .limit(1);

    const now = new Date();

    if (existing.length === 0) {
        await db.insert(SandboxSettings).values({
            userId,
            enabled: config.enabled ?? true,
            allowedWritePaths: userOnly.allowedWritePaths ?? [],
            deniedWritePaths: userOnly.deniedWritePaths ?? [],
            deniedReadPaths: userOnly.deniedReadPaths ?? [],
            allowedDomains: userOnly.allowedDomains ?? [],
            allowLocalBinding: config.allowLocalBinding ?? true,
            createdAt: now,
            updatedAt: now,
        });
    } else {
        await db
            .update(SandboxSettings)
            .set({
                ...userOnly,
                enabled: config.enabled,
                allowLocalBinding: config.allowLocalBinding,
                updatedAt: now,
            })
            .where(eq(SandboxSettings.userId, userId));
    }
}

/**
 * Ensure sandbox settings exist for a user, creating defaults if needed.
 * Returns the full merged settings.
 */
export async function ensureSandboxSettings(userId: number): Promise<SandboxConfig> {
    const rows = await db
        .select({ id: SandboxSettings.id })
        .from(SandboxSettings)
        .where(eq(SandboxSettings.userId, userId))
        .limit(1);

    if (rows.length === 0) {
        // Create empty user record (defaults merge at load time)
        await saveSandboxSettings(userId, { enabled: true, allowLocalBinding: true });
    }

    return loadSandboxSettings(userId);
}
