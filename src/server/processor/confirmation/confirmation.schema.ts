/**
 * Shared Zod schemas for confirmation responses.
 *
 * Both transports consume the same schema so the REST and WebSocket
 * confirmation paths cannot drift apart:
 *  - REST: POST /api/automations/confirmations/:id/respond
 *  - WS:   message { type: 'confirmation_response' }
 *
 * The attachments captured here flow into formatConfirmationAttachmentBlock
 * (confirmation.service.ts) and end up in a prompt sent to the model, so
 * untrusted client input must be bounded and well-typed at this boundary.
 */

import { z } from 'zod';
import type {
    ConfirmationResponse,
    ConfirmationResponseAttachment,
} from './confirmation.types';

export const MAX_CONFIRMATION_ATTACHMENTS = 50;
export const MAX_ATTACHMENT_PATH_LENGTH = 4096;
export const MAX_ATTACHMENT_NAME_LENGTH = 512;

export const confirmationResponseAttachmentSchema = z.object({
    path: z.string().min(1).max(MAX_ATTACHMENT_PATH_LENGTH),
    name: z.string().max(MAX_ATTACHMENT_NAME_LENGTH).optional(),
});

const confirmationResponseAttachmentsArraySchema = z
    .array(confirmationResponseAttachmentSchema)
    .max(MAX_CONFIRMATION_ATTACHMENTS);

const confirmationResponseInputDataSchema = z.object({
    selectedIds: z.array(z.string()).optional(),
    numericValue: z.number().optional(),
    textValue: z.string().optional(),
});

export const confirmationResponseSchema = z.object({
    requestId: z.string().min(1),
    selectedOptionId: z.string().min(1),
    guidance: z.string().optional(),
    inputData: confirmationResponseInputDataSchema.optional(),
    persistPreference: z.boolean().optional(),
    attachments: confirmationResponseAttachmentsArraySchema.optional(),
    timestamp: z.string(),
});

/**
 * REST shape: the route sets `requestId` from the URL and `timestamp` server-side,
 * so the request body omits both.
 */
export const confirmationResponseBodySchema = confirmationResponseSchema.omit({
    requestId: true,
    timestamp: true,
});

// Type-level assertions: the parsed schemas must produce values
// assignable to the public ConfirmationResponse / attachment types.
type _Assert = [
    z.infer<typeof confirmationResponseSchema> extends ConfirmationResponse ? true : false,
    z.infer<typeof confirmationResponseAttachmentSchema> extends ConfirmationResponseAttachment ? true : false,
];
const _assert: _Assert = [true, true];
void _assert;
