/**
 * Session State Machine
 *
 * Manages the state of a WebSocket session's active run.
 * Uses a state machine pattern for clear, testable state transitions.
 *
 * States:
 * - idle: No active run
 * - running: Run in progress
 * - stopped: Run stopped (waiting for user action)
 */

import type { User } from '../../db/schema';
import type { ConfirmationPreferences } from '../../processor/confirmation';
import type { QueuedMessage, PendingConfirmation, StopReason } from './message-types';

// ============================================================================
// State Types
// ============================================================================

export interface IdleState {
    status: 'idle';
}

export interface RunningState {
    status: 'running';
    runId: string;
    clientMessageId: string;
    abortController: AbortController;
    stopMode: 'none' | 'soft' | 'hard';
    /**
     * Reason to emit when the run ends due to a hard stop.
     * For explicit stop, this is 'user_stop'. For confirmation-blocked soft interrupt,
     * this is 'soft_interrupt'.
     */
    stopReason?: StopReason;
    queuedMessages: QueuedMessage[];
    pendingConfirmations: Map<string, PendingConfirmation>;
}

export interface StoppedState {
    status: 'stopped';
    runId: string;
    reason: StopReason;
    queuedMessages: QueuedMessage[];
}

export type RunState = IdleState | RunningState | StoppedState;

// ============================================================================
// Transition Types
// ============================================================================

export interface StartRunTransition {
    type: 'START_RUN';
    runId: string;
    clientMessageId: string;
}

export interface SoftInterruptTransition {
    type: 'SOFT_INTERRUPT';
    message: QueuedMessage;
}

export interface HardStopTransition {
    type: 'HARD_STOP';
    reason: StopReason;
    clearQueue: boolean;
}

export interface StepCompletedTransition {
    type: 'STEP_COMPLETED';
}

export interface RunCompleteTransition {
    type: 'RUN_COMPLETE';
}

export interface RunErrorTransition {
    type: 'RUN_ERROR';
    error: string;
}

export interface ResetTransition {
    type: 'RESET';
}

export type RunTransition =
    | StartRunTransition
    | SoftInterruptTransition
    | HardStopTransition
    | StepCompletedTransition
    | RunCompleteTransition
    | RunErrorTransition
    | ResetTransition;

// ============================================================================
// State Machine
// ============================================================================

/**
 * Create initial idle state
 */
export function createIdleState(): IdleState {
    return { status: 'idle' };
}

/**
 * Create running state for a new run
 */
export function createRunningState(runId: string, clientMessageId: string): RunningState {
    return {
        status: 'running',
        runId,
        clientMessageId,
        abortController: new AbortController(),
        stopMode: 'none',
        stopReason: undefined,
        queuedMessages: [],
        pendingConfirmations: new Map(),
    };
}

/**
 * Pure state transition function
 *
 * Given current state and transition, returns new state.
 * This is a pure function with no side effects.
 */
export function transitionRun(state: RunState, transition: RunTransition): RunState {
    switch (transition.type) {
        case 'START_RUN': {
            // Can only start from idle
            if (state.status !== 'idle') {
                return state;
            }
            return createRunningState(transition.runId, transition.clientMessageId);
        }

        case 'SOFT_INTERRUPT': {
            // Can only soft interrupt while running
            if (state.status !== 'running') {
                return state;
            }
            return {
                ...state,
                stopMode: 'soft',
                stopReason: 'soft_interrupt',
                queuedMessages: [...state.queuedMessages, transition.message],
            };
        }

        case 'HARD_STOP': {
            // Can only hard stop while running
            if (state.status !== 'running') {
                return state;
            }
            return {
                ...state,
                stopMode: 'hard',
                stopReason: transition.reason,
                queuedMessages: transition.clearQueue ? [] : state.queuedMessages,
            };
        }

        case 'STEP_COMPLETED': {
            // Check for soft interrupt at step boundary
            if (state.status !== 'running') {
                return state;
            }

            // If soft interrupt with queued message, transition to stopped
            if (state.stopMode === 'soft' && state.queuedMessages.length > 0) {
                return {
                    status: 'stopped',
                    runId: state.runId,
                    reason: 'soft_interrupt',
                    queuedMessages: state.queuedMessages,
                };
            }

            // If hard stop, transition to stopped
            if (state.stopMode === 'hard') {
                return {
                    status: 'stopped',
                    runId: state.runId,
                    reason: state.stopReason ?? 'user_stop',
                    queuedMessages: state.queuedMessages,
                };
            }

            // Continue running
            return state;
        }

        case 'RUN_COMPLETE': {
            if (state.status !== 'running') {
                return state;
            }
            return createIdleState();
        }

        case 'RUN_ERROR': {
            if (state.status !== 'running') {
                return state;
            }
            return {
                status: 'stopped',
                runId: state.runId,
                reason: 'error',
                queuedMessages: [],
            };
        }

        case 'RESET': {
            return createIdleState();
        }

        default:
            return state;
    }
}

// ============================================================================
// Session Class
// ============================================================================

/**
 * Full session state including conversation context
 */
export interface Session {
    conversationId: string;
    user: typeof User.$inferSelect;
    confirmationPreferences: ConfirmationPreferences;
    runState: RunState;
    // User message for initial research (cleared after persistence)
    userMessage?: string;
}

/**
 * Create a new session
 */
export function createSession(
    conversationId: string,
    user: typeof User.$inferSelect,
    confirmationPreferences: ConfirmationPreferences,
    userMessage?: string
): Session {
    return {
        conversationId,
        user,
        confirmationPreferences,
        runState: createIdleState(),
        userMessage,
    };
}

/**
 * Get the active run state (if running)
 */
export function getActiveRun(session: Session): RunningState | null {
    if (session.runState.status === 'running') {
        return session.runState;
    }
    return null;
}

/**
 * Check if session has an active run
 */
export function hasActiveRun(session: Session): boolean {
    return session.runState.status === 'running';
}

/**
 * Check if session is stopping (soft or hard)
 */
export function isStopping(session: Session): boolean {
    if (session.runState.status !== 'running') {
        return false;
    }
    return session.runState.stopMode !== 'none';
}

/**
 * Check if there are queued messages
 */
export function hasQueuedMessages(session: Session): boolean {
    if (session.runState.status !== 'running') {
        return false;
    }
    return session.runState.queuedMessages.length > 0;
}

/**
 * Get next queued message
 */
export function getNextQueuedMessage(session: Session): QueuedMessage | null {
    if (session.runState.status !== 'running') {
        return null;
    }
    return session.runState.queuedMessages[0] ?? null;
}

/**
 * Pop next queued message (returns new state)
 */
export function popQueuedMessage(state: RunningState): RunningState {
    return {
        ...state,
        queuedMessages: state.queuedMessages.slice(1),
    };
}

/**
 * Apply a transition to the session
 */
export function applyTransition(session: Session, transition: RunTransition): Session {
    return {
        ...session,
        runState: transitionRun(session.runState, transition),
    };
}
