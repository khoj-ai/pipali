/**
 * Confirmation Manager
 *
 * Manages the lifecycle of confirmation requests within a run.
 * Handles parallel confirmations, timeout, and cleanup.
 */

import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from '../ws';
import type {
    ConfirmationRequest,
    ConfirmationResponse,
    ConfirmationCallback,
} from '../../processor/confirmation';
import type { PendingConfirmation } from './message-types';
import type { RunningState } from './session-state';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'confirmation-manager' });

/**
 * Send a confirmation request message to the client
 */
function sendConfirmationRequest(
    ws: ServerWebSocket<WebSocketData>,
    conversationId: string,
    runId: string,
    request: ConfirmationRequest
): void {
    ws.send(JSON.stringify({
        type: 'confirmation_request',
        conversationId,
        runId,
        data: request,
    }));
}

/**
 * Create a confirmation callback for a WebSocket session.
 * This sends confirmation requests to the client and waits for responses.
 */
export function createConfirmationCallback(
    ws: ServerWebSocket<WebSocketData>,
    conversationId: string,
    runState: RunningState
): ConfirmationCallback {
    return async (request: ConfirmationRequest): Promise<ConfirmationResponse> => {
        return new Promise((resolve, reject) => {
            // Store the pending confirmation
            runState.pendingConfirmations.set(request.requestId, {
                requestId: request.requestId,
                resolve,
                reject,
            });

            log.info({
                requestId: request.requestId,
                title: request.title,
                conversationId,
                runId: runState.runId,
                pendingCount: runState.pendingConfirmations.size,
            }, 'Requesting confirmation');

            // Send to client
            sendConfirmationRequest(ws, conversationId, runState.runId, request);
        });
    };
}

/**
 * Handle a confirmation response from the client
 */
export function handleConfirmationResponse(
    runState: RunningState,
    response: ConfirmationResponse
): boolean {
    const pending = runState.pendingConfirmations.get(response.requestId);

    if (!pending) {
        log.warn({
            requestId: response.requestId,
            runId: runState.runId,
        }, 'Received response for unknown confirmation');
        return false;
    }

    log.info({
        requestId: response.requestId,
        selectedOptionId: response.selectedOptionId,
        runId: runState.runId,
        remainingCount: runState.pendingConfirmations.size - 1,
    }, 'Confirmation response received');

    runState.pendingConfirmations.delete(response.requestId);
    pending.resolve(response);
    return true;
}

/**
 * Reject all pending confirmations for a run
 * Used when stopping a run that has blocking confirmations
 */
export function rejectAllConfirmations(
    runState: RunningState,
    reason: string
): void {
    if (runState.pendingConfirmations.size === 0) {
        return;
    }

    log.info({
        runId: runState.runId,
        count: runState.pendingConfirmations.size,
        reason,
    }, 'Rejecting all pending confirmations');

    for (const [requestId, pending] of runState.pendingConfirmations) {
        pending.reject(new Error(reason));
    }
    runState.pendingConfirmations.clear();
}

/**
 * Check if there are any blocking confirmations
 */
export function hasBlockingConfirmations(runState: RunningState): boolean {
    return runState.pendingConfirmations.size > 0;
}

/**
 * Get count of pending confirmations
 */
export function getPendingConfirmationCount(runState: RunningState): number {
    return runState.pendingConfirmations.size;
}
