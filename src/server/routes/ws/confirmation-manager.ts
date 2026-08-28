/**
 * Confirmation Manager
 *
 * Manages the lifecycle of confirmation requests within a run.
 * Handles parallel confirmations, timeout, and cleanup.
 *
 * Works with ConversationEventBus + RunHandle (transport-agnostic).
 */

import type { ConversationEventBus } from '../../events/conversation-event-bus';
import type { RunHandle } from '../../events/conversation-event-bus';
import {
    type ConfirmationRequest,
    type ConfirmationResponse,
    type ConfirmationCallback,
    type ConfirmationOutcome,
    type ConfirmationPersistence,
    CONFIRMATION_OPTIONS,
    CONFIRMATION_TIMEOUT_MS,
} from '../../processor/confirmation';
import type { PendingConfirmation } from './message-types';
import { createChildLogger } from '../../logger';
import { pushConfirmationRequest } from '../../push';

const log = createChildLogger({ component: 'confirmation-manager' });

/**
 * Get the confirmation key for a request.
 * Format: "operation" or "operation:operationType"
 */
function getConfirmationKey(request: ConfirmationRequest): string {
    const operationType = request.context?.operationType;
    return operationType ? `${request.operation}:${operationType}` : request.operation;
}

/**
 * Create a confirmation callback that publishes requests to the bus.
 * All subscribers see the request; first response wins.
 *
 * A run that also persists its confirmations passes a `persistence` hook. Recording is a
 * side effect of the one request path, never a replacement for it, so a persisted
 * confirmation still reaches a watching client in the same tick it is raised.
 */
export function createConfirmationCallback(
    bus: ConversationEventBus,
    conversationId: string,
    runHandle: RunHandle,
    persistence?: ConfirmationPersistence,
): ConfirmationCallback {
    return async (request: ConfirmationRequest): Promise<ConfirmationResponse> => {
        if (persistence) {
            try {
                await persistence.onRequest(request);
            } catch (err) {
                // Losing the record costs the routines page its copy. It must not also
                // cost the watching client their dialog.
                log.error({
                    err,
                    requestId: request.requestId,
                    conversationId,
                }, 'Could not record confirmation request');
            }
        }

        const settle = (outcome: ConfirmationOutcome) => {
            persistence?.onSettled(request, outcome).catch(err => log.error({
                err,
                requestId: request.requestId,
                conversationId,
            }, 'Could not record confirmation outcome'));
        };

        // Recording holds the request for a moment, and a stop landing in that window sweeps
        // the pending confirmations before this one joins them. Registering it now would
        // leave a dialog nothing is waiting on.
        if (runHandle.abortController.signal.aborted) {
            const stopped = new Error('Research stopped');
            settle({ status: 'abandoned', reason: stopped.message });
            throw stopped;
        }

        return new Promise((resolve, reject) => {
            // Nobody may be watching - a delegated task can still be going after the app
            // is closed - so give up eventually rather than holding the run forever.
            const timeout = setTimeout(() => {
                if (!runHandle.pendingConfirmations.delete(request.requestId)) return;
                log.warn({
                    requestId: request.requestId,
                    conversationId,
                    runId: runHandle.runId,
                }, 'Confirmation timed out');
                settle({ status: 'expired' });
                reject(new Error('Confirmation timeout expired'));
            }, CONFIRMATION_TIMEOUT_MS);

            runHandle.pendingConfirmations.set(request.requestId, {
                requestId: request.requestId,
                request,
                resolve: (response) => {
                    clearTimeout(timeout);
                    settle({ status: 'answered', response });
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    settle({ status: 'abandoned', reason: error.message });
                    reject(error);
                },
            });

            log.info({
                requestId: request.requestId,
                title: request.title,
                conversationId,
                runId: runHandle.runId,
                pendingCount: runHandle.pendingConfirmations.size,
            }, 'Requesting confirmation');

            bus.publish({
                type: 'confirmation_request',
                conversationId,
                runId: runHandle.runId,
                data: request,
            });

            // Always pushed, even with someone watching here: an unanswered confirmation
            // holds the run until they come back, so a duplicate beats a miss.
            if (bus.user) {
                pushConfirmationRequest(bus.user.id, request, conversationId);
            }
        });
    };
}

/**
 * Handle a confirmation response.
 * When "Yes, don't ask again" is selected, auto-approves matching pending confirmations.
 */
export function handleConfirmationResponse(
    runHandle: RunHandle,
    response: ConfirmationResponse,
): string[] {
    const pending = runHandle.pendingConfirmations.get(response.requestId);

    if (!pending) {
        log.warn({
            requestId: response.requestId,
            runId: runHandle.runId,
        }, 'Received response for unknown confirmation');
        return [];
    }

    log.info({
        requestId: response.requestId,
        selectedOptionId: response.selectedOptionId,
        runId: runHandle.runId,
        remainingCount: runHandle.pendingConfirmations.size - 1,
    }, 'Confirmation response received');

    runHandle.pendingConfirmations.delete(response.requestId);
    pending.resolve(response);
    const resolvedIds: string[] = [response.requestId];

    if (response.selectedOptionId === CONFIRMATION_OPTIONS.YES_DONT_ASK) {
        const sourceKey = getConfirmationKey(pending.request);
        const toAutoApprove: PendingConfirmation[] = [];

        for (const [, otherPending] of runHandle.pendingConfirmations) {
            if (getConfirmationKey(otherPending.request) === sourceKey) {
                toAutoApprove.push(otherPending);
            }
        }

        if (toAutoApprove.length > 0) {
            log.info({
                runId: runHandle.runId,
                confirmationKey: sourceKey,
                autoApprovedCount: toAutoApprove.length,
            }, 'Auto-approving matching pending confirmations');

            for (const otherPending of toAutoApprove) {
                runHandle.pendingConfirmations.delete(otherPending.requestId);
                resolvedIds.push(otherPending.requestId);
                otherPending.resolve({
                    requestId: otherPending.requestId,
                    selectedOptionId: CONFIRMATION_OPTIONS.YES_DONT_ASK,
                    timestamp: new Date().toISOString(),
                });
            }
        }
    }

    return resolvedIds;
}

/**
 * Answer a confirmation and tell everyone watching the conversation it is settled.
 *
 * Both doors onto a confirmation - the WebSocket the dialog answers on, and the HTTP
 * endpoint the routines page answers on - come through here, so whichever arrives second
 * finds nothing left to resolve.
 *
 * Returns the requests that were settled, including any auto-approved alongside.
 */
export function resolveConfirmationOnBus(
    bus: ConversationEventBus,
    runHandle: RunHandle,
    response: ConfirmationResponse,
): string[] {
    const resolvedIds = handleConfirmationResponse(runHandle, response);

    for (const requestId of resolvedIds) {
        bus.publish({
            type: 'confirmation_resolved',
            conversationId: bus.conversationId,
            runId: runHandle.runId,
            data: {
                requestId,
                selectedOptionId: response.selectedOptionId,
                timestamp: response.timestamp,
            },
        });
    }

    return resolvedIds;
}

/**
 * Reject all pending confirmations for a run
 */
export function rejectAllConfirmations(
    runHandle: RunHandle,
    reason: string,
): void {
    if (runHandle.pendingConfirmations.size === 0) {
        return;
    }

    log.info({
        runId: runHandle.runId,
        count: runHandle.pendingConfirmations.size,
        reason,
    }, 'Rejecting all pending confirmations');

    for (const [, pending] of runHandle.pendingConfirmations) {
        pending.reject(new Error(reason));
    }
    runHandle.pendingConfirmations.clear();
}

/**
 * Check if there are any blocking confirmations
 */
export function hasBlockingConfirmations(runHandle: RunHandle): boolean {
    return runHandle.pendingConfirmations.size > 0;
}
