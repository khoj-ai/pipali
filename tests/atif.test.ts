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
  convertATIFToChatMessages,
  addStepToTrajectory,
  calculateFinalMetrics,
  validateATIFTrajectory,
  exportATIFTrajectory,
  importATIFTrajectory,
} from '../src/server/processor/conversation/atif/atif.utils';
import { type ChatMessage } from '../src/server/db/schema';

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

describe('ATIF Conversion Utilities', () => {
  test('should convert ATIF trajectory to ChatMessage array', () => {
    const trajectory: ATIFTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: 'session-123',
      agent: {
        name: 'test-agent',
        version: '1.0.0',
        model_name: 'gpt-4',
      },
      steps: [
        {
          step_id: 1,
          timestamp: '2024-01-01T10:00:00Z',
          source: 'user',
          message: 'Test message',
        },
        {
          step_id: 2,
          timestamp: '2024-01-01T10:00:30Z',
          source: 'agent',
          message: 'Response message',
          reasoning_content: 'My reasoning',
        },
      ],
    };

    const messages = convertATIFToChatMessages(trajectory);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.by).toBe('user');
    expect(messages[0]?.message).toBe('Test message');
    expect(messages[1]?.by).toBe('assistant');
    expect(messages[1]?.message).toBe('Response message');
    expect(messages[1]?.trainOfThought?.[0]?.data).toBe('My reasoning');
  });
});

describe('ATIF Trajectory Management', () => {
  test('should add step to trajectory', () => {
    const trajectory = createEmptyATIFTrajectory(
      'session-123',
      'test-agent',
      '1.0.0',
      'gpt-4'
    );

    const step = addStepToTrajectory(
      trajectory,
      'user',
      'Test message'
    );

    expect(trajectory.steps).toHaveLength(1);
    expect(step.step_id).toBe(1);
    expect(step.source).toBe('user');
    expect(step.message).toBe('Test message');
    expect(step.timestamp).toBeDefined();
  });

  test('should calculate final metrics', () => {
    const steps: ATIFStep[] = [
      {
        step_id: 1,
        timestamp: '2024-01-01T10:00:00Z',
        source: 'user',
        message: 'Hello',
      },
      {
        step_id: 2,
        timestamp: '2024-01-01T10:00:30Z',
        source: 'agent',
        message: 'Response',
        metrics: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cached_tokens: 10,
          cost_usd: 0.01,
        },
      },
      {
        step_id: 3,
        timestamp: '2024-01-01T10:01:00Z',
        source: 'agent',
        message: 'Another response',
        metrics: {
          prompt_tokens: 150,
          completion_tokens: 75,
          cost_usd: 0.015,
        },
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
  test('should validate valid trajectory', () => {
    const trajectory: ATIFTrajectory = {
      schema_version: 'ATIF-v1.4',
      session_id: 'session-123',
      agent: {
        name: 'test-agent',
        version: '1.0.0',
        model_name: 'gpt-4',
      },
      steps: [
        {
          step_id: 1,
          timestamp: '2024-01-01T10:00:00Z',
          source: 'user',
          message: 'Test',
        },
      ],
    };

    const validation = validateATIFTrajectory(trajectory);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test('should detect invalid trajectory', () => {
    const invalidTrajectory: any = {
      session_id: 'test',
      steps: [
        {
          message: 'Test',
        },
      ],
    };

    const validation = validateATIFTrajectory(invalidTrajectory);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('Missing schema_version');
    expect(validation.errors).toContain('Missing agent configuration');
    expect(validation.errors.some(e => e.includes('Missing step_id'))).toBe(true);
  });

  test('should validate step sources', () => {
    const trajectory: ATIFTrajectory = {
      schema_version: 'ATIF-v1.4',
      session_id: 'session-123',
      agent: {
        name: 'test-agent',
        version: '1.0.0',
        model_name: 'gpt-4',
      },
      steps: [
        {
          step_id: 1,
          timestamp: '2024-01-01T10:00:00Z',
          source: 'invalid' as any,
          message: 'Test',
        },
      ],
    };

    const validation = validateATIFTrajectory(trajectory);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some(e => e.includes('Invalid source'))).toBe(true);
  });
});

describe('ATIF Import/Export', () => {
  test('should export trajectory as JSON', () => {
    const trajectory = createEmptyATIFTrajectory('session', 'agent', '1.0', 'model');
    addStepToTrajectory(trajectory, 'user', 'Test message');

    const json = exportATIFTrajectory(trajectory);
    const parsed = JSON.parse(json);

    expect(parsed.schema_version).toBe(ATIF_SCHEMA_VERSION);
    expect(parsed.session_id).toBe('session');
    expect(parsed.steps).toHaveLength(1);
  });

  test('should import valid trajectory from JSON', () => {
    const original = createEmptyATIFTrajectory('session', 'agent', '1.0', 'model');
    addStepToTrajectory(original, 'user', 'Test message');

    const json = exportATIFTrajectory(original);
    const imported = importATIFTrajectory(json);

    expect(imported.schema_version).toBe(original.schema_version);
    expect(imported.session_id).toBe(original.session_id);
    expect(imported.steps).toHaveLength(1);
    expect(imported.steps[0]?.message).toBe('Test message');
  });

  test('should throw error on invalid JSON import', () => {
    const invalidJson = '{"invalid": "data"}';

    expect(() => importATIFTrajectory(invalidJson)).toThrow('Invalid ATIF trajectory');
  });
});
