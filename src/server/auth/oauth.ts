/**
 * OAuth Flow for Panini App
 *
 * Handles the browser-based OAuth flow:
 * 1. Open the browser to the platform's OAuth page
 * 2. Platform redirects to our existing server's callback endpoint
 * 3. Poll for successful authentication
 * 4. Return success to the caller
 */

import { isAuthenticated, getPlatformUrl } from './index';
import type { OAuthFlowResult } from './types';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'oauth' });

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
 * Start the OAuth flow
 *
 * Opens a browser to the platform's OAuth page.
 * The callback will be handled by our existing server at /api/auth/callback.
 * This function polls for successful authentication.
 */
export async function startOAuthFlow(
    customPlatformUrl?: string,
    timeout: number = DEFAULT_TIMEOUT,
    serverPort: number = 6464
): Promise<OAuthFlowResult> {
    const platformUrl = customPlatformUrl || getPlatformUrl();

    log.info('Starting authentication flow...');

    // Build callback URL pointing to our existing server
    const callbackUrl = `http://localhost:${serverPort}/api/auth/callback`;
    log.debug({ callbackUrl }, 'Callback URL configured');

    // Build the OAuth URL
    const oauthUrl = `${platformUrl}/auth/oauth/google/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`;

    // Open the browser
    log.info('Opening browser for authentication...');
    log.debug({ url: oauthUrl }, 'OAuth URL');

    await openBrowser(oauthUrl);

    // Poll for successful authentication
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
