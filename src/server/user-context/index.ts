/**
 * User Context Module
 *
 * Manages user bio, location, and custom instructions stored in ~/.pipali/USER.md
 * This context is injected into the system prompt to personalize agent behavior.
 */

import path from 'path';
import os from 'os';
import { mkdir } from 'fs/promises';
import { parseFrontmatter } from '../frontmatter';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'user-context' });

export interface UserContext {
    name?: string;
    location?: string;
    language?: string;
    instructions?: string;
}

/**
 * Get the path to the USER.md file (~/.pipali/USER.md)
 */
export function getUserContextPath(): string {
    return process.env.PIPALI_USER_CONTEXT_PATH || path.join(os.homedir(), '.pipali', 'USER.md');
}

/**
 * Load user context from ~/.pipali/USER.md
 */
export async function loadUserContext(): Promise<UserContext> {
    const userContextPath = getUserContextPath();
    const file = Bun.file(userContextPath);

    if (!await file.exists()) {
        return {};
    }

    try {
        const content = await file.text();
        const parsed = parseFrontmatter(content);

        return {
            name: parsed?.fields.name,
            location: parsed?.fields.location,
            language: parsed?.fields.language,
            // Without frontmatter the whole file is instructions
            instructions: (parsed ? parsed.body : content.trim()) || undefined,
        };
    } catch (err) {
        log.error({ err, path: userContextPath }, 'Failed to load user context');
        return {};
    }
}

/**
 * Save user context to ~/.pipali/USER.md
 */
export async function saveUserContext(ctx: UserContext): Promise<void> {
    const userContextPath = getUserContextPath();

    // Ensure parent directory exists
    const parentDir = path.dirname(userContextPath);
    await mkdir(parentDir, { recursive: true });

    // Build USER.md content
    const lines: string[] = ['---'];
    if (ctx.name) {
        lines.push(`name: ${ctx.name}`);
    }
    if (ctx.location) {
        lines.push(`location: ${ctx.location}`);
    }
    if (ctx.language) {
        lines.push(`language: ${ctx.language}`);
    }
    lines.push('---');
    lines.push('');
    if (ctx.instructions) {
        lines.push(ctx.instructions);
    }

    const content = lines.join('\n');

    try {
        await Bun.write(userContextPath, content);
        log.info({ path: userContextPath }, 'Saved user context');
    } catch (err) {
        log.error({ err, path: userContextPath }, 'Failed to save user context');
        throw err;
    }
}

/**
 * Fetch location from IP geolocation service
 * Uses ip-api.com (free, no API key required, 45 requests/minute limit)
 */
async function fetchLocationFromIP(): Promise<string | undefined> {
    try {
        const response = await fetch('http://ip-api.com/json/?fields=city,regionName,country');
        if (!response.ok) {
            log.warn({ status: response.status }, 'IP geolocation request failed');
            return undefined;
        }

        const data = await response.json() as { city?: string; regionName?: string; country?: string };
        const parts = [data.city, data.regionName, data.country].filter(Boolean);
        if (parts.length > 0) {
            return parts.join(', ');
        }
        return undefined;
    } catch (err) {
        log.warn({ err }, 'Failed to fetch location from IP');
        return undefined;
    }
}

/**
 * Initialize user context on first run or update name if user hasn't customized it.
 * Creates USER.md with auto-populated name (from login) and location (from IP).
 *
 * On subsequent logins, updates the name only if it still matches the previous
 * platform name (i.e. user never manually changed it).
 *
 * @param userInfo - User info from login
 * @param userInfo.name - Current display name from platform
 * @param userInfo.previousPlatformName - Last known platform name stored in DB
 */
export async function initializeUserContext(userInfo?: { name?: string; previousPlatformName?: string | null }): Promise<void> {
    const userContextPath = getUserContextPath();
    const file = Bun.file(userContextPath);

    try {
        // Check if file exists
        if (await file.exists()) {
            if (userInfo?.name) {
                const existingCtx = await loadUserContext();
                // Update name if: missing, or still matches the old platform name (never customized)
                const shouldUpdate = !existingCtx.name
                    || (userInfo.previousPlatformName && existingCtx.name === userInfo.previousPlatformName && existingCtx.name !== userInfo.name);
                if (shouldUpdate) {
                    log.info({ oldName: existingCtx.name, newName: userInfo.name }, 'Updating user context with platform name');
                    await saveUserContext({
                        ...existingCtx,
                        name: userInfo.name,
                    });
                }
            }
            return;
        }

        log.info('Initializing user context for first run');

        // Fetch location from IP geolocation
        const location = await fetchLocationFromIP();

        // Create initial user context
        const ctx: UserContext = {
            name: userInfo?.name,
            location,
            instructions: '',
        };

        await saveUserContext(ctx);
        log.info({ name: ctx.name, location: ctx.location }, 'User context initialized');
    } catch (err) {
        // Don't crash server if user context initialization fails
        log.warn({ err }, 'Failed to initialize user context (non-fatal)');
    }
}
