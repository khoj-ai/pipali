/**
 * Centralized logging with automatic redaction of sensitive information.
 * Uses pino for structured logging with custom redaction for API keys and tokens.
 */

import pino from 'pino';
import { IS_COMPILED_BINARY } from './embedded-assets';

/**
 * Patterns to match and redact sensitive information in log messages.
 * Order matters - more specific patterns (like sk-ant-) must come before general ones (like sk-).
 */
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
    // Anthropic API keys (must come before OpenAI pattern since sk-ant- contains sk-)
    { pattern: /sk-ant-[a-zA-Z0-9-_]{20,}/g, replacement: 'sk-ant-[REDACTED]' },

    // OpenAI API keys
    { pattern: /sk-[a-zA-Z0-9-_]{20,}/g, replacement: 'sk-[REDACTED]' },

    // Groq API keys
    { pattern: /gsk_[a-zA-Z0-9]{20,}/g, replacement: 'gsk_[REDACTED]' },

    // Google AI/Gemini API keys (39 chars after AIza prefix)
    { pattern: /AIza[a-zA-Z0-9_-]{35,}/g, replacement: 'AIza[REDACTED]' },

    // xAI/Grok API keys
    { pattern: /xai-[a-zA-Z0-9]{20,}/g, replacement: 'xai-[REDACTED]' },

    // Cerebras API keys
    { pattern: /csk-[a-zA-Z0-9]{20,}/g, replacement: 'csk-[REDACTED]' },

    // HuggingFace tokens
    { pattern: /hf_[a-zA-Z0-9]{20,}/g, replacement: 'hf_[REDACTED]' },

    // Generic API key patterns (in headers or JSON)
    { pattern: /(x-api-key["':\s]+)[a-zA-Z0-9_-]{16,}/gi, replacement: '$1[REDACTED]' },
    { pattern: /(api[_-]?key["':\s=]+)[a-zA-Z0-9_-]{16,}/gi, replacement: '$1[REDACTED]' },

    // Bearer tokens in Authorization headers
    {
        pattern: /(Authorization["':\s]+Bearer\s+)[a-zA-Z0-9._-]+/gi,
        replacement: '$1[REDACTED]',
    },
    { pattern: /Bearer [a-zA-Z0-9._-]{10,}/gi, replacement: 'Bearer [REDACTED]' },

    // Generic token patterns
    { pattern: /(access[_-]?token["':\s=]+)[a-zA-Z0-9._-]{10,}/gi, replacement: '$1[REDACTED]' },
    { pattern: /(refresh[_-]?token["':\s=]+)[a-zA-Z0-9._-]{10,}/gi, replacement: '$1[REDACTED]' },
];

/**
 * Redact sensitive information from a string.
 */
function redactString(value: string): string {
    let result = value;
    for (const { pattern, replacement } of REDACTION_PATTERNS) {
        // Reset regex lastIndex for global patterns
        pattern.lastIndex = 0;
        result = result.replace(pattern, replacement);
    }
    return result;
}

/**
 * Recursively redact sensitive information from any value.
 */
function redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
        return redactString(value);
    }
    if (Array.isArray(value)) {
        return value.map(redactValue);
    }
    // Handle Error objects specially since their properties aren't enumerable
    if (value instanceof Error) {
        const serialized: Record<string, unknown> = {
            type: value.constructor.name,
            message: redactString(value.message),
            stack: value.stack ? redactString(value.stack) : undefined,
        };
        // Include any additional enumerable properties (e.g., cause, code)
        for (const [key, val] of Object.entries(value)) {
            serialized[key] = redactValue(val);
        }
        // Handle error cause chain
        if ('cause' in value && value.cause) {
            serialized.cause = redactValue(value.cause);
        }
        return serialized;
    }
    if (typeof value === 'object' && value !== null) {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            result[key] = redactValue(val);
        }
        return result;
    }
    return value;
}

/**
 * Custom pino hook to redact sensitive information from log messages.
 */
const redactingHooks = {
    logMethod(
        this: pino.Logger,
        inputArgs: Parameters<pino.LogFn>,
        method: pino.LogFn
    ) {
        // Redact all arguments
        const redactedArgs = inputArgs.map(redactValue) as Parameters<pino.LogFn>;
        return method.apply(this, redactedArgs);
    },
};

/**
 * Create the base pino logger with redaction enabled.
 * Note: pino-pretty doesn't work in compiled Bun binaries, so we only use it in dev mode.
 */
const usePrettyPrint = !IS_COMPILED_BINARY && process.env.NODE_ENV !== 'production';

const baseLogger = pino({
    level: process.env.LOG_LEVEL || 'info',
    hooks: redactingHooks,
    transport: usePrettyPrint
        ? {
              target: 'pino-pretty',
              options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
              },
          }
        : undefined,
});

/**
 * Main logger instance. Use this throughout the application.
 *
 * @example
 * ```typescript
 * import { logger } from './logger';
 *
 * logger.info('User logged in');
 * logger.error({ err, userId }, 'Failed to process request');
 * logger.debug({ apiKey: 'sk-1234567890abcdef...' }, 'API call'); // Key will be redacted
 * ```
 */
export const logger = baseLogger;

/**
 * Create a child logger with additional context.
 *
 * @example
 * ```typescript
 * const wsLogger = createChildLogger({ component: 'websocket' });
 * wsLogger.info({ sessionId }, 'New connection');
 * ```
 */
export function createChildLogger(bindings: pino.Bindings): pino.Logger {
    return baseLogger.child(bindings);
}

export default logger;
