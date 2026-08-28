/**
 * Pipali service worker.
 *
 * The part of Pipali that runs with the app closed: it shows a notification when the app
 * server has something to say, answers a question straight from that notification's
 * buttons, and opens the right conversation when one is tapped. Deliberately no offline
 * cache — the app is useless without its server, so pretending otherwise would only
 * produce a shell that cannot do anything.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    // Subscriptions are userVisibleOnly, so every push must show something. Even a
    // malformed payload gets a notification rather than costing us the permission.
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }

    event.waitUntil(self.registration.showNotification(payload.title || 'Pipali', {
        body: payload.body || '',
        icon: '/icons/pipali_256.png',
        badge: '/icons/pipali_64.png',
        tag: payload.tag,
        renotify: Boolean(payload.tag),
        // Ignored where notification buttons are unsupported, which leaves the tap-through.
        actions: (payload.actions || []).map((a) => ({ action: a.id, title: a.label })),
        data: {
            conversationId: payload.conversationId,
            requestId: payload.requestId,
            tag: payload.tag,
        },
    }));
});

/**
 * Answer a question from the notification itself.
 *
 * Reaching the app server is the one step a device woken by a notification may not manage,
 * so every ending is reported - what was applied, or that nothing was. Silence reads as
 * approval.
 */
async function answerFromNotification(data, optionId) {
    let response;
    try {
        response = await fetch('/api/push/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                conversationId: data.conversationId,
                requestId: data.requestId,
                optionId,
            }),
        });
    } catch {
        // App server unreachable.
    }

    // Taken from the answer rather than assumed, so this says what the run took.
    const applied = response && response.ok
        ? await response.json().then(body => body.option).catch(() => undefined)
        : undefined;
    const movedOn = response && response.status === 409;

    await self.registration.showNotification(
        applied ? 'Pipali got your answer' : movedOn ? 'Pipali already moved on' : 'Pipali could not answer for you',
        {
            body: applied ? `Answered: ${applied}`
                : movedOn ? 'That question is no longer waiting.'
                    : 'Open Pipali to answer this one.',
            icon: '/icons/pipali_256.png',
            badge: '/icons/pipali_64.png',
            // The question's own tag, so this replaces it rather than stacking beneath it.
            tag: data.tag,
            data: { conversationId: data.conversationId },
        },
    );
}

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const data = event.notification.data || {};
    if (event.action && data.requestId) {
        event.waitUntil(answerFromNotification(data, event.action));
        return;
    }

    const conversationId = data.conversationId;
    const target = conversationId ? `/?conversationId=${encodeURIComponent(conversationId)}` : '/';

    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // Reuse an already-open window rather than stacking copies of the same app.
        for (const client of windows) {
            if (!('focus' in client)) continue;
            await client.focus();
            if (conversationId && 'navigate' in client) await client.navigate(target);
            return;
        }
        await self.clients.openWindow(target);
    })());
});
