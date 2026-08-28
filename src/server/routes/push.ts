/**
 * Web Push API Routes
 *
 * Subscribing is the whole pairing step: the browser mints a subscription bound to this
 * install's VAPID key, hands it here, and from then on this machine can reach that device
 * through the browser's push service.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db';
import { User } from '../db/schema';
import { eq } from 'drizzle-orm';
import { getDefaultUser } from '../utils';
import {
    getVapidPublicKey,
    saveSubscription,
    listSubscriptions,
    deleteSubscription,
    deleteSubscriptionByEndpoint,
    offeredNotificationAction,
} from '../push';
import { getBus } from '../events/conversation-event-bus';
import { resolveConfirmationOnBus } from './ws/confirmation-manager';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'push-routes' });

const push = new Hono();

const subscribeSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
    }),
});

/** A name the owner will recognise in Settings when deciding what to revoke. */
function describeDevice(userAgent: string): string {
    if (/iPhone/i.test(userAgent)) return 'iPhone';
    if (/iPad/i.test(userAgent)) return 'iPad';
    if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? 'Android phone' : 'Android tablet';
    if (/Macintosh/i.test(userAgent)) return 'Mac';
    if (/Windows/i.test(userAgent)) return 'Windows PC';
    if (/Linux/i.test(userAgent)) return 'Linux';
    return 'Device';
}

async function currentUser() {
    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    return user;
}

// The browser needs this before it can subscribe.
push.get('/vapid-key', async (c) => {
    const user = await currentUser();
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json({ publicKey: await getVapidPublicKey(user.id) });
});

push.post('/subscribe', zValidator('json', subscribeSchema), async (c) => {
    const user = await currentUser();
    if (!user) return c.json({ error: 'User not found' }, 404);

    const subscription = c.req.valid('json');
    const label = describeDevice(c.req.header('User-Agent') ?? '');
    try {
        await saveSubscription(user.id, subscription, label);
        return c.json({ ok: true, label });
    } catch (error) {
        log.error({ err: error }, 'Failed to save push subscription');
        return c.json({ error: 'Failed to save subscription' }, 500);
    }
});

push.post('/unsubscribe', zValidator('json', z.object({ endpoint: z.string().url() })), async (c) => {
    const user = await currentUser();
    if (!user) return c.json({ error: 'User not found' }, 404);

    await deleteSubscriptionByEndpoint(user.id, c.req.valid('json').endpoint);
    return c.json({ ok: true });
});

const answerSchema = z.object({
    conversationId: z.string().min(1),
    requestId: z.string().min(1),
    optionId: z.string().min(1),
});

/**
 * Answer a confirmation from the notification itself, without opening the app.
 *
 * The third door onto resolveConfirmationOnBus, alongside the WebSocket the dialog
 * answers on and the HTTP endpoint the routines page uses.
 *
 * A tap is taken only when it names a button this request was actually offered under.
 * "Don't ask again" never reaches a lock screen, so it cannot come back from one, and a
 * refusal sends them to the app instead - a worse tap and a far better outcome.
 */
push.post('/confirm', zValidator('json', answerSchema), async (c) => {
    const { conversationId, requestId, optionId } = c.req.valid('json');

    const bus = getBus(conversationId);
    const runHandle = bus?.activeRun;
    // A notification outlives the question it asked, so a stale tap is ordinary. Saying so
    // lets the phone show that rather than implying the command was approved.
    if (!bus || !runHandle) return c.json({ error: 'No longer waiting on an answer' }, 409);

    const pending = runHandle.pendingConfirmations.get(requestId);
    if (!pending) return c.json({ error: 'No longer waiting on an answer' }, 409);

    const offered = offeredNotificationAction(pending.request, optionId);
    if (!offered) {
        log.warn({ conversationId, requestId, optionId }, 'Refused a notification answer the notification never offered');
        return c.json({ error: 'That notification is out of date' }, 422);
    }

    const resolved = resolveConfirmationOnBus(bus, runHandle, {
        requestId,
        selectedOptionId: optionId,
        timestamp: new Date().toISOString(),
    });
    if (resolved.length === 0) return c.json({ error: 'No longer waiting on an answer' }, 409);

    log.info({ conversationId, requestId, optionId }, 'Confirmation answered from a notification');
    // Echoed back so the phone can show what the run took, rather than what it sent.
    return c.json({ ok: true, option: offered.label });
});

push.get('/devices', async (c) => {
    const user = await currentUser();
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json({ devices: await listSubscriptions(user.id) });
});

push.delete('/devices/:id', async (c) => {
    const user = await currentUser();
    if (!user) return c.json({ error: 'User not found' }, 404);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'Invalid device id' }, 400);

    await deleteSubscription(user.id, id);
    return c.json({ ok: true });
});

export default push;
