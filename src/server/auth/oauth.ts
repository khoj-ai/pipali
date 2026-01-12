/**
 * Browser-based Authentication Flows for Pipali App
 *
 * Handles authentication flows that open the browser:
 * 1. Open the browser to the platform's auth page (OAuth or email login/signup)
 * 2. Platform redirects to our existing server's callback endpoint with tokens in URL fragment
 * 3. Poll for successful authentication
 * 4. Return success to the caller
 */

import { isAuthenticated, getPlatformUrl } from './index';
import type { OAuthFlowResult } from './types';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'auth-flow' });

// Timeout for OAuth flow (5 minutes)
const DEFAULT_TIMEOUT = 5 * 60 * 1000;
// Poll interval for checking auth status
const POLL_INTERVAL = 1000;

/**
 * Open a URL in the default browser
 */
async function openBrowser(url: string): Promise<void> {
    const platform = process.platform;

    let command: string[];
    if (platform === 'darwin') {
        command = ['open', url];
    } else if (platform === 'win32') {
        command = ['cmd', '/c', 'start', '', url];
    } else {
        // Linux and others
        command = ['xdg-open', url];
    }

    const proc = Bun.spawn(command, {
        stdout: 'ignore',
        stderr: 'ignore',
    });

    await proc.exited;
}

/**
 * Poll for successful authentication
 * Shared by all auth flows that open the browser
 */
async function pollForAuthentication(timeout: number): Promise<OAuthFlowResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        // Check if we're now authenticated
        const authenticated = await isAuthenticated();
        if (authenticated) {
            log.info('Authentication successful!');
            return { success: true };
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }

    log.error('Authentication timed out');
    return {
        success: false,
        error: 'Authentication timed out. Please try again.',
    };
}

/**
 * Start the Google OAuth flow
 *
 * Opens a browser to the platform's Google OAuth page.
 * The callback will be handled by our existing server at /api/auth/callback.
 * This function polls for successful authentication.
 */
export async function startOAuthFlow(
    customPlatformUrl?: string,
    timeout: number = DEFAULT_TIMEOUT,
    serverPort: number = 6464
): Promise<OAuthFlowResult> {
    const platformUrl = customPlatformUrl || getPlatformUrl();

    log.info('Starting Google OAuth flow...');

    // Build callback URL pointing to our existing server
    const callbackUrl = `http://localhost:${serverPort}/api/auth/callback`;
    log.debug({ callbackUrl }, 'Callback URL configured');

    // Build the OAuth URL
    const oauthUrl = `${platformUrl}/auth/oauth/google/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`;

    // Open the browser
    log.info('Opening browser for Google authentication...');
    log.debug({ url: oauthUrl }, 'OAuth URL');

    await openBrowser(oauthUrl);

    return pollForAuthentication(timeout);
}

/**
 * Start the email login flow
 *
 * Opens a browser to the platform's login page with redirect_uri.
 * After login, the platform redirects to our callback with tokens in URL fragment.
 * This function polls for successful authentication.
 */
export async function startEmailLoginFlow(
    customPlatformUrl?: string,
    timeout: number = DEFAULT_TIMEOUT,
    serverPort: number = 6464
): Promise<OAuthFlowResult> {
    const platformUrl = customPlatformUrl || getPlatformUrl();

    log.info('Starting email login flow...');

    // Build callback URL pointing to our existing server
    // Add desktop=1 to indicate this is a desktop app flow (shows "close tab" message)
    const callbackUrl = `http://localhost:${serverPort}/api/auth/callback?desktop=1`;
    log.debug({ callbackUrl }, 'Callback URL configured');

    // Build the login URL with redirect_uri
    const loginUrl = `${platformUrl}/login?redirect_uri=${encodeURIComponent(callbackUrl)}`;

    // Open the browser
    log.info('Opening browser for email login...');
    log.debug({ url: loginUrl }, 'Login URL');

    await openBrowser(loginUrl);

    return pollForAuthentication(timeout);
}

/**
 * Start the email signup flow
 *
 * Opens a browser to the platform's signup page with redirect_uri.
 * After signup and email verification, the platform redirects to our callback with tokens.
 * This function polls for successful authentication.
 */
export async function startEmailSignupFlow(
    customPlatformUrl?: string,
    timeout: number = DEFAULT_TIMEOUT,
    serverPort: number = 6464
): Promise<OAuthFlowResult> {
    const platformUrl = customPlatformUrl || getPlatformUrl();

    log.info('Starting email signup flow...');

    // Build callback URL pointing to our existing server
    // Add desktop=1 to indicate this is a desktop app flow (shows "close tab" message)
    const callbackUrl = `http://localhost:${serverPort}/api/auth/callback?desktop=1`;
    log.debug({ callbackUrl }, 'Callback URL configured');

    // Build the signup URL with redirect_uri
    const signupUrl = `${platformUrl}/signup?redirect_uri=${encodeURIComponent(callbackUrl)}`;

    // Open the browser
    log.info('Opening browser for email signup...');
    log.debug({ url: signupUrl }, 'Signup URL');

    await openBrowser(signupUrl);

    return pollForAuthentication(timeout);
}
