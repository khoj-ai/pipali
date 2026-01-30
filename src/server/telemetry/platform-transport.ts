/**
 * Pino transport that sends error/warning logs to the platform telemetry endpoint.
 *
 * This transport intercepts logs at warn/error level and batches them for
 * transmission to the platform. It integrates with the existing Pino logging
 * system so all error logging automatically gets sent to the platform.
 */

import { getPlatformUrl, getValidAccessToken, isAuthenticated } from '../auth';
import type { TelemetryErrorEvent, TelemetryBatch, ErrorCategory, ErrorSeverity } from './types';

// Configuration
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 30_000; // 30 seconds
const REQUEST_TIMEOUT_MS = 10_000; // 10 seconds

// Module state
let eventQueue: TelemetryErrorEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let isInitialized = false;

// App metadata
let appVersion: string | undefined;
let platform: string | undefined;

function isTelemetryDisabled(): boolean {
    const value = process.env.PIPALI_TELEMETRY_DISABLE;
    if (!value) return false;
    return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Initialize the platform transport
 */
export function initPlatformTransport(options?: { appVersion?: string }): void {
    if (isInitialized) return;
    if (isTelemetryDisabled()) return;

    appVersion = options?.appVersion;
    platform = process.platform;

    // Start periodic flush
    flushTimer = setInterval(() => {
        flushEvents().catch(() => {
            // Silent fail - don't log errors about logging
        });
    }, FLUSH_INTERVAL_MS);

    isInitialized = true;
}

/**
 * Shutdown the platform transport
 */
export async function shutdownPlatformTransport(): Promise<void> {
    if (!isInitialized) return;

    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }

    // Final flush
    await flushEvents();
    isInitialized = false;
}

/**
 * Map Pino log level to telemetry severity
 */
function mapLevelToSeverity(level: number): ErrorSeverity | null {
    // Pino levels: trace=10, debug=20, info=30, warn=40, error=50, fatal=60
    if (level >= 50) return 'error'; // error, fatal
    if (level >= 40) return 'warning'; // warn
    return null; // Don't send info/debug/trace to platform
}

/**
 * Infer error category from log data
 */
function inferCategory(data: Record<string, unknown>): ErrorCategory {
    const component = data.component as string | undefined;
    const toolName = data.toolName as string | undefined;

    if (component === 'llm' || data.model || data.provider) {
        return 'llm_request';
    }
    if (toolName) {
        return toolName.includes('__') ? 'mcp_tool' : 'tool_execution';
    }
    if (component === 'auth' || data.code === 'auth_expired') {
        return 'auth';
    }
    if (data.err && typeof data.err === 'object') {
        const err = data.err as { code?: string; message?: string };
        if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message?.includes('network')) {
            return 'network';
        }
    }
    return 'internal';
}

/**
 * Queue a log entry for sending to platform
 */
export function queueLogEntry(logEntry: {
    level: number;
    time: number;
    msg: string;
    [key: string]: unknown;
}): void {
    if (!isInitialized) return;

    const severity = mapLevelToSeverity(logEntry.level);
    if (!severity) return; // Only send warn/error

    const { level, time, msg, ...data } = logEntry;

    // Extract error info if present
    let stack: string | undefined;
    let code: string | undefined;
    if (data.err && typeof data.err === 'object') {
        const err = data.err as { stack?: string; code?: string; message?: string };
        stack = err.stack;
        code = err.code;
    }

    const event: TelemetryErrorEvent = {
        eventId: crypto.randomUUID(),
        timestamp: new Date(time).toISOString(),
        severity,
        category: inferCategory(data),
        message: msg,
        code,
        stack: stack ? sanitizeStack(stack) : undefined,
        conversationId: data.conversationId as string | undefined,
        model: data.model || data.modelName ? {
            name: (data.modelName || data.model) as string,
            provider: data.provider as string || data.modelProvider as string || 'unknown',
            type: data.modelType as string | undefined,
        } : undefined,
        toolName: data.toolName as string | undefined,
        context: Object.keys(data).length > 0 ? data : undefined,
        appVersion,
        platform,
    };

    eventQueue.push(event);

    // Flush if batch is full
    if (eventQueue.length >= BATCH_SIZE) {
        flushEvents().catch(() => {});
    }
}

/**
 * Flush queued events to the platform
 */
async function flushEvents(): Promise<void> {
    if (eventQueue.length === 0) return;

    // Check if authenticated
    const authenticated = await isAuthenticated();
    if (!authenticated) return;

    // Get access token
    const accessToken = await getValidAccessToken();
    if (!accessToken) return;

    // Take events from queue
    const eventsToSend = eventQueue.splice(0, BATCH_SIZE);
    if (eventsToSend.length === 0) return;

    const platformUrl = getPlatformUrl();
    const telemetryUrl = `${platformUrl}/telemetry`;

    try {
        const batch: TelemetryBatch = { events: eventsToSend };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(telemetryUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(batch),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            // Don't re-queue on failure to avoid infinite loops
            return;
        }
    } catch {
        // Silent fail - don't log errors about logging
    }
}

/**
 * Sanitize stack traces to remove sensitive information
 */
function sanitizeStack(stack: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) {
        stack = stack.replace(new RegExp(escapeRegExp(homeDir), 'g'), '~');
    }
    if (stack.length > 4000) {
        stack = stack.substring(0, 4000) + '\n... (truncated)';
    }
    return stack;
}

function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
