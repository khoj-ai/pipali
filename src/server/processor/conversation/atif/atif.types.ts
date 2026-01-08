/**
 * Agent Trajectory Interchange Format (ATIF) Type Definitions
 * Based on ATIF v1.4 specification from Harbor Framework
 * https://harborframework.com/docs/trajectory-format
 */

/**
 * Root trajectory object that captures complete interaction history
 */
export interface ATIFTrajectory {
  /**
   * Version of ATIF schema (e.g., "ATIF-v1.4")
   */
  schema_version: string;

  /**
   * Unique identifier for the session
   */
  session_id: string;

  /**
   * Agent configuration information
   */
  agent: ATIFAgent;

  /**
   * Sequence of interaction steps
   */
  steps: ATIFStep[];

  /**
   * Aggregate metrics for the entire trajectory
   */
  final_metrics?: ATIFFinalMetrics;

  /**
   * Optional custom metadata
   */
  extra?: Record<string, any>;
}

/**
 * Agent configuration and identification
 */
export interface ATIFAgent {
  /**
   * Agent identifier (e.g., "pipali-agent")
   */
  name: string;

  /**
   * Agent version (e.g., "1.0.0")
   */
  version: string;

  /**
   * LLM model used (e.g., "claude-4-sonnet", "gpt-4")
   */
  model_name: string;

  /**
   * Optional custom metadata for agent-specific data
   */
  extra?: Record<string, any>;
}

/**
 * Individual interaction step in the trajectory
 */
export interface ATIFStep {
  /**
   * Sequential step identifier (1-based)
   */
  step_id: number;

  /**
   * ISO 8601 formatted timestamp
   */
  timestamp: string;

  /**
   * Source of the step: "user" | "agent" | "system"
   */
  source: ATIFStepSource

  /**
   * Text content of the message
   */
  message?: string;

  /**
   * Agent's internal reasoning or thoughts (chain-of-thought)
   */
  reasoning_content?: string;

  /**
   * Function/tool invocations
   */
  tool_calls?: ATIFToolCall[];

  /**
   * Environment feedback from tool calls
   */
  observation?: ATIFObservation;

  /**
   * Per-step operational metrics (tokens, costs, etc.)
   */
  metrics?: ATIFMetrics;

  /**
   * Optional custom metadata for step-specific data
   */
  extra?: Record<string, any>;
}

/**
 * Tool/function call definition
 */
export interface ATIFToolCall {
  /**
   * Unique identifier for the tool call
   */
  tool_call_id: string;

  /**
   * Name of the function/tool being invoked
   */
  function_name: string;

  /**
   * Arguments passed to the function
   */
  arguments: Record<string, any>;
}

/**
 * Observation containing results from tool calls
 */
export interface ATIFObservation {
  /**
   * List of observation results
   */
  results: ATIFObservationResult[];
}

/**
 * Individual observation result from a tool call
 */
export interface ATIFObservationResult {
  /**
   * ID of the tool call that generated this result
   */
  source_call_id: string;

  /**
   * Content/output from the tool call
   * Diff from ATIF spec: Support both string and list of outputs for multimodal responses
   */
  content: string | Array<{ type: string; [key: string]: string }>;
}

/**
 * Per-step metrics for tracking costs and usage
 */
export interface ATIFMetrics {
  /**
   * Number of prompt tokens used
   */
  prompt_tokens: number;

  /**
   * Number of completion tokens generated
   */
  completion_tokens: number;

  /**
   * Number of cached tokens (if applicable)
   */
  cached_tokens?: number;

  /**
   * Cost in USD for this step
   */
  cost_usd: number;

  /**
   * Log probabilities for tokens (if available)
   */
  logprobs?: number[];

  /**
   * Token IDs for completions (if available)
   */
  completion_token_ids?: number[];
}

/**
 * Aggregate metrics for the entire trajectory
 */
export interface ATIFFinalMetrics {
  /**
   * Total prompt tokens across all steps
   */
  total_prompt_tokens: number;

  /**
   * Total completion tokens across all steps
   */
  total_completion_tokens: number;

  /**
   * Total cached tokens across all steps
   */
  total_cached_tokens?: number;

  /**
   * Total cost in USD for entire session
   */
  total_cost_usd: number;

  /**
   * Total number of steps in trajectory
   */
  total_steps: number;
}

/**
 * Helper type for step sources
 */
export type ATIFStepSource = 'user' | 'agent' | 'system';

/**
 * ATIF schema version constant
 */
export const ATIF_SCHEMA_VERSION = 'ATIF-v1.4';

/**
 * Type guard to check if an object is a valid ATIF trajectory
 */
export function isATIFTrajectory(obj: any): obj is ATIFTrajectory {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  return (
    typeof obj.schema_version === 'string' &&
    typeof obj.session_id === 'string' &&
    obj.agent &&
    typeof obj.agent === 'object' &&
    typeof obj.agent.name === 'string' &&
    typeof obj.agent.version === 'string' &&
    typeof obj.agent.model_name === 'string' &&
    Array.isArray(obj.steps)
  );
}

/**
 * Creates an empty ATIF trajectory with default values
 */
export function createEmptyATIFTrajectory(
  sessionId: string,
  agentName: string,
  agentVersion: string,
  modelName: string,
): ATIFTrajectory {
  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: sessionId,
    agent: {
      name: agentName,
      version: agentVersion,
      model_name: modelName,
    },
    steps: [],
  };
}