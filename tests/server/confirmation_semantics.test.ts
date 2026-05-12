/**
 * Tests for validateConfirmationResponseSemantics.
 *
 * `processConfirmationResponse` only appends the attachment block to the
 * denialReason when !approved. If the user picks YES (or YES_DONT_ASK) with
 * attachments, the attachments are silently discarded. This validator
 * rejects that asymmetric case at the transport boundary so the contract is
 * explicit and the same on REST and WS.
 */

import { describe, test, expect } from 'bun:test';
import {
    validateConfirmationResponseSemantics,
    CONFIRMATION_OPTIONS,
} from '../../src/server/processor/confirmation/confirmation.types';

describe('validateConfirmationResponseSemantics', () => {
    test('accepts guidance with attachments', () => {
        const result = validateConfirmationResponseSemantics({
            selectedOptionId: CONFIRMATION_OPTIONS.GUIDANCE,
            attachments: [{ path: '/tmp/sanitized.txt' }],
        });
        expect(result.valid).toBe(true);
    });

    test('accepts denial with attachments', () => {
        // The else branch of processConfirmationResponse appends attachments
        // even for the NO case ("User denied the operation<block>"), so this
        // remains a valid combination.
        const result = validateConfirmationResponseSemantics({
            selectedOptionId: CONFIRMATION_OPTIONS.NO,
            attachments: [{ path: '/tmp/x.txt' }],
        });
        expect(result.valid).toBe(true);
    });

    test('accepts approval with no attachments', () => {
        const result = validateConfirmationResponseSemantics({
            selectedOptionId: CONFIRMATION_OPTIONS.YES,
        });
        expect(result.valid).toBe(true);
    });

    test('accepts approval with an empty attachments array', () => {
        const result = validateConfirmationResponseSemantics({
            selectedOptionId: CONFIRMATION_OPTIONS.YES,
            attachments: [],
        });
        expect(result.valid).toBe(true);
    });

    test('accepts approval with attachments explicitly undefined', () => {
        const result = validateConfirmationResponseSemantics({
            selectedOptionId: CONFIRMATION_OPTIONS.YES,
            attachments: undefined,
        });
        expect(result.valid).toBe(true);
    });

    test('rejects YES with attachments', () => {
        const result = validateConfirmationResponseSemantics({
            selectedOptionId: CONFIRMATION_OPTIONS.YES,
            attachments: [{ path: '/tmp/x.txt' }],
        });
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toMatch(/attach/i);
            expect(result.reason).toMatch(/approv/i);
        }
    });

    test('rejects YES_DONT_ASK with attachments', () => {
        const result = validateConfirmationResponseSemantics({
            selectedOptionId: CONFIRMATION_OPTIONS.YES_DONT_ASK,
            attachments: [{ path: '/tmp/x.txt' }],
        });
        expect(result.valid).toBe(false);
    });

    test('accepts an ask_user custom option with attachments (not an approval option)', () => {
        // ask_user uses 'acknowledge' / 'option_N' which are not approval IDs,
        // so attachments are still allowed and surface via the response's own
        // handler path.
        const result = validateConfirmationResponseSemantics({
            selectedOptionId: 'option_0',
            attachments: [{ path: '/tmp/x.txt' }],
        });
        expect(result.valid).toBe(true);
    });
});
