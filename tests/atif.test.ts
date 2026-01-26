/**
 * Tests for ATIF (Agent Trajectory Interchange Format) implementation
 */

import { describe, test, expect } from 'bun:test';
import type {
  ATIFTrajectory,
  ATIFStep,
} from '../src/server/processor/conversation/atif/atif.types';
import {
  createEmptyATIFTrajectory,
  isATIFTrajectory,
  ATIF_SCHEMA_VERSION,
} from '../src/server/processor/conversation/atif/atif.types';
import {
  addStepToTrajectory,
  removeStepFromTrajectory,
  removeTurnFromTrajectory,
  removeAgentMessageFromTrajectory,
  calculateFinalMetrics,
  validateATIFTrajectory,
  exportATIFTrajectory,
  importATIFTrajectory,
} from '../src/server/processor/conversation/atif/atif.utils';

describe('ATIF Type Definitions', () => {
  test('should create empty ATIF trajectory', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    expect(trajectory.schema_version).toBe(ATIF_SCHEMA_VERSION);
    expect(trajectory.session_id).toBe('session-123');
    expect(trajectory.agent.name).toBe('test-agent');
    expect(trajectory.agent.version).toBe('1.0.0');
    expect(trajectory.agent.model_name).toBe('gpt-4');
    expect(trajectory.steps).toEqual([]);
  });

  test('should validate ATIF trajectory type guard', () => {
    const validTrajectory = {
      schema_version: 'ATIF-v1.4',
      session_id: 'test-session',
      agent: {
        name: 'test',
        version: '1.0',
        model_name: 'test-model',
      },
      steps: [],
    };

    const invalidTrajectory = {
      session_id: 'test',
      steps: [],
    };

    expect(isATIFTrajectory(validTrajectory)).toBe(true);
    expect(isATIFTrajectory(invalidTrajectory)).toBe(false);
    expect(isATIFTrajectory(null)).toBe(false);
    expect(isATIFTrajectory(undefined)).toBe(false);
    expect(isATIFTrajectory('string')).toBe(false);
  });
});

describe('ATIF Trajectory Management', () => {
  test('should add steps with correct order and IDs: system -> user -> agent', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    const systemStep = addStepToTrajectory(trajectory, 'system', 'You are helpful.');
    const userStep = addStepToTrajectory(trajectory, 'user', 'Hello');
    const agentStep = addStepToTrajectory(trajectory, 'agent', 'Hi there!');

    expect(trajectory.steps).toHaveLength(3);

    // Verify step IDs are sequential
    expect(systemStep.step_id).toBe(1);
    expect(userStep.step_id).toBe(2);
    expect(agentStep.step_id).toBe(3);

    // Verify sources
    expect(trajectory.steps[0]?.source).toBe('system');
    expect(trajectory.steps[1]?.source).toBe('user');
    expect(trajectory.steps[2]?.source).toBe('agent');

    // Verify timestamps exist
    expect(systemStep.timestamp).toBeDefined();
    expect(userStep.timestamp).toBeDefined();
    expect(agentStep.timestamp).toBeDefined();
  });

  test('should add step with metrics and accumulate in final_metrics', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    // Steps without metrics
    addStepToTrajectory(trajectory, 'system', 'System prompt');
    addStepToTrajectory(trajectory, 'user', 'Hello');

    // First agent response with metrics
    const step1 = addStepToTrajectory(
      trajectory,
      'agent',
      'First response',
      undefined,
      undefined,
      { prompt_tokens: 100, completion_tokens: 50, cached_tokens: 10, cost_usd: 0.01 }
    );

    // Second agent response with metrics
    addStepToTrajectory(
      trajectory,
      'agent',
      'Second response',
      undefined,
      undefined,
      { prompt_tokens: 150, completion_tokens: 75, cached_tokens: 20, cost_usd: 0.015 }
    );

    // Verify step metrics
    expect(step1.metrics?.prompt_tokens).toBe(100);
    expect(step1.metrics?.completion_tokens).toBe(50);
    expect(step1.metrics?.cached_tokens).toBe(10);
    expect(step1.metrics?.cost_usd).toBe(0.01);

    // Verify accumulated final_metrics
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(250);
    expect(trajectory.final_metrics?.total_completion_tokens).toBe(125);
    expect(trajectory.final_metrics?.total_cached_tokens).toBe(30);
    expect(trajectory.final_metrics?.total_cost_usd).toBe(0.025);
    expect(trajectory.final_metrics?.total_steps).toBe(4);
  });

  test('should handle steps without metrics gracefully', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'system', 'System prompt');
    addStepToTrajectory(trajectory, 'user', 'Hello');
    addStepToTrajectory(trajectory, 'agent', 'Response without metrics');

    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(0);
    expect(trajectory.final_metrics?.total_completion_tokens).toBe(0);
    expect(trajectory.final_metrics?.total_cost_usd).toBe(0);
    expect(trajectory.final_metrics?.total_steps).toBe(3);
  });

  test('should calculate final metrics from step array', () => {
    const steps: ATIFStep[] = [
      { step_id: 1, timestamp: '2024-01-01T10:00:00Z', source: 'user', message: 'Hello' },
      {
        step_id: 2,
        timestamp: '2024-01-01T10:00:30Z',
        source: 'agent',
        message: 'Response',
        metrics: { prompt_tokens: 100, completion_tokens: 50, cached_tokens: 10, cost_usd: 0.01 },
      },
      {
        step_id: 3,
        timestamp: '2024-01-01T10:01:00Z',
        source: 'agent',
        message: 'Another response',
        metrics: { prompt_tokens: 150, completion_tokens: 75, cost_usd: 0.015 },
      },
    ];

    const metrics = calculateFinalMetrics(steps);

    expect(metrics.total_prompt_tokens).toBe(250);
    expect(metrics.total_completion_tokens).toBe(125);
    expect(metrics.total_cached_tokens).toBe(10);
    expect(metrics.total_cost_usd).toBe(0.025);
    expect(metrics.total_steps).toBe(3);
  });
});

describe('ATIF Validation', () => {
  test('should validate trajectory with all step sources (system, user, agent)', () => {
    const trajectory: ATIFTrajectory = {
      schema_version: 'ATIF-v1.4',
      session_id: 'session-123',
      agent: { name: 'test-agent', version: '1.0.0', model_name: 'gpt-4' },
      steps: [
        { step_id: 1, timestamp: '2024-01-01T10:00:00Z', source: 'system', message: 'System prompt' },
        { step_id: 2, timestamp: '2024-01-01T10:00:01Z', source: 'user', message: 'Hello' },
        { step_id: 3, timestamp: '2024-01-01T10:00:02Z', source: 'agent', message: 'Hi there!' },
      ],
    };

    const validation = validateATIFTrajectory(trajectory);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test('should detect missing required fields', () => {
    const invalidTrajectory: any = {
      session_id: 'test',
      steps: [{ message: 'Test' }],
    };

    const validation = validateATIFTrajectory(invalidTrajectory);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('Missing schema_version');
    expect(validation.errors).toContain('Missing agent configuration');
    expect(validation.errors.some(e => e.includes('Missing step_id'))).toBe(true);
  });

  test('should reject invalid step source', () => {
    const trajectory: ATIFTrajectory = {
      schema_version: 'ATIF-v1.4',
      session_id: 'session-123',
      agent: { name: 'test-agent', version: '1.0.0', model_name: 'gpt-4' },
      steps: [
        { step_id: 1, timestamp: '2024-01-01T10:00:00Z', source: 'invalid' as any, message: 'Test' },
      ],
    };

    const validation = validateATIFTrajectory(trajectory);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some(e => e.includes('Invalid source'))).toBe(true);
  });
});

describe('ATIF Import/Export', () => {
  test('should roundtrip complete conversation with all features', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'pipali-agent',
      '1.0.0',
      'gpt-4o'
    );

    // 1. System prompt
    addStepToTrajectory(trajectory, 'system', 'You are a helpful assistant.');

    // 2. User message
    addStepToTrajectory(trajectory, 'user', 'List files in my home directory');

    // 3. Agent tool call with metrics
    addStepToTrajectory(
      trajectory,
      'agent',
      '',
      [{ function_name: 'list_files', arguments: { path: '~' }, tool_call_id: 'call-1' }],
      { results: [{ source_call_id: 'call-1', content: 'file1.txt\nfile2.txt\nfolder1/' }] },
      { prompt_tokens: 200, completion_tokens: 30, cached_tokens: 50, cost_usd: 0.002 }
    );

    // 4. Final agent response with metrics
    addStepToTrajectory(
      trajectory,
      'agent',
      'Here are the files:\n- file1.txt\n- file2.txt\n- folder1/',
      undefined,
      undefined,
      { prompt_tokens: 250, completion_tokens: 40, cached_tokens: 100, cost_usd: 0.003 }
    );

    // Export and import
    const json = exportATIFTrajectory(trajectory);
    const imported = importATIFTrajectory(json);

    // Verify agent metadata
    expect(imported.schema_version).toBe(ATIF_SCHEMA_VERSION);
    expect(imported.session_id).toBe('session-123');
    expect(imported.agent.name).toBe('pipali-agent');
    expect(imported.agent.model_name).toBe('gpt-4o');

    // Verify step count and sources
    expect(imported.steps).toHaveLength(4);
    expect(imported.steps[0]?.source).toBe('system');
    expect(imported.steps[0]?.message).toBe('You are a helpful assistant.');
    expect(imported.steps[1]?.source).toBe('user');
    expect(imported.steps[1]?.message).toBe('List files in my home directory');
    expect(imported.steps[2]?.source).toBe('agent');
    expect(imported.steps[3]?.source).toBe('agent');

    // Verify tool calls and observations preserved
    expect(imported.steps[2]?.tool_calls).toHaveLength(1);
    expect(imported.steps[2]?.tool_calls?.[0]?.function_name).toBe('list_files');
    expect(imported.steps[2]?.tool_calls?.[0]?.arguments).toEqual({ path: '~' });
    expect(imported.steps[2]?.observation?.results).toHaveLength(1);
    expect(imported.steps[2]?.observation?.results?.[0]?.content).toBe('file1.txt\nfile2.txt\nfolder1/');

    // Verify step metrics preserved
    expect(imported.steps[2]?.metrics?.prompt_tokens).toBe(200);
    expect(imported.steps[2]?.metrics?.cached_tokens).toBe(50);
    expect(imported.steps[3]?.metrics?.prompt_tokens).toBe(250);
    expect(imported.steps[3]?.metrics?.cost_usd).toBe(0.003);

    // Verify final_metrics preserved
    expect(imported.final_metrics?.total_prompt_tokens).toBe(450);
    expect(imported.final_metrics?.total_completion_tokens).toBe(70);
    expect(imported.final_metrics?.total_cached_tokens).toBe(150);
    expect(imported.final_metrics?.total_cost_usd).toBe(0.005);
    expect(imported.final_metrics?.total_steps).toBe(4);
  });

  test('should export trajectory as valid JSON', () => {
    const trajectory = createEmptyATIFTrajectory('session', 'agent', '1.0', 'model');
    addStepToTrajectory(trajectory, 'user', 'Test message');

    const json = exportATIFTrajectory(trajectory);
    const parsed = JSON.parse(json);

    expect(parsed.schema_version).toBe(ATIF_SCHEMA_VERSION);
    expect(parsed.session_id).toBe('session');
    expect(parsed.steps).toHaveLength(1);
  });

  test('should throw error on invalid JSON import', () => {
    const invalidJson = '{"invalid": "data"}';
    expect(() => importATIFTrajectory(invalidJson)).toThrow('Invalid ATIF trajectory');
  });
});

describe('ATIF Step Removal', () => {
  test('should remove step by step_id and recalculate metrics', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    // Add some steps with metrics
    addStepToTrajectory(trajectory, 'user', 'First message');
    addStepToTrajectory(
      trajectory,
      'agent',
      'First response',
      undefined,
      undefined,
      { prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.01 }
    );
    addStepToTrajectory(trajectory, 'user', 'Second message');
    addStepToTrajectory(
      trajectory,
      'agent',
      'Second response',
      undefined,
      undefined,
      { prompt_tokens: 150, completion_tokens: 75, cost_usd: 0.015 }
    );

    expect(trajectory.steps).toHaveLength(4);
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(250);
    expect(trajectory.final_metrics?.total_cost_usd).toBe(0.025);

    // Remove the first agent step (step_id: 2)
    const removed = removeStepFromTrajectory(trajectory, 2);

    expect(removed).toBe(true);
    expect(trajectory.steps).toHaveLength(3);

    // Verify remaining step IDs
    expect(trajectory.steps[0]?.step_id).toBe(1);
    expect(trajectory.steps[1]?.step_id).toBe(3);
    expect(trajectory.steps[2]?.step_id).toBe(4);

    // Verify metrics recalculated (only second agent step's metrics remain)
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(150);
    expect(trajectory.final_metrics?.total_completion_tokens).toBe(75);
    expect(trajectory.final_metrics?.total_cost_usd).toBe(0.015);
    expect(trajectory.final_metrics?.total_steps).toBe(3);
  });

  test('should return false when step_id does not exist', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'user', 'Test message');

    const removed = removeStepFromTrajectory(trajectory, 999);

    expect(removed).toBe(false);
    expect(trajectory.steps).toHaveLength(1);
  });

  test('should handle removing all steps', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'user', 'Only message');

    const removed = removeStepFromTrajectory(trajectory, 1);

    expect(removed).toBe(true);
    expect(trajectory.steps).toHaveLength(0);
    expect(trajectory.final_metrics?.total_steps).toBe(0);
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(0);
  });
});

describe('ATIF Agent Message Removal', () => {
  test('should remove all agent steps between user messages', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    // User message 1
    addStepToTrajectory(trajectory, 'user', 'First question');
    // Agent tool call step
    addStepToTrajectory(
      trajectory,
      'agent',
      '',
      [{ function_name: 'search', arguments: { query: 'test' }, tool_call_id: 'call-1' }],
      { results: [{ source_call_id: 'call-1', content: 'result' }] },
      { prompt_tokens: 50, completion_tokens: 20, cost_usd: 0.005 }
    );
    // Agent final response
    addStepToTrajectory(
      trajectory,
      'agent',
      'Here is the answer',
      undefined,
      undefined,
      { prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.01 }
    );
    // User message 2
    addStepToTrajectory(trajectory, 'user', 'Second question');
    // Agent response 2
    addStepToTrajectory(
      trajectory,
      'agent',
      'Second answer',
      undefined,
      undefined,
      { prompt_tokens: 80, completion_tokens: 40, cost_usd: 0.008 }
    );

    expect(trajectory.steps).toHaveLength(5);
    expect(trajectory.final_metrics?.total_cost_usd).toBe(0.023);

    // Remove the first agent message (using step_id 3, the final response)
    const removedCount = removeAgentMessageFromTrajectory(trajectory, 3);

    expect(removedCount).toBe(2); // Both agent steps removed
    expect(trajectory.steps).toHaveLength(3);

    // Verify remaining steps
    expect(trajectory.steps[0]?.source).toBe('user');
    expect(trajectory.steps[0]?.message).toBe('First question');
    expect(trajectory.steps[1]?.source).toBe('user');
    expect(trajectory.steps[1]?.message).toBe('Second question');
    expect(trajectory.steps[2]?.source).toBe('agent');
    expect(trajectory.steps[2]?.message).toBe('Second answer');

    // Verify metrics recalculated
    expect(trajectory.final_metrics?.total_cost_usd).toBe(0.008);
    expect(trajectory.final_metrics?.total_steps).toBe(3);
  });

  test('should remove agent steps at end of conversation', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'user', 'Question');
    addStepToTrajectory(
      trajectory,
      'agent',
      'Tool call step',
      undefined,
      undefined,
      { prompt_tokens: 50, completion_tokens: 25, cost_usd: 0.005 }
    );
    addStepToTrajectory(
      trajectory,
      'agent',
      'Final answer',
      undefined,
      undefined,
      { prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.01 }
    );

    expect(trajectory.steps).toHaveLength(3);

    // Remove agent message using any of the agent step IDs
    const removedCount = removeAgentMessageFromTrajectory(trajectory, 2);

    expect(removedCount).toBe(2);
    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0]?.source).toBe('user');
    expect(trajectory.final_metrics?.total_cost_usd).toBe(0);
  });

  test('should return 0 when step_id not found', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'user', 'Question');
    addStepToTrajectory(trajectory, 'agent', 'Answer');

    const removedCount = removeAgentMessageFromTrajectory(trajectory, 999);

    expect(removedCount).toBe(0);
    expect(trajectory.steps).toHaveLength(2);
  });

  test('should handle single agent step removal', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'user', 'Question');
    addStepToTrajectory(
      trajectory,
      'agent',
      'Single answer',
      undefined,
      undefined,
      { prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.01 }
    );

    const removedCount = removeAgentMessageFromTrajectory(trajectory, 2);

    expect(removedCount).toBe(1);
    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0]?.source).toBe('user');
  });
});

describe('ATIF User Message Removal', () => {
  test('should remove user message and following assistant message', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    // User message 1
    addStepToTrajectory(trajectory, 'user', 'First question');
    // Agent response 1
    addStepToTrajectory(
      trajectory,
      'agent',
      'First answer',
      undefined,
      undefined,
      { prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.01 }
    );
    // User message 2
    addStepToTrajectory(trajectory, 'user', 'Second question');
    // Agent response 2
    addStepToTrajectory(
      trajectory,
      'agent',
      'Second answer',
      undefined,
      undefined,
      { prompt_tokens: 80, completion_tokens: 40, cost_usd: 0.008 }
    );

    expect(trajectory.steps).toHaveLength(4);
    expect(trajectory.final_metrics?.total_cost_usd).toBeCloseTo(0.018);

    // Remove first user message (step_id 1) - should also remove the following agent message
    const removedCount = removeTurnFromTrajectory(trajectory, 1);

    expect(removedCount).toBe(2); // User message + agent response removed
    expect(trajectory.steps).toHaveLength(2);

    // Verify remaining steps are the second exchange
    expect(trajectory.steps[0]?.source).toBe('user');
    expect(trajectory.steps[0]?.message).toBe('Second question');
    expect(trajectory.steps[1]?.source).toBe('agent');
    expect(trajectory.steps[1]?.message).toBe('Second answer');

    // Verify metrics recalculated
    expect(trajectory.final_metrics?.total_cost_usd).toBeCloseTo(0.008);
    expect(trajectory.final_metrics?.total_steps).toBe(2);
  });

  test('should remove user message with multi-step agent response', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    // User message
    addStepToTrajectory(trajectory, 'user', 'Question');
    // Agent tool call step
    addStepToTrajectory(
      trajectory,
      'agent',
      '',
      [{ function_name: 'search', arguments: { query: 'test' }, tool_call_id: 'call-1' }],
      { results: [{ source_call_id: 'call-1', content: 'result' }] },
      { prompt_tokens: 50, completion_tokens: 20, cost_usd: 0.005 }
    );
    // Agent final response
    addStepToTrajectory(
      trajectory,
      'agent',
      'Final answer',
      undefined,
      undefined,
      { prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.01 }
    );
    // Next user message
    addStepToTrajectory(trajectory, 'user', 'Follow-up');

    expect(trajectory.steps).toHaveLength(4);

    // Remove first user message - should remove user + both agent steps
    const removedCount = removeTurnFromTrajectory(trajectory, 1);

    expect(removedCount).toBe(3); // User + 2 agent steps
    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0]?.source).toBe('user');
    expect(trajectory.steps[0]?.message).toBe('Follow-up');
  });

  test('should remove user message at end of conversation with no following assistant', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'user', 'First question');
    addStepToTrajectory(trajectory, 'agent', 'Answer');
    addStepToTrajectory(trajectory, 'user', 'Pending question'); // No response yet

    expect(trajectory.steps).toHaveLength(3);

    // Remove the last user message (no following assistant message)
    const removedCount = removeTurnFromTrajectory(trajectory, 3);

    expect(removedCount).toBe(1); // Only the user message
    expect(trajectory.steps).toHaveLength(2);
    expect(trajectory.steps[0]?.source).toBe('user');
    expect(trajectory.steps[1]?.source).toBe('agent');
  });

  test('should return 0 when step_id not found', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'user', 'Question');
    addStepToTrajectory(trajectory, 'agent', 'Answer');

    const removedCount = removeTurnFromTrajectory(trajectory, 999);

    expect(removedCount).toBe(0);
    expect(trajectory.steps).toHaveLength(2);
  });

  test('should return 0 when step_id points to non-user step', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    addStepToTrajectory(trajectory, 'user', 'Question');
    addStepToTrajectory(trajectory, 'agent', 'Answer');

    // Try to delete using agent step_id
    const removedCount = removeTurnFromTrajectory(trajectory, 2);

    expect(removedCount).toBe(0);
    expect(trajectory.steps).toHaveLength(2);
  });

  test('should handle intermediate user messages before agent response', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    // User sends multiple messages before agent responds
    addStepToTrajectory(trajectory, 'user', 'First message');
    addStepToTrajectory(trajectory, 'user', 'Actually, let me add more');
    addStepToTrajectory(trajectory, 'agent', 'Response to both');
    addStepToTrajectory(trajectory, 'user', 'Follow-up');

    expect(trajectory.steps).toHaveLength(4);

    // Remove first user message - should also remove second user message and agent response
    const removedCount = removeTurnFromTrajectory(trajectory, 1);

    expect(removedCount).toBe(3); // Both user messages + agent response
    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0]?.source).toBe('user');
    expect(trajectory.steps[0]?.message).toBe('Follow-up');
  });
});
