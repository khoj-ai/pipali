/**
 * ATIF (Agent Trajectory Interchange Format) Utility Functions
 * Provides conversion and manipulation utilities for ATIF trajectories
 */

import type {
  ATIFTrajectory,
  ATIFStep,
  ATIFToolCall,
  ATIFObservation,
  ATIFMetrics,
  ATIFFinalMetrics,
  ATIFStepSource,
} from './atif.types';

/**
 * Sanitize a value for PostgreSQL JSONB storage.
 * Removes unsupported Unicode escape sequences that PGlite/PostgreSQL rejects:
 * - Null bytes (\u0000)
 * - Other control characters (U+0001-U+001F) except \t, \n, \r
 *
 * This recursively processes strings, arrays, and objects.
 */
export function sanitizeForJsonb<T>(value: T): T {
  if (typeof value === 'string') {
    // Remove null bytes and other problematic control characters
    // Keep \t (0x09), \n (0x0A), \r (0x0D)
    return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') as T;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForJsonb(item)) as T;
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = sanitizeForJsonb(val);
    }
    return result as T;
  }

  return value;
}


/**
 * Adds a new step to an existing ATIF trajectory
 */
export function addStepToTrajectory(
  trajectory: ATIFTrajectory,
  source: ATIFStepSource,
  message: string,
  toolCalls?: ATIFToolCall[],
  observation?: ATIFObservation,
  metrics?: ATIFMetrics
): ATIFStep {
  const nextStepId = trajectory.steps.length > 0
    ? Math.max(...trajectory.steps.map(s => s.step_id)) + 1
    : 1;

  const step: ATIFStep = {
    step_id: nextStepId,
    timestamp: new Date().toISOString(),
    source,
    message,
    tool_calls: toolCalls,
    observation,
    metrics,
  };

  trajectory.steps.push(step);

  // Update final metrics
  trajectory.final_metrics = calculateFinalMetrics(trajectory.steps);

  return step;
}

/**
 * Calculates final metrics from all steps in the trajectory
 */
export function calculateFinalMetrics(steps: ATIFStep[]): ATIFFinalMetrics {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCostUsd = 0;

  steps.forEach((step) => {
    if (step.metrics) {
      totalPromptTokens += step.metrics.prompt_tokens || 0;
      totalCompletionTokens += step.metrics.completion_tokens || 0;
      totalCachedTokens += step.metrics.cached_tokens || 0;
      totalCacheWriteTokens += step.metrics.cache_write_tokens || 0;
      totalCostUsd += step.metrics.cost_usd || 0;
    }
  });

  return {
    total_prompt_tokens: totalPromptTokens,
    total_completion_tokens: totalCompletionTokens,
    total_cached_tokens: totalCachedTokens || undefined,
    total_cache_write_tokens: totalCacheWriteTokens || undefined,
    total_cost_usd: totalCostUsd,
    total_steps: steps.length,
  };
}

/**
 * Sums two sets of step metrics, e.g. a director iteration's own LLM usage and
 * the usage its tools racked up while executing.
 */
export function addMetrics(previous: ATIFMetrics | undefined, next: ATIFMetrics): ATIFMetrics {
  return {
    prompt_tokens: (previous?.prompt_tokens ?? 0) + next.prompt_tokens,
    completion_tokens: (previous?.completion_tokens ?? 0) + next.completion_tokens,
    cached_tokens: (previous?.cached_tokens ?? 0) + (next.cached_tokens ?? 0) || undefined,
    cache_write_tokens: (previous?.cache_write_tokens ?? 0) + (next.cache_write_tokens ?? 0) || undefined,
    cost_usd: (previous?.cost_usd ?? 0) + next.cost_usd,
  };
}

/**
 * Folds one step's metrics into a running total, for callers that persist steps
 * incrementally and never hold the whole trajectory in memory.
 */
export function accumulateFinalMetrics(
  running: ATIFFinalMetrics | null | undefined,
  step: ATIFMetrics | undefined,
  totalSteps: number,
): ATIFFinalMetrics {
  return {
    total_prompt_tokens: (running?.total_prompt_tokens ?? 0) + (step?.prompt_tokens ?? 0),
    total_completion_tokens: (running?.total_completion_tokens ?? 0) + (step?.completion_tokens ?? 0),
    total_cached_tokens: (running?.total_cached_tokens ?? 0) + (step?.cached_tokens ?? 0) || undefined,
    total_cache_write_tokens: (running?.total_cache_write_tokens ?? 0) + (step?.cache_write_tokens ?? 0) || undefined,
    total_cost_usd: (running?.total_cost_usd ?? 0) + (step?.cost_usd ?? 0),
    total_steps: totalSteps,
  };
}

/**
 * Validates an ATIF trajectory for completeness and correctness
 */
export function validateATIFTrajectory(trajectory: ATIFTrajectory): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check schema version
  if (!trajectory.schema_version) {
    errors.push('Missing schema_version');
  } else if (!trajectory.schema_version.startsWith('ATIF-')) {
    errors.push('Invalid schema_version format');
  }

  // Check session ID
  if (!trajectory.session_id) {
    errors.push('Missing session_id');
  }

  // Check agent
  if (!trajectory.agent) {
    errors.push('Missing agent configuration');
  } else {
    if (!trajectory.agent.name) errors.push('Missing agent.name');
    if (!trajectory.agent.version) errors.push('Missing agent.version');
    if (!trajectory.agent.model_name) errors.push('Missing agent.model_name');
  }

  // Check steps
  if (!Array.isArray(trajectory.steps)) {
    errors.push('Steps must be an array');
  } else {
    trajectory.steps.forEach((step, index) => {
      if (!step.step_id) errors.push(`Step ${index}: Missing step_id`);
      if (!step.timestamp) errors.push(`Step ${index}: Missing timestamp`);
      if (!step.source) errors.push(`Step ${index}: Missing source`);
      if (!['user', 'agent', 'system'].includes(step.source)) {
        errors.push(`Step ${index}: Invalid source "${step.source}"`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Exports an ATIF trajectory as a JSON string
 */
export function exportATIFTrajectory(trajectory: ATIFTrajectory): string {
  return JSON.stringify(trajectory, null, 2);
}

/**
 * Imports an ATIF trajectory from a JSON string
 */
export function importATIFTrajectory(jsonString: string): ATIFTrajectory {
  const parsed = JSON.parse(jsonString);
  const validation = validateATIFTrajectory(parsed);

  if (!validation.valid) {
    throw new Error(`Invalid ATIF trajectory: ${validation.errors.join(', ')}`);
  }

  return parsed as ATIFTrajectory;
}

/**
 * Removes a step from an ATIF trajectory by step_id
 * Returns true if the step was found and removed, false otherwise
 */
export function removeStepFromTrajectory(
  trajectory: ATIFTrajectory,
  stepId: number
): boolean {
  const stepIndex = trajectory.steps.findIndex(s => s.step_id === stepId);

  if (stepIndex === -1) {
    return false;
  }

  // Remove the step
  trajectory.steps.splice(stepIndex, 1);

  // Recalculate final metrics
  trajectory.final_metrics = calculateFinalMetrics(trajectory.steps);

  return true;
}

/**
 * Removes a user message and the following assistant message (all agent steps until the
 * next user message) from the trajectory. Also removes inline system steps and any
 * intermediate user messages within the deleted turn.
 * Returns the number of steps removed.
 */
export function removeTurnFromTrajectory(
  trajectory: ATIFTrajectory,
  stepId: number
): number {
  const startIndex = trajectory.steps.findIndex(s => s.step_id === stepId);

  if (startIndex === -1) {
    return 0;
  }

  // Verify this is a user message
  if (trajectory.steps[startIndex]?.source !== 'user') {
    return 0;
  }

  // Find the end of the following assistant message (all steps until next user message
  // that follows an agent step, or end of trajectory)
  let endIndex = startIndex;
  let foundAgentStep = false;
  for (let i = startIndex + 1; i < trajectory.steps.length; i++) {
    const step = trajectory.steps[i];
    if (step?.source === 'agent') {
      foundAgentStep = true;
      endIndex = i;
    } else if (step?.source === 'user') {
      if (foundAgentStep) {
        // Stop at user message after we've seen agent steps
        break;
      }
      // Include intermediate user messages before any agent response
      endIndex = i;
    } else if (step?.source === 'system') {
      endIndex = i;
    }
  }

  const removeCount = endIndex - startIndex + 1;
  trajectory.steps.splice(startIndex, removeCount);

  // Recalculate final metrics
  trajectory.final_metrics = calculateFinalMetrics(trajectory.steps);

  return removeCount;
}

/**
 * Removes an agent message and all associated steps (reasoning, tool calls, tool results,
 * and inline system steps) from the trajectory. Deletes the response starting from the
 * step that contains the given step_id, going backwards to the previous user message
 * and forwards until the next user message.
 * Returns the number of steps removed.
 */
export function removeAgentMessageFromTrajectory(
  trajectory: ATIFTrajectory,
  stepId: number
): number {
  const startIndex = trajectory.steps.findIndex(s => s.step_id === stepId);

  if (startIndex === -1) {
    return 0;
  }

  // Find the range of agent steps to delete
  // Go backwards to find where agent steps start (after last user message)
  let firstAgentIndex = startIndex;
  for (let i = startIndex - 1; i >= 0; i--) {
    if (trajectory.steps[i]?.source === 'user') {
      break; // Stop at user message
    }
    if (trajectory.steps[i]?.source === 'agent' || trajectory.steps[i]?.source === 'system') {
      firstAgentIndex = i;
    }
  }

  // Now find the end - all agent steps until next user message or end
  let lastAgentIndex = startIndex;
  for (let i = startIndex + 1; i < trajectory.steps.length; i++) {
    if (trajectory.steps[i]?.source === 'user') {
      break; // Stop at next user message
    }
    if (trajectory.steps[i]?.source === 'agent' || trajectory.steps[i]?.source === 'system') {
      lastAgentIndex = i;
    }
  }

  const removeCount = lastAgentIndex - firstAgentIndex + 1;
  trajectory.steps.splice(firstAgentIndex, removeCount);

  // Recalculate final metrics
  trajectory.final_metrics = calculateFinalMetrics(trajectory.steps);

  return removeCount;
}

/**
 * Removes the given step and everything recorded after it, rewinding the trajectory to
 * the state it was in just before that step ran.
 * Returns the number of steps removed.
 */
export function truncateTrajectoryFrom(
  trajectory: ATIFTrajectory,
  stepId: number
): number {
  const startIndex = trajectory.steps.findIndex(s => s.step_id === stepId);

  if (startIndex === -1) {
    return 0;
  }

  const removeCount = trajectory.steps.length - startIndex;
  trajectory.steps.splice(startIndex);

  trajectory.final_metrics = calculateFinalMetrics(trajectory.steps);

  return removeCount;
}
