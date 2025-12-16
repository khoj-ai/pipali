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
  let totalCostUsd = 0;

  steps.forEach((step) => {
    if (step.metrics) {
      totalPromptTokens += step.metrics.prompt_tokens || 0;
      totalCompletionTokens += step.metrics.completion_tokens || 0;
      totalCachedTokens += step.metrics.cached_tokens || 0;
      totalCostUsd += step.metrics.cost_usd || 0;
    }
  });

  return {
    total_prompt_tokens: totalPromptTokens,
    total_completion_tokens: totalCompletionTokens,
    total_cached_tokens: totalCachedTokens || undefined,
    total_cost_usd: totalCostUsd,
    total_steps: steps.length,
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


