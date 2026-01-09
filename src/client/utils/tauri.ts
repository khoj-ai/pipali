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
    // Try Tauri opener plugin first (only available in Tauri webview)
    if (isTauri()) {
        try {
            const { openUrl } = await import('@tauri-apps/plugin-opener');
            await openUrl(url);
            return;
        } catch {
            // Fall through to window.open
        }
    }

    if (isDesktopMode() || options?.newTab) {
        // Desktop mode or explicit new tab - open in system browser
        window.open(url, '_blank', 'noopener,noreferrer');
    } else {
        // Web mode - redirect in same window
        window.location.href = url;
    }
}
