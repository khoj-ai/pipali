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
 * Shared CSS styles for auth pages matching the app's design system.
 * Supports both light and dark modes via prefers-color-scheme.
 */
function getAuthPageStyles(): string {
    return `
        :root {
            /* Light mode (default) */
            --color-bg: #fafafa;
            --color-bg-elevated: #ffffff;
            --color-bg-muted: #f5f5f5;
            --color-text: #1a1a1a;
            --color-text-secondary: #525252;
            --color-text-muted: #a3a3a3;
            --color-border: #e5e5e5;
            --color-accent: #1a1a1a;
            --color-success: #22c55e;
            --color-error: #ef4444;
            --color-error-bg: #fee2e2;
            --color-error-text: #991b1b;
            --color-error-border: #fca5a5;
            --shadow-md: 0 2px 6px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.06);
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --color-bg: #121212;
                --color-bg-elevated: #1e1e1e;
                --color-bg-muted: #2a2a2a;
                --color-text: #e0e0e0;
                --color-text-secondary: #a0a0a0;
                --color-text-muted: #707070;
                --color-border: #333333;
                --color-accent: #e0e0e0;
                --color-success: #4ade80;
                --color-error: #f87171;
                --color-error-bg: #450a0a;
                --color-error-text: #fca5a5;
                --color-error-border: #991b1b;
                --shadow-md: 0 2px 6px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.4);
            }
        }

        * {
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            margin: 0;
            padding: 0;
            background: var(--color-bg);
            color: var(--color-text);
            min-height: 100vh;
        }

        .page-header {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.25rem 1.5rem;
        }

        .page-header .brand {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .page-header img {
            width: 32px;
            height: 32px;
            border-radius: 6px;
        }

        .page-header .app-name {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--color-text);
        }

        .main-content {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 2rem 1.5rem;
        }

        .card {
            width: 100%;
            max-width: 400px;
            background: var(--color-bg-elevated);
            padding: 2.5rem;
            border-radius: 12px;
            border: 1px solid var(--color-border);
            text-align: center;
            box-shadow: var(--shadow-md);
        }

        h1 {
            font-size: 1.5rem;
            font-weight: 600;
            margin: 0 0 0.5rem;
            color: var(--color-text);
        }

        .subtitle {
            font-size: 0.9375rem;
            color: var(--color-text-secondary);
            margin: 0;
        }

        p {
            color: var(--color-text-secondary);
            margin: 0;
            line-height: 1.5;
        }
    `;
}

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
    <title>Pipali - Completing Authentication</title>
    <link rel="icon" type="image/png" href="/icons/pipali_64.png">
    <link rel="apple-touch-icon" href="/icons/pipali_128.png">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        ${getAuthPageStyles()}
        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid var(--color-border);
            border-top-color: var(--color-accent);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 1.5rem;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error { color: var(--color-error); margin-top: 1rem; display: none; }
        .success { display: none; }
        .status-icon {
            width: 48px;
            height: 48px;
            margin: 0 auto 1.5rem;
            display: block;
        }
        .status-icon.success-icon {
            color: var(--color-success);
        }
    </style>
</head>
<body>
    <header class="page-header">
        <div class="brand">
            <img src="/icons/pipali_128.png" alt="Pipali" />
            <span class="app-name">Pipali</span>
        </div>
    </header>
    <main class="main-content">
        <div class="card" id="loading">
            <div class="spinner" id="spinner"></div>
            <h1>Completing Authentication</h1>
            <p class="subtitle">Please wait...</p>
            <p class="error" id="error"></p>
        </div>
        <div class="card success" id="success">
            <svg class="status-icon success-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            <h1>Login successful</h1>
            <p class="subtitle">You can close this tab and return to the Pipali app.</p>
        </div>
    </main>
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
    <title>Pipali - Authentication Failed</title>
    <link rel="icon" type="image/png" href="/icons/pipali_64.png">
    <link rel="apple-touch-icon" href="/icons/pipali_128.png">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        ${getAuthPageStyles()}
        .status-icon {
            width: 48px;
            height: 48px;
            margin: 0 auto 1.5rem;
            display: block;
        }
        .status-icon.error-icon {
            color: var(--color-error);
        }
        .error-details {
            background: var(--color-error-bg);
            border: 1px solid var(--color-error-border);
            border-radius: 8px;
            padding: 1rem;
            margin-top: 1.5rem;
            color: var(--color-error-text);
            font-size: 0.875rem;
        }
        .btn {
            display: inline-block;
            margin-top: 1.5rem;
            padding: 0.75rem 1.5rem;
            background: var(--color-bg-muted);
            color: var(--color-text);
            text-decoration: none;
            border-radius: 8px;
            font-weight: 500;
            font-size: 0.9375rem;
            border: 1px solid var(--color-border);
            transition: background 150ms ease, border-color 150ms ease;
        }
        .btn:hover {
            background: var(--color-bg-elevated);
            border-color: var(--color-text-muted);
        }
    </style>
</head>
<body>
    <header class="page-header">
        <div class="brand">
            <img src="/icons/pipali_128.png" alt="Pipali" />
            <span class="app-name">Pipali</span>
        </div>
    </header>
    <main class="main-content">
        <div class="card">
            <svg class="status-icon error-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"></path>
            </svg>
            <h1>Authentication failed</h1>
            <p class="subtitle">Something went wrong during authentication.</p>
            <div class="error-details">${error}</div>
            <a href="/login" class="btn">Try Again</a>
        </div>
    </main>
</body>
</html>`;
}

export default auth;
