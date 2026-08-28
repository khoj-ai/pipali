/**
 * Web Push, from the browser's side.
 *
 * Subscribing is the whole pairing step: the browser mints a subscription bound to this
 * install's VAPID key and hands it to the desktop app, which can then reach this device
 * through the browser's push service even with the app closed. A notification travels
 * over the device's own connection, so it lands whether or not the device can currently
 * reach the server — only acting on it does.
 */

import { apiFetch } from './api';

export type PushDevice = {
    id: number;
    label: string;
    createdAt: string;
    lastNotifiedAt: string | null;
};

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

export function isPushSupported(): boolean {
    return typeof navigator !== 'undefined'
        && 'serviceWorker' in navigator
        && typeof window !== 'undefined'
        && 'PushManager' in window
        && 'Notification' in window;
}

/** applicationServerKey wants raw bytes, but the server speaks base64url. */
function decodeVapidKey(base64url: string): Uint8Array<ArrayBuffer> {
    const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=');
    const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function registerWorker(): Promise<ServiceWorkerRegistration> {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return navigator.serviceWorker.ready;
}

/**
 * The worker runs while the app is closed, so keeping it registered belongs to startup
 * rather than to the notification toggle that happens to need one.
 *
 * Keeping it *current* belongs here too. The browser only re-fetches a worker on
 * navigation or once a day, and a phone left on this app navigates neither - so an old
 * worker can go on answering approvals against a contract this server has moved past.
 * Coming back to the app is the moment to check, and is as often as it is worth checking.
 */
export function ensureServiceWorker(): void {
    if (!isPushSupported()) return;

    const refresh = (registration: ServiceWorkerRegistration) => {
        void registration.update().catch(() => {
            // Offline, most likely. The next return to the app tries again.
        });
    };

    void registerWorker().then(registration => {
        refresh(registration);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refresh(registration);
        });
    }).catch(() => {
        // An unavailable worker only costs notifications, never the app.
    });
}

export async function getPushState(): Promise<PushState> {
    if (!isPushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    return subscription ? 'on' : 'off';
}

/**
 * Must be called straight from a click: a permission prompt not tied to a user gesture is
 * refused, resolving to 'default' without ever appearing.
 */
export async function enablePush(): Promise<PushState> {
    if (!isPushSupported()) return 'unsupported';

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

    const registration = await registerWorker();
    const { publicKey } = await (await apiFetch('/api/push/vapid-key')).json();

    // A subscription minted against an older key can never be delivered to, so replace
    // rather than reuse whatever is already there.
    const stale = await registration.pushManager.getSubscription();
    if (stale) await stale.unsubscribe();

    const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(publicKey),
    });

    const response = await apiFetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) {
        // Leaving it subscribed here but unknown to the desktop app would look enabled and
        // never deliver anything.
        await subscription.unsubscribe();
        throw new Error('Could not register this device for notifications');
    }
    return 'on';
}

export async function disablePush(): Promise<void> {
    if (!isPushSupported()) return;
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;

    // Tell the desktop app before dropping it locally, so it stops pushing into an endpoint
    // that is about to disappear.
    await apiFetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
}

export async function listPushDevices(): Promise<PushDevice[]> {
    const response = await apiFetch('/api/push/devices');
    if (!response.ok) return [];
    return (await response.json()).devices ?? [];
}

export async function forgetPushDevice(id: number): Promise<void> {
    await apiFetch(`/api/push/devices/${id}`, { method: 'DELETE' });
}
