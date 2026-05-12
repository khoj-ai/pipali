/**
 * Tests for the shared ConfirmationResponse Zod schema.
 *
 * The schema is the contract shared by:
 *  - REST: POST /api/automations/confirmations/:id/respond
 *  - WS:   message { type: 'confirmation_response' }
 *
 * Both paths feed the resulting `attachments` into
 * `formatConfirmationAttachmentBlock`, which then becomes part of a prompt
 * sent to the model — so untrusted client input must be rejected here.
 */

import { describe, test, expect } from 'bun:test';
import {
    confirmationResponseSchema,
    confirmationResponseAttachmentSchema,
    confirmationResponseBodySchema,
    MAX_CONFIRMATION_ATTACHMENTS,
    MAX_ATTACHMENT_PATH_LENGTH,
} from '../../src/server/processor/confirmation/confirmation.schema';

describe('confirmationResponseAttachmentSchema', () => {
    test('accepts a minimal valid attachment', () => {
        const parsed = confirmationResponseAttachmentSchema.parse({ path: '/tmp/x.txt' });
        expect(parsed.path).toBe('/tmp/x.txt');
        expect(parsed.name).toBeUndefined();
    });

    test('accepts path + name', () => {
        const parsed = confirmationResponseAttachmentSchema.parse({
            path: '/tmp/x.txt',
            name: 'report.txt',
        });
        expect(parsed.name).toBe('report.txt');
    });

    test('rejects non-string path', () => {
        const result = confirmationResponseAttachmentSchema.safeParse({ path: 123 });
        expect(result.success).toBe(false);
    });

    test('rejects empty path', () => {
        const result = confirmationResponseAttachmentSchema.safeParse({ path: '' });
        expect(result.success).toBe(false);
    });

    test('rejects path longer than MAX_ATTACHMENT_PATH_LENGTH', () => {
        const long = 'a'.repeat(MAX_ATTACHMENT_PATH_LENGTH + 1);
        const result = confirmationResponseAttachmentSchema.safeParse({ path: long });
        expect(result.success).toBe(false);
    });

    test('rejects object payload for path (prototype-poisoning shape)', () => {
        const result = confirmationResponseAttachmentSchema.safeParse({
            path: { __proto__: 'evil' },
        });
        expect(result.success).toBe(false);
    });
});

describe('confirmationResponseSchema (WebSocket shape)', () => {
    test('accepts a minimal valid response', () => {
        const parsed = confirmationResponseSchema.parse({
            requestId: 'req-1',
            selectedOptionId: 'yes',
            timestamp: '2026-05-12T00:00:00.000Z',
        });
        expect(parsed.selectedOptionId).toBe('yes');
    });

    test('accepts a guidance response with attachments', () => {
        const parsed = confirmationResponseSchema.parse({
            requestId: 'req-1',
            selectedOptionId: 'guidance',
            guidance: 'use the sanitized version',
            attachments: [{ path: '/tmp/sanitized.txt', name: 'sanitized.txt' }],
            timestamp: '2026-05-12T00:00:00.000Z',
        });
        expect(parsed.attachments?.length).toBe(1);
    });

    test('rejects missing selectedOptionId', () => {
        const result = confirmationResponseSchema.safeParse({
            requestId: 'req-1',
            timestamp: '2026-05-12T00:00:00.000Z',
        });
        expect(result.success).toBe(false);
    });

    test('rejects missing requestId', () => {
        const result = confirmationResponseSchema.safeParse({
            selectedOptionId: 'yes',
            timestamp: '2026-05-12T00:00:00.000Z',
        });
        expect(result.success).toBe(false);
    });

    test('rejects attachment array exceeding MAX_CONFIRMATION_ATTACHMENTS', () => {
        const tooMany = Array.from({ length: MAX_CONFIRMATION_ATTACHMENTS + 1 }, (_, i) => ({
            path: `/tmp/f${i}.txt`,
        }));
        const result = confirmationResponseSchema.safeParse({
            requestId: 'req-1',
            selectedOptionId: 'guidance',
            attachments: tooMany,
            timestamp: '2026-05-12T00:00:00.000Z',
        });
        expect(result.success).toBe(false);
    });

    test('rejects malformed attachment entry', () => {
        const result = confirmationResponseSchema.safeParse({
            requestId: 'req-1',
            selectedOptionId: 'guidance',
            attachments: [{ path: 123 }],
            timestamp: '2026-05-12T00:00:00.000Z',
        });
        expect(result.success).toBe(false);
    });

    test('strips unknown top-level fields rather than failing', () => {
        const parsed = confirmationResponseSchema.parse({
            requestId: 'req-1',
            selectedOptionId: 'yes',
            timestamp: '2026-05-12T00:00:00.000Z',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            __injected: 'evil',
        } as never);
        expect((parsed as Record<string, unknown>).__injected).toBeUndefined();
    });
});

describe('confirmationResponseBodySchema (REST shape)', () => {
    test('omits requestId and timestamp (set by route)', () => {
        const parsed = confirmationResponseBodySchema.parse({
            selectedOptionId: 'yes',
        });
        expect(parsed.selectedOptionId).toBe('yes');
    });

    test('still validates attachments', () => {
        const result = confirmationResponseBodySchema.safeParse({
            selectedOptionId: 'guidance',
            attachments: [{ path: 123 }],
        });
        expect(result.success).toBe(false);
    });

    test('still caps attachment count', () => {
        const tooMany = Array.from({ length: MAX_CONFIRMATION_ATTACHMENTS + 1 }, (_, i) => ({
            path: `/tmp/f${i}.txt`,
        }));
        const result = confirmationResponseBodySchema.safeParse({
            selectedOptionId: 'guidance',
            attachments: tooMany,
        });
        expect(result.success).toBe(false);
    });
});
