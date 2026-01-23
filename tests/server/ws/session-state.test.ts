/**
 * Session State Machine Tests
 *
 * Tests for the pure state transition functions.
 */

import { describe, test, expect } from 'bun:test';
import {
    createIdleState,
    createRunningState,
    transitionRun,
    type RunState,
    type RunTransition,
} from '../../../src/server/routes/ws/session-state';

describe('Session State Machine', () => {
    describe('createIdleState', () => {
        test('creates idle state', () => {
            const state = createIdleState();
            expect(state.status).toBe('idle');
        });
    });

    describe('createRunningState', () => {
        test('creates running state with correct properties', () => {
            const runId = 'run-123';
            const clientMessageId = 'msg-456';
            const state = createRunningState(runId, clientMessageId);

            expect(state.status).toBe('running');
            expect(state.runId).toBe(runId);
            expect(state.clientMessageId).toBe(clientMessageId);
            expect(state.stopMode).toBe('none');
            expect(state.queuedMessages).toEqual([]);
            expect(state.pendingConfirmations.size).toBe(0);
            expect(state.abortController).toBeInstanceOf(AbortController);
        });
    });

    describe('transitionRun', () => {
        describe('START_RUN', () => {
            test('transitions from idle to running', () => {
                const idle = createIdleState();
                const result = transitionRun(idle, {
                    type: 'START_RUN',
                    runId: 'run-1',
                    clientMessageId: 'msg-1',
                });

                expect(result.status).toBe('running');
                if (result.status === 'running') {
                    expect(result.runId).toBe('run-1');
                    expect(result.clientMessageId).toBe('msg-1');
                }
            });

            test('does not transition from running', () => {
                const running = createRunningState('run-1', 'msg-1');
                const result = transitionRun(running, {
                    type: 'START_RUN',
                    runId: 'run-2',
                    clientMessageId: 'msg-2',
                });

                // Should return same state (no change)
                expect(result).toBe(running);
                if (result.status === 'running') {
                    expect(result.runId).toBe('run-1');
                }
            });
        });

        describe('SOFT_INTERRUPT', () => {
            test('queues message and sets soft stop mode', () => {
                const running = createRunningState('run-1', 'msg-1');
                const queuedMessage = {
                    runId: 'run-2',
                    clientMessageId: 'msg-2',
                    message: 'interrupt message',
                };

                const result = transitionRun(running, {
                    type: 'SOFT_INTERRUPT',
                    message: queuedMessage,
                });

                expect(result.status).toBe('running');
                if (result.status === 'running') {
                    expect(result.stopMode).toBe('soft');
                    expect(result.queuedMessages).toHaveLength(1);
                    expect(result.queuedMessages[0]).toEqual(queuedMessage);
                }
            });

            test('appends to existing queue', () => {
                const running = createRunningState('run-1', 'msg-1');
                const msg1 = { runId: 'run-2', clientMessageId: 'msg-2', message: 'first' };
                const msg2 = { runId: 'run-3', clientMessageId: 'msg-3', message: 'second' };

                let result = transitionRun(running, { type: 'SOFT_INTERRUPT', message: msg1 });
                result = transitionRun(result, { type: 'SOFT_INTERRUPT', message: msg2 });

                if (result.status === 'running') {
                    expect(result.queuedMessages).toHaveLength(2);
                    expect(result.queuedMessages[0]).toEqual(msg1);
                    expect(result.queuedMessages[1]).toEqual(msg2);
                }
            });

            test('does not affect idle state', () => {
                const idle = createIdleState();
                const result = transitionRun(idle, {
                    type: 'SOFT_INTERRUPT',
                    message: { runId: 'r', clientMessageId: 'm', message: 'x' },
                });

                expect(result).toBe(idle);
            });
        });

        describe('HARD_STOP', () => {
            test('sets hard stop mode and clears queue', () => {
                let running = createRunningState('run-1', 'msg-1');

                // Add some queued messages first
                running = transitionRun(running, {
                    type: 'SOFT_INTERRUPT',
                    message: { runId: 'r2', clientMessageId: 'm2', message: 'x' },
                }) as typeof running;

                const result = transitionRun(running, { type: 'HARD_STOP', reason: 'user_stop', clearQueue: true });

                expect(result.status).toBe('running');
                if (result.status === 'running') {
                    expect(result.stopMode).toBe('hard');
                    expect(result.queuedMessages).toHaveLength(0);
                }
            });

            test('does not affect idle state', () => {
                const idle = createIdleState();
                const result = transitionRun(idle, { type: 'HARD_STOP', reason: 'user_stop', clearQueue: true });
                expect(result).toBe(idle);
            });
        });

        describe('STEP_COMPLETED', () => {
            test('with soft interrupt and queued message transitions to stopped', () => {
                let running = createRunningState('run-1', 'msg-1');
                running = transitionRun(running, {
                    type: 'SOFT_INTERRUPT',
                    message: { runId: 'r2', clientMessageId: 'm2', message: 'x' },
                }) as typeof running;

                const result = transitionRun(running, { type: 'STEP_COMPLETED' });

                expect(result.status).toBe('stopped');
                if (result.status === 'stopped') {
                    expect(result.runId).toBe('run-1');
                    expect(result.reason).toBe('soft_interrupt');
                }
            });

            test('with hard stop transitions to stopped', () => {
                let running = createRunningState('run-1', 'msg-1');
                running = transitionRun(running, { type: 'HARD_STOP', reason: 'user_stop', clearQueue: true }) as typeof running;

                const result = transitionRun(running, { type: 'STEP_COMPLETED' });

                expect(result.status).toBe('stopped');
                if (result.status === 'stopped') {
                    expect(result.runId).toBe('run-1');
                    expect(result.reason).toBe('user_stop');
                }
            });

            test('with no stop mode continues running', () => {
                const running = createRunningState('run-1', 'msg-1');
                const result = transitionRun(running, { type: 'STEP_COMPLETED' });

                expect(result.status).toBe('running');
                expect(result).toBe(running);
            });

            test('with soft interrupt but no queued messages continues running', () => {
                let running = createRunningState('run-1', 'msg-1');
                // Manually set soft mode without adding message (edge case)
                running = { ...running, stopMode: 'soft' as const };

                const result = transitionRun(running, { type: 'STEP_COMPLETED' });

                // Should continue because no queued messages
                expect(result.status).toBe('running');
            });
        });

        describe('RUN_COMPLETE', () => {
            test('transitions to idle', () => {
                const running = createRunningState('run-1', 'msg-1');
                const result = transitionRun(running, { type: 'RUN_COMPLETE' });

                expect(result.status).toBe('idle');
            });

            test('does not affect idle state', () => {
                const idle = createIdleState();
                const result = transitionRun(idle, { type: 'RUN_COMPLETE' });
                expect(result).toBe(idle);
            });
        });

        describe('RUN_ERROR', () => {
            test('transitions to stopped with error reason', () => {
                const running = createRunningState('run-1', 'msg-1');
                const result = transitionRun(running, {
                    type: 'RUN_ERROR',
                    error: 'Something went wrong',
                });

                expect(result.status).toBe('stopped');
                if (result.status === 'stopped') {
                    expect(result.runId).toBe('run-1');
                    expect(result.reason).toBe('error');
                }
            });
        });

        describe('RESET', () => {
            test('transitions any state to idle', () => {
                const running = createRunningState('run-1', 'msg-1');
                const result = transitionRun(running, { type: 'RESET' });
                expect(result.status).toBe('idle');
            });

            test('transitions stopped to idle', () => {
                const stopped: RunState = {
                    status: 'stopped',
                    runId: 'run-1',
                    reason: 'user_stop',
                    queuedMessages: [],
                };
                const result = transitionRun(stopped, { type: 'RESET' });
                expect(result.status).toBe('idle');
            });
        });
    });

    describe('State Machine Invariants', () => {
        test('soft interrupt preserves original run ID', () => {
            const running = createRunningState('run-1', 'msg-1');
            const result = transitionRun(running, {
                type: 'SOFT_INTERRUPT',
                message: { runId: 'run-2', clientMessageId: 'msg-2', message: 'x' },
            });

            if (result.status === 'running') {
                expect(result.runId).toBe('run-1'); // Original run continues
            }
        });

        test('hard stop clears queue even if soft interrupt came first', () => {
            let running = createRunningState('run-1', 'msg-1');

            // Soft interrupt first
            running = transitionRun(running, {
                type: 'SOFT_INTERRUPT',
                message: { runId: 'r2', clientMessageId: 'm2', message: 'soft' },
            }) as typeof running;

            // Then hard stop
            const result = transitionRun(running, { type: 'HARD_STOP', reason: 'user_stop', clearQueue: true });

            if (result.status === 'running') {
                expect(result.stopMode).toBe('hard');
                expect(result.queuedMessages).toHaveLength(0);
            }
        });

        test('multiple soft interrupts queue in order', () => {
            let running = createRunningState('run-1', 'msg-1');

            for (let i = 1; i <= 3; i++) {
                running = transitionRun(running, {
                    type: 'SOFT_INTERRUPT',
                    message: {
                        runId: `run-${i + 1}`,
                        clientMessageId: `msg-${i + 1}`,
                        message: `message-${i}`,
                    },
                }) as typeof running;
            }

            if (running.status === 'running') {
                expect(running.queuedMessages).toHaveLength(3);
                expect(running.queuedMessages.map(m => m.message)).toEqual([
                    'message-1',
                    'message-2',
                    'message-3',
                ]);
            }
        });
    });
});
