/**
 * User Context Module
 *
 * Manages user bio, location, and custom instructions stored in ~/.pipali/USER.md
 * This context is injected into the system prompt to personalize agent behavior.
 */

import path from 'path';
import os from 'os';
import { mkdir } from 'fs/promises';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'user-context' });

export interface UserContext {
    name?: string;
    location?: string;
    instructions?: string;
}

interface UserContextFrontmatter {
    name?: string;
    location?: string;
}

/**
 * Get the path to the USER.md file (~/.pipali/USER.md)
 */
export function getUserContextPath(): string {
    return process.env.PIPALI_USER_CONTEXT_PATH || path.join(os.homedir(), '.pipali', 'USER.md');
}

/**
 * Parse YAML frontmatter from USER.md content
 * Uses simple regex-based parsing for name and location fields
 */
function parseFrontmatter(content: string): UserContextFrontmatter | null {
    // Match frontmatter between --- markers
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) {
        return null;
    }

    const yaml = frontmatterMatch[1];
    if (!yaml) {
        return null;
    }

    const result: UserContextFrontmatter = {};

    // Parse name field - handles quoted and unquoted values
    const nameMatch = yaml.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
    if (nameMatch && nameMatch[1]) {
        result.name = nameMatch[1].trim();
    }

    // Parse location field - handles quoted and unquoted values
    const locationMatch = yaml.match(/^location:\s*["']?([^"'\n]+?)["']?\s*$/m);
    if (locationMatch && locationMatch[1]) {
        result.location = locationMatch[1].trim();
    }

    return result;
}

/**
 * Extract instructions (markdown body) from USER.md content
 */
function extractInstructions(content: string): string {
    // Find the end of frontmatter
    const frontmatterEnd = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
    if (frontmatterEnd) {
        return content.slice(frontmatterEnd[0].length).trim();
    }
    // No frontmatter, entire content is instructions
    return content.trim();
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
        const frontmatter = parseFrontmatter(content);
        const instructions = extractInstructions(content);

        return {
            name: frontmatter?.name,
            location: frontmatter?.location,
            instructions: instructions || undefined,
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
 * Initialize user context on first run or update missing fields
 * Creates USER.md with auto-populated name (from login) and location (from IP)
 * If file exists but name is missing, updates the name field
 *
 * @param userInfo - Optional user info from login (name from platform)
 */
export async function initializeUserContext(userInfo?: { name?: string }): Promise<void> {
    const userContextPath = getUserContextPath();
    const file = Bun.file(userContextPath);

    try {
        // Check if file exists
        if (await file.exists()) {
            // File exists - check if we need to update the name
            if (userInfo?.name) {
                const existingCtx = await loadUserContext();
                if (!existingCtx.name) {
                    // Name is missing, update it
                    log.info({ name: userInfo.name }, 'Updating user context with name');
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
