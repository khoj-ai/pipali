/**
 * Web Push notifications.
 *
 * Pipali is its own push application server: it generates a VAPID keypair locally, signs
 * each message with it, and posts straight to the browser's push service. No developer
 * account, no certificate, no platform hop. The payload is sealed to the subscribing
 * device, so the push service relays bytes it cannot read.
 *
 * A notification reaches the device over the device's own connection, so it arrives
 * whether or not that device can currently reach this server — only acting on one does.
 */

import webpush from 'web-push';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { NotificationSettings, PushSubscription } from '../db/schema';
import type { ConfirmationRequest } from '../processor/confirmation/confirmation.types';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'push' });

/** VAPID requires a contact URL identifying the application server. */
const VAPID_SUBJECT = 'https://pipali.ai';

/**
 * Safari caps the encrypted payload at 2 KB where other browsers allow 4 KB, so budget
 * for the smaller one. Everything here is an identifier or a short line; the app fetches
 * the detail when it opens.
 */
const MAX_PAYLOAD_BYTES = 2048;

/** How long a push service should hold an undelivered message: an unanswered approval
 *  goes stale quickly, while a finished run is still worth knowing tomorrow morning. */
const TTL_SECONDS = { confirmation: 3600, complete: 86_400 } as const;

export type PushPayload = {
    title: string;
    body: string;
    conversationId?: string;
    /** Collapses repeats about the same thing rather than stacking them. */
    tag?: string;
    /** Answering from the notification needs the request the answer belongs to. */
    requestId?: string;
    /** Rendered as notification buttons. */
    actions?: { id: string; label: string }[];
};

// ============================================================================
// VAPID keys
// ============================================================================

async function loadOrCreateKeys(userId: number): Promise<{ publicKey: string; privateKey: string }> {
    const [existing] = await db.select().from(NotificationSettings).where(eq(NotificationSettings.userId, userId));
    if (existing) return { publicKey: existing.vapidPublicKey, privateKey: existing.vapidPrivateKey };

    const keys = webpush.generateVAPIDKeys();
    try {
        await db.insert(NotificationSettings).values({
            userId,
            vapidPublicKey: keys.publicKey,
            vapidPrivateKey: keys.privateKey,
        });
        log.info('Generated VAPID keypair');
        return keys;
    } catch {
        // Lost a race against a concurrent first call. The row that won is authoritative:
        // handing back our discarded keys would invalidate whatever subscribed to theirs.
        const [winner] = await db.select().from(NotificationSettings).where(eq(NotificationSettings.userId, userId));
        if (!winner) throw new Error('Failed to persist VAPID keypair');
        return { publicKey: winner.vapidPublicKey, privateKey: winner.vapidPrivateKey };
    }
}

/** The public half, handed to the browser so it can mint a subscription bound to us. */
export async function getVapidPublicKey(userId: number): Promise<string> {
    return (await loadOrCreateKeys(userId)).publicKey;
}

// ============================================================================
// Subscriptions
// ============================================================================

export type BrowserSubscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
};

/** Re-subscribing the same device replaces its keys rather than accumulating rows. */
export async function saveSubscription(userId: number, sub: BrowserSubscription, label: string): Promise<void> {
    await db
        .insert(PushSubscription)
        .values({ userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, label })
        .onConflictDoUpdate({
            target: PushSubscription.endpoint,
            set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, label, updatedAt: new Date() },
        });
    log.info({ label }, 'Registered push subscription');
}

export async function listSubscriptions(userId: number) {
    return db
        .select({
            id: PushSubscription.id,
            label: PushSubscription.label,
            createdAt: PushSubscription.createdAt,
            lastNotifiedAt: PushSubscription.lastNotifiedAt,
        })
        .from(PushSubscription)
        .where(eq(PushSubscription.userId, userId));
}

/** Used when a device turns notifications off, so we stop pushing before it 410s. */
export async function deleteSubscriptionByEndpoint(userId: number, endpoint: string): Promise<void> {
    await db.delete(PushSubscription).where(
        and(eq(PushSubscription.userId, userId), eq(PushSubscription.endpoint, endpoint)),
    );
    log.info({ userId }, 'Device turned off push notifications');
}

export async function deleteSubscription(userId: number, id: number): Promise<void> {
    await db.delete(PushSubscription).where(
        and(eq(PushSubscription.userId, userId), eq(PushSubscription.id, id)),
    );
    log.info({ id, userId }, 'Removed push subscription');
}

// ============================================================================
// Sending
// ============================================================================

const SUMMARY_CHARS = 140;

function truncate(text: string, max: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * A notification shows two buttons at most; the rest of a question stays behind a tap.
 * Chrome for Android 143 through 152 fires the last button whichever one is tapped
 * (crbug.com/534387021, fixed in 153): a Yes answered as No there is that, not a mapping here.
 */
const MAX_NOTIFICATION_ACTIONS = 2;
/** A button shows one short line, so a longer answer is trimmed rather than clipped. */
const ACTION_LABEL_CHARS = 24;

/**
 * The buttons come from the request's own options, so an ask_user question offers its
 * answers rather than a hardcoded yes and no. Options that persist a preference are left
 * out: "don't ask again" is too consequential to sit one tap from a lock screen.
 */
function notificationActions(request: ConfirmationRequest): PushPayload['actions'] {
    if (request.inputType !== 'choice') return undefined;

    const offered = request.options
        .filter(option => !option.persistPreference)
        .slice(0, MAX_NOTIFICATION_ACTIONS)
        .map(option => ({ id: option.id, label: truncate(option.label, ACTION_LABEL_CHARS) }));

    return offered.length > 0 ? offered : undefined;
}

/**
 * What is being confirmed, not merely that something is.
 *
 * A shell command's title is the same words every time, so two waiting at once arrive as
 * the same notification twice and a tap approves whichever one it landed on.
 */
function confirmationSummary(request: ConfirmationRequest): string {
    const command = request.context?.commandInfo?.command;
    if (command) return command;

    const file = request.diff?.filePath ?? request.context?.affectedFiles?.[0];
    return file ? `${request.title}: ${file}` : request.title;
}

/**
 * Answers that did not fit as buttons are counted, so a partial set cannot read as the
 * whole question and send someone to the nearest button instead of the one they wanted.
 */
function confirmationBody(request: ConfirmationRequest, offered: PushPayload['actions']): string {
    const summary = truncate(confirmationSummary(request), SUMMARY_CHARS);
    if (request.inputType !== 'choice') return summary;

    const answerable = request.options.filter(option => !option.persistPreference).length;
    const withheld = answerable - (offered?.length ?? 0);
    return withheld > 0 ? `${summary}\n+${withheld} more in the app` : summary;
}

/**
 * The button this request was offered under, if it was offered one at all.
 *
 * Recomputed from the request rather than read off the tap, so an answer from a
 * notification can only be one this request actually put on a lock screen.
 */
export function offeredNotificationAction(
    request: ConfirmationRequest,
    optionId: string,
): { id: string; label: string } | undefined {
    return notificationActions(request)?.find(action => action.id === optionId);
}

/** Trim the body until the encoded envelope fits the smallest push service budget. */
function encodePayload(payload: PushPayload): string {
    let body = payload.body;
    let encoded = JSON.stringify({ ...payload, body });
    while (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES && body.length > 0) {
        body = body.slice(0, Math.floor(body.length * 0.8));
        encoded = JSON.stringify({ ...payload, body: `${body}…` });
    }
    return encoded;
}

async function send(userId: number, payload: PushPayload, ttl: number, urgent: boolean): Promise<void> {
    const subs = await db.select().from(PushSubscription).where(eq(PushSubscription.userId, userId));
    if (subs.length === 0) return;

    const keys = await loadOrCreateKeys(userId);
    const encoded = encodePayload(payload);

    await Promise.all(subs.map(async (sub) => {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                encoded,
                {
                    vapidDetails: { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
                    TTL: ttl,
                    urgency: urgent ? 'high' : 'normal',
                },
            );
            await db.update(PushSubscription).set({ lastNotifiedAt: new Date() }).where(eq(PushSubscription.id, sub.id));
        } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            // The browser dropped this subscription; it will never accept another message.
            if (status === 404 || status === 410) {
                await db.delete(PushSubscription).where(eq(PushSubscription.id, sub.id));
                log.info({ label: sub.label }, 'Pruned expired push subscription');
                return;
            }
            log.warn({ err, status, label: sub.label }, 'Push delivery failed');
        }
    }));
}

/**
 * Notify without ever disturbing the caller: these fire from inside the run loop, where a
 * push failure must not become a failed run. The returned promise is already settled
 * against failure, so ignoring it is safe — the run loop does exactly that.
 */
export function pushConfirmationRequest(userId: number, request: ConfirmationRequest, conversationId: string): Promise<void> {
    const actions = notificationActions(request);
    return send(userId, {
        title: 'Pipali needs your approval',
        body: confirmationBody(request, actions),
        conversationId,
        tag: `confirmation:${request.requestId}`,
        requestId: request.requestId,
        actions,
    }, TTL_SECONDS.confirmation, true).catch((err) => log.warn({ err }, 'Confirmation push failed'));
}

export function pushRunComplete(userId: number, summary: string, conversationId: string): Promise<void> {
    return send(userId, {
        title: 'Pipali finished',
        body: truncate(summary, SUMMARY_CHARS),
        conversationId,
        tag: `complete:${conversationId}`,
    }, TTL_SECONDS.complete, false).catch((err) => log.warn({ err }, 'Completion push failed'));
}

export const __test__ = { encodePayload, MAX_PAYLOAD_BYTES };
