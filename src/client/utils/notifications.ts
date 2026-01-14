/**
 * Notification utilities for Pipali.
 * Uses Web Notification API for both Tauri desktop app and browser.
 * Triggers notifications when user attention is required and the app window is not focused.
 */

import { isTauri } from './tauri';
import type { ConfirmationRequest } from '../../server/processor/confirmation/confirmation.types';

let notificationPermissionGranted: boolean | null = null;

// Track active web notifications for cleanup
const activeWebNotifications: Map<string, Notification> = new Map();

// Pending conversation ID to navigate to when window gains focus (for Tauri notification click workaround)
let pendingNavigationConversationId: string | null = null;

// Callback for when a notification is clicked (used for navigation)
type NotificationClickHandler = (conversationId: string) => void;
let notificationClickHandler: NotificationClickHandler | null = null;

// Track if we've set up the focus listener
let focusListenerSetup = false;

/**
 * Register a handler for notification clicks.
 * The handler receives the conversation ID associated with the notification.
 */
export function setNotificationClickHandler(handler: NotificationClickHandler | null): void {
    notificationClickHandler = handler;
}

/**
 * Send a web notification using the Web Notification API.
 * @param tag - Unique identifier for the notification (prevents duplicates with same tag)
 * @param title - Notification title
 * @param body - Notification body text
 * @param conversationId - Optional conversation ID for navigation on click
 * @returns The created Notification or null if failed
 */
function sendWebNotification(tag: string, title: string, body: string, conversationId?: string): Notification | null {
    if (!('Notification' in window) || !notificationPermissionGranted) {
        return null;
    }

    try {
        const notification = new Notification(title, {
            body,
            icon: '/icons/pipali_128.png',
            tag,
        });

        notification.onclick = async () => {
            // Focus the window (handles both Tauri and web)
            await focusAppWindow();
            notification.close();
            activeWebNotifications.delete(tag);
            // Navigate to the conversation if handler is registered
            if (conversationId && notificationClickHandler) {
                notificationClickHandler(conversationId);
            }
        };

        notification.onclose = () => {
            activeWebNotifications.delete(tag);
        };

        activeWebNotifications.set(tag, notification);
        return notification;
    } catch (err) {
        console.warn('[notifications] Failed to create web notification:', err);
        return null;
    }
}

/**
 * Check if the app tab/window is currently visible to the user.
 */
export function isWindowFocused(): boolean {
    // Check both visibility state and focus
    // When window is hidden to tray, visibilityState should be 'hidden'
    const isVisible = document.visibilityState === 'visible';
    const hasFocus = document.hasFocus();
    return isVisible && hasFocus;
}

/**
 * Initialize notification permissions.
 * Call this once when the app starts.
 */
export async function initNotifications(): Promise<boolean> {
    // Tauri path - use native notifications
    if (isTauri()) {
        try {
            const { isPermissionGranted, requestPermission } =
                await import('@tauri-apps/plugin-notification');

            let granted = await isPermissionGranted();

            if (!granted) {
                const result = await requestPermission();
                granted = result === 'granted';
            }

            notificationPermissionGranted = granted;
            return granted;
        } catch (err) {
            console.warn('[notifications] Failed to initialize Tauri notifications:', err);
            return false;
        }
    }

    // Web path - use Web Notification API
    if (!('Notification' in window)) {
        console.warn('[notifications] Web Notification API not supported');
        notificationPermissionGranted = false;
        return false;
    }

    if (Notification.permission === 'granted') {
        notificationPermissionGranted = true;
        return true;
    }

    if (Notification.permission === 'denied') {
        notificationPermissionGranted = false;
        return false;
    }

    // Permission is 'default' - request permission
    try {
        const result = await Notification.requestPermission();
        notificationPermissionGranted = result === 'granted';
        return notificationPermissionGranted;
    } catch (err) {
        console.warn('[notifications] Failed to request web notification permission:', err);
        notificationPermissionGranted = false;
        return false;
    }
}

/**
 * Send a notification for a confirmation request.
 * In Tauri, uses native notifications with focus-based navigation workaround.
 * In browser, uses Web Notification API with onclick handler.
 * Only sends if window is not focused.
 *
 * @param request - The confirmation request
 * @param conversationTitle - Optional title for context in the notification
 * @param conversationId - The conversation ID to navigate to when notification is clicked
 */
export async function notifyConfirmationRequest(
    request: ConfirmationRequest,
    conversationTitle?: string,
    conversationId?: string
): Promise<void> {
    // Don't notify if window is focused - user can see the toast
    if (isWindowFocused()) {
        return;
    }

    // Check permissions (lazy init)
    if (notificationPermissionGranted === null) {
        await initNotifications();
    }

    if (!notificationPermissionGranted) {
        return;
    }

    // Build notification content
    const title = request.operation === 'ask_user'
        ? 'Question from Pipali'
        : 'Action Required';

    const body = conversationTitle
        ? `${conversationTitle}: ${request.title}`
        : request.title;

    // Tauri path - use native notifications with pending navigation
    if (isTauri() && conversationId) {
        try {
            const { sendNotification } = await import('@tauri-apps/plugin-notification');
            // Tauri notification onclick doesn't work (known limitation),
            // so we store the conversation ID and navigate when the app regains focus
            sendNotification({ title, body });
            pendingNavigationConversationId = conversationId;
        } catch (err) {
            console.warn('[notifications] Failed to send Tauri notification:', err);
        }
        return;
    }

    // Web/Tauri fallback path - use Web Notification API with onclick handler
    const tag = `confirmation-${request.requestId}`;
    sendWebNotification(tag, title, body, conversationId);
}

/**
 * Send a notification when a task completes.
 * Uses native OS notifications in Tauri, or Web Notification API in browser.
 * Only sends if window is not focused.
 *
 * @param userRequest - The original user request/query
 * @param responseSnippet - A snippet of the agent's response
 * @param conversationId - The conversation ID to navigate to when notification is clicked
 */
export async function notifyTaskComplete(
    userRequest?: string,
    responseSnippet?: string,
    conversationId?: string
): Promise<void> {
    // Don't notify if window is focused - user can see the result
    if (isWindowFocused()) {
        return;
    }

    // Check permissions (lazy init)
    if (notificationPermissionGranted === null) {
        await initNotifications();
    }

    if (!notificationPermissionGranted) {
        return;
    }

    // Build notification content
    const title = userRequest
        ? truncate(userRequest, 50)
        : 'Task Complete';

    const body = responseSnippet
        ? truncate(responseSnippet, 100)
        : 'Your task has finished';

    // Use Web Notification API directly (allows onclick handlers for navigation)
    const tag = `task-complete-${Date.now()}`;
    sendWebNotification(tag, title, body, conversationId);
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
function truncate(text: string, maxLength: number): string {
    // Normalize whitespace (collapse newlines and multiple spaces)
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return normalized.slice(0, maxLength - 1) + '…';
}

/**
 * Focus the app window.
 * In Tauri, uses the focus_window command to properly show window and add to dock.
 * In browser, uses window.focus().
 */
export async function focusAppWindow(): Promise<void> {
    // Tauri path - use focus_window command which handles dock visibility
    if (isTauri()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('focus_window');
        } catch (err) {
            console.warn('[notifications] Failed to focus Tauri window:', err);
        }
        return;
    }

    // Web path - focus the browser window/tab
    window.focus();
}

/**
 * Check if there's a pending conversation to navigate to and consume it.
 * Returns the conversation ID if one was pending, null otherwise.
 */
function consumePendingNavigation(): string | null {
    const convId = pendingNavigationConversationId;
    pendingNavigationConversationId = null;
    return convId;
}

/**
 * Setup a listener for window focus events to handle pending navigation.
 * When the app gains focus after a Tauri notification was clicked, this will
 * call the notification click handler with the pending conversation ID.
 *
 * This is a workaround for Tauri's notification onclick not working.
 */
export function setupFocusNavigationListener(): void {
    if (focusListenerSetup) {
        return;
    }
    focusListenerSetup = true;

    // Listen for visibility change (works when app comes to foreground)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const convId = consumePendingNavigation();
            if (convId && notificationClickHandler) {
                // Small delay to ensure the window is fully focused
                setTimeout(() => {
                    notificationClickHandler?.(convId);
                }, 100);
            }
        }
    });

    // Also listen for window focus (backup)
    window.addEventListener('focus', () => {
        const convId = consumePendingNavigation();
        if (convId && notificationClickHandler) {
            setTimeout(() => {
                notificationClickHandler?.(convId);
            }, 100);
        }
    });
}

