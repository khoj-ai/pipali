/**
 * Tests for resolveInputSubmitAction.
 *
 * The input area has two trigger paths (form submit and Enter key) that both
 * decide between three actions: send guidance, defer to parent, or consume.
 * Centralising the decision into a pure function keeps the two paths in sync
 * and lets us test the "pending confirmation + empty input" gap directly.
 */

import { describe, test, expect } from 'bun:test';
import { resolveInputSubmitAction } from '../../src/client/utils/input-submit';

describe('resolveInputSubmitAction', () => {
    test('defers to parent when no confirmation is pending and input has text', () => {
        const action = resolveInputSubmitAction({
            pendingConfirmation: false,
            inputTrimmed: 'hello',
            hasFiles: false,
        });
        expect(action).toEqual({ kind: 'default' });
    });

    test('defers to parent when no confirmation is pending and only files are staged', () => {
        const action = resolveInputSubmitAction({
            pendingConfirmation: false,
            inputTrimmed: '',
            hasFiles: true,
        });
        expect(action).toEqual({ kind: 'default' });
    });

    test('defers to parent on empty submit when no confirmation is pending', () => {
        // The parent's own handler (or the disabled button) takes care of this.
        const action = resolveInputSubmitAction({
            pendingConfirmation: false,
            inputTrimmed: '',
            hasFiles: false,
        });
        expect(action).toEqual({ kind: 'default' });
    });

    test('sends guidance with text when confirmation is pending and input has text', () => {
        const action = resolveInputSubmitAction({
            pendingConfirmation: true,
            inputTrimmed: 'use the sanitized version',
            hasFiles: false,
        });
        expect(action).toEqual({ kind: 'guidance', text: 'use the sanitized version' });
    });

    test('sends guidance with no text when confirmation is pending and only files are staged', () => {
        const action = resolveInputSubmitAction({
            pendingConfirmation: true,
            inputTrimmed: '',
            hasFiles: true,
        });
        expect(action).toEqual({ kind: 'guidance', text: undefined });
    });

    test('consumes the event when confirmation is pending and both input and files are empty', () => {
        // The bug fix: previously this case fell through to the parent's
        // "send a new message" handler while a confirmation was still pending.
        const action = resolveInputSubmitAction({
            pendingConfirmation: true,
            inputTrimmed: '',
            hasFiles: false,
        });
        expect(action).toEqual({ kind: 'consume' });
    });
});
