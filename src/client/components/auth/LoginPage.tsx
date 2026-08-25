import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiFetch, getApiBaseUrl } from '../../utils/api';
import { getDeviceFingerprint, isDesktopMode, openInBrowser } from '../../utils/tauri';

interface AuthCapabilities {
    emailEnabled: boolean;
    googleEnabled: boolean;
}

interface LoginPageProps {
    onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(false);
    const [isWaitingForAuth, setIsWaitingForAuth] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [authCapabilities, setAuthCapabilities] = useState<AuthCapabilities | null>(null);
    const logoUrl = `${getApiBaseUrl()}/icons/pipali_128.png`;
    const isDesktop = isDesktopMode();

    // Fetch auth capabilities from platform on mount
    useEffect(() => {
        apiFetch('/api/auth/config')
            .then(res => res.ok ? res.json() : Promise.reject())
            .then(setAuthCapabilities)
            .catch(() => {
                // Default to showing all options if fetch fails
                setAuthCapabilities({ emailEnabled: true, googleEnabled: true });
            });
    }, []);

    // Poll for auth status when waiting for external browser auth
    const checkAuthStatus = useCallback(async () => {
        try {
            const res = await apiFetch('/api/auth/status');
            if (res.ok) {
                const data = await res.json();
                if (data.authenticated) {
                    setIsWaitingForAuth(false);
                    onLoginSuccess();
                    return true;
                }
            }
        } catch (err) {
            console.error('[LoginPage] Auth status poll error:', err);
        }
        return false;
    }, [onLoginSuccess]);

    // Poll for auth completion when user is signing in via external browser
    useEffect(() => {
        if (!isWaitingForAuth) return;

        const interval = setInterval(async () => {
            const authenticated = await checkAuthStatus();
            if (authenticated) {
                clearInterval(interval);
            }
        }, 2000); // Poll every 2 seconds

        return () => clearInterval(interval);
    }, [isWaitingForAuth, checkAuthStatus]);

    // Each sign-in is bound to a state the server minted, so a page that frames the callback
    // cannot complete a sign-in we never started.
    const buildCallbackUrl = async (): Promise<string> => {
        const res = await apiFetch('/api/auth/state', { method: 'POST' });
        if (!res.ok) {
            throw new Error('Failed to start sign-in');
        }
        const { state } = await res.json();
        const params = new URLSearchParams({ state });
        if (isDesktop) {
            params.set('desktop', '1');
        }
        const baseUrl = getApiBaseUrl() || window.location.origin;
        return `${baseUrl}/api/auth/callback?${params.toString()}`;
    };

    const handleGoogleSignIn = async () => {
        setIsLoading(true);
        setError(null);

        try {
            const callbackUrl = await buildCallbackUrl();

            // Get the OAuth URL from the server with custom callback
            const deviceFingerprint = await getDeviceFingerprint();
            const oauthUrlQuery = new URLSearchParams({ callback_url: callbackUrl });
            if (deviceFingerprint) {
                oauthUrlQuery.set('device_fingerprint', deviceFingerprint);
            }
            const res = await apiFetch(`/api/auth/oauth/google/url?${oauthUrlQuery.toString()}`);
            if (!res.ok) {
                throw new Error('Failed to get OAuth URL');
            }
            const { url } = await res.json();

            // In desktop mode, open in system browser and poll for completion
            if (isDesktop) {
                await openInBrowser(url);
                setIsLoading(false);
                setIsWaitingForAuth(true);
            } else {
                // Web mode - redirect in same window
                window.location.href = url;
            }
        } catch (err) {
            console.error('Google sign-in error:', err);
            setError(t('auth.googleSignInError'));
            setIsLoading(false);
        }
    };

    const handleEmailSignIn = async () => {
        setIsLoading(true);
        setError(null);

        try {
            // Get the platform URL and redirect to platform login
            const res = await apiFetch('/api/auth/platform-url');
            if (!res.ok) {
                throw new Error('Failed to get platform URL');
            }
            const { url } = await res.json();

            const callbackUrl = await buildCallbackUrl();

            // Build full login URL with source=app to distinguish from direct platform login
            const loginUrl = `${url}/login?redirect_uri=${encodeURIComponent(callbackUrl)}&source=app`;

            // In desktop mode, open in system browser and poll for completion
            if (isDesktop) {
                await openInBrowser(loginUrl);
                setIsLoading(false);
                setIsWaitingForAuth(true);
            } else {
                // Web mode - redirect in same window
                window.location.href = loginUrl;
            }
        } catch (err) {
            console.error('Email sign-in error:', err);
            setError(t('auth.emailSignInError'));
            setIsLoading(false);
        }
    };

    // Show waiting state when authenticating in external browser
    if (isWaitingForAuth) {
        return (
            <div className="login-page">
                <div className="login-card">
                    <div className="login-header">
                        <div className="login-logo">
                            <img src={logoUrl} alt={t('common.pipali')} width="64" height="64" />
                        </div>
                        <h1>{t('auth.completeSignIn')}</h1>
                        <p>{t('auth.finishSignInBrowser')}</p>
                    </div>

                    <div className="login-waiting">
                        <Loader2 size={32} className="spinning" />
                        <p>{t('auth.waitingForAuth')}</p>
                    </div>

                    <div className="login-buttons">
                        <button
                            className="login-btn secondary"
                            onClick={() => setIsWaitingForAuth(false)}
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-header">
                    <div className="login-logo">
                        <img src={logoUrl} alt={t('common.pipali')} width="64" height="64" />
                    </div>
                    <h1>{t('auth.welcome')}</h1>
                    <p>{t('auth.signInToContinue')}</p>
                </div>

                {error && (
                    <div className="login-error">
                        {error}
                    </div>
                )}

                <div className="login-buttons">
                    {authCapabilities?.googleEnabled && (
                        <button
                            className="login-btn google"
                            onClick={handleGoogleSignIn}
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <Loader2 size={20} className="spinning" />
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24">
                                    <path
                                        fill="currentColor"
                                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                    />
                                </svg>
                            )}
                            <span>{t('auth.continueWithGoogle')}</span>
                        </button>
                    )}

                    {authCapabilities?.googleEnabled && authCapabilities?.emailEnabled && (
                        <div className="login-divider">
                            <span>{t('common.or')}</span>
                        </div>
                    )}

                    {authCapabilities?.emailEnabled && (
                        <button
                            className="login-btn email"
                            onClick={handleEmailSignIn}
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <Loader2 size={20} className="spinning" />
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="2" y="4" width="20" height="16" rx="2" />
                                    <path d="M22 7l-10 6L2 7" />
                                </svg>
                            )}
                            <span>{t('auth.continueWithEmail')}</span>
                        </button>
                    )}
                </div>

                <div className="login-footer">
                    <p>
                        {t('auth.termsNotice')}
                    </p>
                </div>
            </div>
        </div>
    );
}
