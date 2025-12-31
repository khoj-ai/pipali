/**
 * API client utilities for making requests to the Panini server.
 *
 * In web mode, requests go to relative URLs (same origin).
 * In Tauri mode, requests go to the sidecar's localhost URL.
 */

let apiBaseUrl = "";

/**
 * Set the base URL for all API requests.
 * This is called once at app initialization with the sidecar URL.
 */
export function setApiBaseUrl(url: string) {
    apiBaseUrl = url;
}

/**
 * Get the current API base URL.
 */
export function getApiBaseUrl(): string {
    return apiBaseUrl;
}

/**
 * Make a fetch request to the API, prepending the base URL if configured.
 *
 * @param path - The API path (should start with /)
 * @param init - Fetch options
 * @returns Fetch response
 */
export function apiFetch(
    path: string,
    init?: RequestInit
): Promise<Response> {
    const url = `${apiBaseUrl}${path}`;
    return fetch(url, init);
}
