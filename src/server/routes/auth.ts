import { Hono } from 'hono';
import {
    isAnonMode,
    isAuthenticated,
    storeTokens,
    clearTokens,
    getPlatformUserInfo,
    getPlatformUrl,
    syncPlatformModels,
    syncPlatformWebTools,
} from '../auth';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'auth' });
const auth = new Hono();

// OAuth callback - serves a page that extracts tokens from URL fragment
// Tokens are passed via fragment (#) instead of query params (?) for security:
// - Fragments are never sent to the server in HTTP requests
// - Fragments are not logged in server access logs
// - Fragments are not sent in Referer headers
auth.get('/callback', async (c) => {
    const error = c.req.query('error');

    if (error) {
        log.error({ error }, 'OAuth callback error');
        return c.html(getAuthErrorHtml(error));
    }

    // Return a page that extracts tokens from fragment and POSTs to /complete
    return c.html(getTokenExtractorHtml());
});

// Complete OAuth - receives tokens via POST body (more secure than URL)
auth.post('/complete', async (c) => {
    try {
        const body = await c.req.json();
        const { accessToken, refreshToken, expiresIn, desktopAuth } = body;

        if (!accessToken || !refreshToken) {
            log.error('Missing tokens in completion request');
            return c.json({ error: 'Missing authentication tokens' }, 400);
        }

        // Calculate expiry
        const expiresAt = expiresIn
            ? new Date(Date.now() + parseInt(expiresIn, 10) * 1000)
            : new Date(Date.now() + 15 * 60 * 1000); // Default 15 minutes

        // Store tokens
        await storeTokens({ accessToken, refreshToken, expiresAt });
        log.info('Tokens stored successfully');

        // Sync platform models and web tools in background
        syncPlatformModels().catch(err => log.error({ err }, 'Failed to sync platform models'));
        syncPlatformWebTools().catch(err => log.error({ err }, 'Failed to sync platform web tools'));

        // For desktop auth, return a flag to show "close tab" message instead of redirecting
        if (desktopAuth) {
            return c.json({ success: true, desktopAuth: true });
        }

        return c.json({ success: true, redirectUrl: '/' });
    } catch (err) {
        log.error({ err }, 'Failed to complete authentication');
        return c.json({ error: 'Failed to complete authentication' }, 500);
    }
});

// Get current auth status
auth.get('/status', async (c) => {
    const anonMode = isAnonMode();
    const authenticated = await isAuthenticated();

    let userInfo = null;
    if (authenticated && !anonMode) {
        userInfo = await getPlatformUserInfo();
    }

    return c.json({
        anonMode,
        authenticated,
        user: userInfo,
    });
});

// Logout - clear stored tokens
auth.post('/logout', async (c) => {
    try {
        await clearTokens();
        log.info('User logged out');
        return c.json({ success: true });
    } catch (err) {
        log.error({ err }, 'Logout error');
        return c.json({ error: 'Failed to logout' }, 500);
    }
});

// Get OAuth URL for Google sign-in
auth.get('/oauth/google/url', async (c) => {
    const platformUrl = getPlatformUrl();
    const callbackUrl = c.req.query('callback_url') || `${new URL(c.req.url).origin}/api/auth/callback`;
    const oauthUrl = `${platformUrl}/auth/oauth/google/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`;
    return c.json({ url: oauthUrl });
});

// Get platform URL for email auth
auth.get('/platform-url', async (c) => {
    return c.json({ url: getPlatformUrl() });
});

// HTML templates for OAuth callback

/**
 * Returns HTML page that extracts tokens from URL fragment and POSTs to /complete.
 * This is more secure than receiving tokens in query params because:
 * - URL fragments are never sent to the server in HTTP requests
 * - They don't appear in server logs
 * - They're not included in Referer headers
 */
function getTokenExtractorHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Completing Authentication...</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: #0a0a0a;
            color: #fafafa;
        }
        .card {
            background: #171717;
            padding: 3rem;
            border-radius: 1rem;
            border: 1px solid #262626;
            text-align: center;
            max-width: 400px;
        }
        .spinner {
            width: 48px;
            height: 48px;
            border: 3px solid #262626;
            border-top-color: #3b82f6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 1.5rem;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        h1 { color: #fafafa; margin: 0 0 0.5rem; font-size: 1.25rem; }
        p { color: #a1a1aa; margin: 0; font-size: 0.875rem; }
        .error { color: #f87171; margin-top: 1rem; display: none; }
        .success { display: none; }
        .success-icon {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            background: #22c55e;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 1.5rem;
        }
        .success-icon svg { width: 32px; height: 32px; color: white; }
    </style>
</head>
<body>
    <div class="card" id="loading">
        <div class="spinner" id="spinner"></div>
        <h1>Completing Authentication</h1>
        <p>Please wait...</p>
        <p class="error" id="error"></p>
    </div>
    <div class="card success" id="success">
        <div class="success-icon">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
            </svg>
        </div>
        <h1>Authentication Complete</h1>
        <p>You can close this tab and return to the Pipali app.</p>
    </div>
    <script>
        (function() {
            // Check if this is a desktop auth flow (query param indicates desktop app)
            const urlParams = new URLSearchParams(window.location.search);
            const isDesktopAuth = urlParams.get('desktop') === '1';

            // Parse tokens from URL fragment (after #)
            // Fragments are never sent to the server, providing better security
            const hash = window.location.hash.substring(1);
            const params = new URLSearchParams(hash);

            // Check for errors first
            const error = params.get('error');
            if (error) {
                document.getElementById('spinner').style.display = 'none';
                document.getElementById('error').style.display = 'block';
                document.getElementById('error').textContent = decodeURIComponent(error);
                return;
            }

            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');
            const expiresIn = params.get('expires_in');

            if (!accessToken || !refreshToken) {
                document.getElementById('spinner').style.display = 'none';
                document.getElementById('error').style.display = 'block';
                document.getElementById('error').textContent = 'Missing authentication tokens. Please try again.';
                return;
            }

            // POST tokens to server
            fetch('/api/auth/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accessToken: accessToken,
                    refreshToken: refreshToken,
                    expiresIn: expiresIn ? parseInt(expiresIn, 10) : null,
                    desktopAuth: isDesktopAuth
                })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    if (data.desktopAuth) {
                        // Desktop auth - show success message, user should return to app
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('success').style.display = 'block';
                    } else if (data.redirectUrl) {
                        // Web auth - redirect to app
                        window.location.replace(data.redirectUrl);
                    }
                } else {
                    throw new Error(data.error || 'Authentication failed');
                }
            })
            .catch(err => {
                document.getElementById('spinner').style.display = 'none';
                document.getElementById('error').style.display = 'block';
                document.getElementById('error').textContent = err.message || 'Authentication failed. Please try again.';
            });
        })();
    </script>
</body>
</html>`;
}

function getAuthErrorHtml(error: string): string {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Authentication Failed</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: #0a0a0a;
            color: #fafafa;
        }
        .card {
            background: #171717;
            padding: 3rem;
            border-radius: 1rem;
            border: 1px solid #262626;
            text-align: center;
            max-width: 400px;
        }
        .icon {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: #ef4444;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 1.5rem;
        }
        .icon svg { width: 40px; height: 40px; color: white; }
        h1 { color: #fafafa; margin: 0 0 1rem; font-size: 1.5rem; }
        p { color: #a1a1aa; margin: 0; line-height: 1.6; }
        .error {
            background: #1c1917;
            border: 1px solid #991b1b;
            border-radius: 0.5rem;
            padding: 1rem;
            margin-top: 1rem;
            color: #fca5a5;
            font-size: 0.875rem;
        }
        a {
            display: inline-block;
            margin-top: 1.5rem;
            padding: 0.75rem 1.5rem;
            background: #262626;
            color: #fafafa;
            text-decoration: none;
            border-radius: 0.5rem;
        }
        a:hover { background: #363636; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
        </div>
        <h1>Authentication Failed</h1>
        <p>Something went wrong during authentication.</p>
        <div class="error">${error}</div>
        <a href="/login">Try Again</a>
    </div>
</body>
</html>`;
}

export default auth;
