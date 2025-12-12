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
import { type ChatMessage, type TrainOfThought } from '../../../db/schema';


/**
 * Converts ATIF Trajectory back to ChatMessage array for backward compatibility
 */
export function convertATIFToChatMessages(trajectory: ATIFTrajectory): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let currentAgentMessage: ChatMessage | null = null;
  let currentTrainOfThought: TrainOfThought[] = [];

  for (const step of trajectory.steps) {
    if (step.source === 'user') {
      // If we have a pending agent message, finalize it
      if (currentAgentMessage) {
        if (currentTrainOfThought.length > 0) {
          currentAgentMessage.trainOfThought = currentTrainOfThought;
        }
        messages.push(currentAgentMessage);
        currentAgentMessage = null;
        currentTrainOfThought = [];
      }

      // Add user message
      messages.push({
        by: 'user',
        message: step.message || '',
        created: step.timestamp,
      });
    } else if (step.source === 'agent') {
      // Check if this step has actual message content (final response)
      const hasMessage = step.message && step.message.trim() !== '';

      // If this is a final response or we don't have a current agent message, create one
      if (hasMessage || !currentAgentMessage) {
        // Finalize any existing agent message
        if (currentAgentMessage) {
          if (currentTrainOfThought.length > 0) {
            currentAgentMessage.trainOfThought = currentTrainOfThought;
          }
          messages.push(currentAgentMessage);
          currentTrainOfThought = [];
        }

        // Create new agent message if this step has a message
        if (hasMessage) {
          currentAgentMessage = {
            by: 'assistant',
            message: step.message || '',
            created: step.timestamp,
          };
        }
      }

      // Add reasoning content to train of thought
      if (step.reasoning_content) {
        currentTrainOfThought.push({
          type: 'reasoning',
          data: step.reasoning_content,
        });
      }

      // Add tool calls to train of thought
      if (step.tool_calls && step.tool_calls.length > 0) {
        const toolCallsData = step.tool_calls.map(tc => ({
          id: tc.tool_call_id,
          name: tc.function_name,
          args: tc.arguments,
        }));

        currentTrainOfThought.push({
          type: 'tool_call',
          data: JSON.stringify(toolCallsData),
        });

        // Add tool results if available
        if (step.observation && step.observation.results) {
          const toolResultsData = step.observation.results.map(result => ({
            toolCall: {
              id: result.source_call_id,
              name: step.tool_calls?.find(tc => tc.tool_call_id === result.source_call_id)?.function_name || 'unknown',
              args: step.tool_calls?.find(tc => tc.tool_call_id === result.source_call_id)?.arguments || {},
            },
            result: result.content,
          }));

          currentTrainOfThought.push({
            type: 'tool_result',
            data: JSON.stringify(toolResultsData),
          });
        }
      }
    }
  }

  // Don't forget to add the last agent message if there is one
  if (currentAgentMessage) {
    if (currentTrainOfThought.length > 0) {
      currentAgentMessage.trainOfThought = currentTrainOfThought;
    }
    messages.push(currentAgentMessage);
  }

  return messages;
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


