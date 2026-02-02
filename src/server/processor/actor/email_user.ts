/**
 * Email User Actor Tool
 *
 * Sends an email to the user via the Pipali Platform's email service.
 * Useful for notifications, summaries, and reports from background tasks and automations.
 */

import { platformFetch } from '../../http/platform-fetch';
import { getPlatformUrl } from '../../auth';
import { createChildLogger } from '../../logger';
import { basename } from 'path';
import { expandPath } from '../../utils';

const log = createChildLogger({ component: 'email_user' });

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

export interface EmailAttachment {
    filename?: string;
    path: string;
}

export interface EmailUserArgs {
    subject: string;
    body: string;
    conversation_id?: string;
    attachments?: EmailAttachment[];
}

interface EmailUserResult {
    compiled: string;
}

/**
 * Process attachments for email sending.
 * Reads local files and converts them to base64 for sending via email.
 * If filename is not provided, infers it from the file path.
 * Throws on invalid or inaccessible attachments.
 */
async function processAttachments(attachments?: EmailAttachment[]): Promise<{ filename: string; content: string }[] | undefined> {
    if (!attachments || attachments.length === 0) return undefined;

    const processed: { filename: string; content: string }[] = [];

    for (const attachment of attachments) {
        if (!attachment.path) {
            throw new Error('Attachment missing file path');
        }

        const resolvedPath = expandPath(attachment.path);
        const file = Bun.file(resolvedPath);
        if (!(await file.exists())) {
            throw new Error(`Attachment file not found: ${resolvedPath}`);
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
            throw new Error(`Attachment too large (${(file.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB): ${resolvedPath}`);
        }

        const filename = attachment.filename || basename(resolvedPath);
        const buffer = Buffer.from(await file.arrayBuffer());
        processed.push({ filename, content: buffer.toString('base64') });
        log.debug(`Read attachment: ${filename} (${file.size} bytes)`);
    }

    return processed.length > 0 ? processed : undefined;
}

export async function emailUser(args: EmailUserArgs, conversationId?: string): Promise<EmailUserResult> {
    const { subject, body, attachments } = args;

    if (!subject?.trim()) {
        return { compiled: 'Error: subject is required for sending email.' };
    }

    if (!body?.trim()) {
        return { compiled: 'Error: body is required for sending email.' };
    }

    const platformUrl = getPlatformUrl();
    const endpoint = `${platformUrl}/tools/email-user`;

    try {
        const processedAttachments = await processAttachments(attachments);

        log.info(`Sending email with subject: "${subject.slice(0, 100)}"${processedAttachments?.length ? ` and ${processedAttachments.length} attachment(s)` : ''}`);

        const result = await platformFetch<{ success: boolean }>(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subject,
                body,
                conversation_id: args.conversation_id ?? conversationId,
                attachments: processedAttachments,
            }),
        });

        if (result.wasRetried) {
            log.debug('Platform email send succeeded after token refresh');
        }

        const attachmentMsg = processedAttachments?.length ? ` with ${processedAttachments.length} attachment(s)` : '';
        return { compiled: `Email sent successfully with subject: "${subject}"${attachmentMsg}` };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ err: error }, 'Email send failed');
        return { compiled: `Error sending email: ${message}` };
    }
}
