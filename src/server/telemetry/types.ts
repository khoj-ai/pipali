/**
 * Telemetry types for error reporting and diagnostics
 *
 * These types define the structure of telemetry events sent from the
 * desktop app to the platform for logging and diagnostics.
 */

/** Error severity levels */
export type ErrorSeverity = 'warning' | 'error' | 'critical';

/** Categories of errors for aggregation/filtering */
export type ErrorCategory =
    | 'llm_request'       // AI model request failures
    | 'llm_response'      // AI model response parsing failures
    | 'tool_execution'    // Built-in tool failures
    | 'mcp_tool'          // MCP tool failures
    | 'auth'              // Authentication failures
    | 'network'           // Network/connectivity issues
    | 'internal';         // Internal server errors

/** Information about the AI model involved in an error */
export interface ModelInfo {
    /** Model name (e.g., "gpt-5.2", "claude-4.5-sonnet") */
    name: string;
    /** Provider name (e.g., "Pipali", "OpenAI") */
    provider: string;
    /** Model type (e.g., "openai", "google") */
    type?: string;
}

/** Token usage at time of error (if available) */
export interface TokenUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

/** A single telemetry error event */
export interface TelemetryErrorEvent {
    /** Unique event ID (UUID) */
    eventId: string;
    /** ISO timestamp when error occurred */
    timestamp: string;
    /** Error severity */
    severity: ErrorSeverity;
    /** Error category for filtering */
    category: ErrorCategory;
    /** Error message */
    message: string;
    /** Error code (e.g., HTTP status, error type) */
    code?: string;
    /** Stack trace (redacted of sensitive info) */
    stack?: string;

    /** Conversation ID if applicable */
    conversationId?: string;

    /** Model information if this is an LLM error */
    model?: ModelInfo;
    /** Token usage at time of error */
    tokenUsage?: TokenUsage;

    /** Tool name if this is a tool error */
    toolName?: string;

    /** Additional context */
    context?: Record<string, unknown>;

    /** App version */
    appVersion?: string;
    /** Platform (darwin, linux, win32) */
    platform?: string;
}

/** Batch of telemetry events to send */
export interface TelemetryBatch {
    events: TelemetryErrorEvent[];
}

/** Response from telemetry endpoint */
export interface TelemetryResponse {
    received: number;
    errors?: string[];
}
