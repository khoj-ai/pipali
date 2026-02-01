/**
 * Tauri-specific utilities for desktop app integration.
 * These utilities detect if running in Tauri and provide platform-specific functionality.
 */

import { getApiBaseUrl } from './api';

/**
 * Check if the app is running inside the Tauri desktop app.
 * In Tauri v2, uses window.__TAURI_INTERNALS__ (v1 used __TAURI__).
 */
export function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Check if the app is running in desktop/sidecar mode.
 * This is true when the app communicates with a sidecar server (desktop app)
 * rather than being served directly by the same server (web mode).
 */
export function isDesktopMode(): boolean {
    // If apiBaseUrl is set, we're in sidecar mode (desktop app)
    return !!getApiBaseUrl();
}

/**
 * Open a URL in the system's default browser.
 * In Tauri v2, uses the opener plugin. In desktop mode without Tauri IPC, uses window.open.
 * In web mode, can either redirect or open in new tab based on options.
 *
 * @param url - The URL to open
 * @param options - Options for opening the URL
 */
export async function openInBrowser(url: string, options?: { newTab?: boolean }): Promise<void> {
    console.log('[openInBrowser] Opening URL:', url, { isTauri: isTauri(), isDesktop: isDesktopMode() });

    // Try Tauri opener plugin first (only available in Tauri webview)
    if (isTauri()) {
        try {
            const { openUrl } = await import('@tauri-apps/plugin-opener');
            console.log('[openInBrowser] Using Tauri opener plugin...');
            await openUrl(url);
            console.log('[openInBrowser] Tauri opener succeeded');
            return;
        } catch (err) {
            console.warn('[openInBrowser] Tauri opener failed, falling back to window.open:', err);
            // Fall through to window.open
        }
    }

    if (isDesktopMode() || options?.newTab) {
        // Desktop mode or explicit new tab - open in system browser
        console.log('[openInBrowser] Using window.open...');
        const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
        if (!newWindow) {
            console.warn('[openInBrowser] window.open returned null (popup blocked?)');
        }
    } else {
        // Web mode - redirect in same window
        console.log('[openInBrowser] Redirecting in same window...');
        window.location.href = url;
    }
}

/**
 * Listen for sidecar-ready events from Tauri.
 * This event is emitted when the sidecar server has passed its health check
 * and is ready to accept requests.
 *
 * @param callback - Function to call when the sidecar is ready
 * @returns Cleanup function to unsubscribe from the event
 */
export async function onSidecarReady(callback: () => void): Promise<() => void> {
    if (!isTauri()) {
        // In web mode, sidecar is always ready (we're served by the same server)
        callback();
        return () => {};
    }

    let called = false;
    const callOnce = () => {
        if (called) return;
        called = true;
        callback();
    };

    // Check if sidecar is already running (handles page refresh case)
    const apiBase = getApiBaseUrl();
    if (apiBase) {
        fetch(`${apiBase}/api/health`).then((res) => {
            if (res.ok) {
                console.log('[onSidecarReady] Sidecar already running');
                callOnce();
            }
        }).catch(() => {});
    }

    try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen('sidecar-ready', () => {
            console.log('[onSidecarReady] Sidecar ready event received');
            callOnce();
        });
        return unlisten;
    } catch (err) {
        console.warn('[onSidecarReady] Failed to setup listener:', err);
        callOnce();
        return () => {};
    }
}

/**
 * Listen for window-shown events from Tauri.
 * Used to focus the chat input when the app window is shown via shortcut or tray.
 *
 * @param callback - Function to call when the window is shown
 * @returns Cleanup function to unsubscribe from the event
 */
export async function onWindowShown(callback: () => void): Promise<() => void> {
    if (!isTauri()) {
        return () => {};
    }

    try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen('window-shown', () => {
            console.log('[onWindowShown] Window shown event received');
            callback();
        });
        return unlisten;
    } catch (err) {
        console.warn('[onWindowShown] Failed to setup listener:', err);
        return () => {};
    }
}

/**
 * Open a file with the system's default application.
 * In Tauri v2, uses the opener plugin's openPath function.
 * Only works in the desktop app - no-op in web mode.
 *
 * @param filePath - The file path to open (can be file:// URL or absolute path)
 * @returns true if the file was opened successfully, false otherwise
 */
export async function openFile(filePath: string): Promise<boolean> {
    // Convert file:// URL to a local filesystem path if needed
    let path = filePath;
    if (filePath.startsWith('file://')) {
        try {
            const url = new URL(filePath);
            // Typical macOS file URLs are file:///Users/...
            // URL.pathname is already decoded for most characters, but keep it explicit.
            path = decodeURIComponent(url.pathname);
            // Windows drive paths come through as /C:/Users/...; strip the leading slash.
            if (/^\/[a-zA-Z]:\//.test(path)) {
                path = path.slice(1);
            }
        } catch {
            // Fallback: strip scheme prefix
            try {
                path = decodeURIComponent(filePath.replace(/^file:\/\//, ''));
            } catch {
                path = filePath.replace(/^file:\/\//, '');
            }
        }
    }

    // macOS: /tmp is a symlink to /private/tmp. Tauri checks the canonical path.
    if (path.startsWith('/tmp/')) {
        path = '/private' + path;
    }

    console.log('[openFile] Opening file:', path, { isTauri: isTauri(), isDesktop: isDesktopMode() });

    if (!isTauri()) {
        console.warn('[openFile] Not in Tauri environment, cannot open file');
        return false;
    }

    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_file', { path });
        console.log('[openFile] File opened successfully');
        return true;
    } catch (err) {
        console.error('[openFile] Failed to open file:', err);
        return false;
    }
}

/**
 * Acquire a wake lock to prevent OS idle sleep.
 * Uses reference counting in Rust — safe to call multiple times for parallel tasks.
 */
export async function acquireWakeLock(): Promise<void> {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('acquire_wake_lock');
    } catch (err) {
        console.warn('[wakeLock] Failed to acquire:', err);
    }
}

/**
 * Release a wake lock. OS sleep is re-enabled when all tasks have released.
 */
export async function releaseWakeLock(): Promise<void> {
    if (!isTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('release_wake_lock');
    } catch (err) {
        console.warn('[wakeLock] Failed to release:', err);
    }
}

/**
 * Listen for deep link events from Tauri.
 * Deep links are custom URL schemes (e.g., pipali://chat/conversationId) that
 * can be used to navigate the app to specific locations.
 *
 * @param callback - Function to call when a deep link is received, with the URL string
 * @returns Cleanup function to unsubscribe from the event
 */
export async function listenForDeepLinks(callback: (url: string) => void): Promise<() => void> {
    if (!isTauri()) {
        return () => {};
    }

    try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen<string>('deep-link', (event) => {
            callback(event.payload);
        });
        return unlisten;
    } catch (err) {
        console.warn('[tauri] Failed to setup deep link listener:', err);
        return () => {};
    }
}
