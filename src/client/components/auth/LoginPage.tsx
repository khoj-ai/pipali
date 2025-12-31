import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch, getApiBaseUrl } from '../../utils/api';

interface LoginPageProps {
    onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleGoogleSignIn = async () => {
        setIsLoading(true);
        setError(null);

        try {
            // Get the OAuth URL from the server
            const res = await apiFetch('/api/auth/oauth/google/url');
            if (!res.ok) {
                throw new Error('Failed to get OAuth URL');
            }
            const { url } = await res.json();

            // Redirect to Google OAuth
            window.location.href = url;
        } catch (err) {
            console.error('Google sign-in error:', err);
            setError('Failed to start Google sign-in. Please try again.');
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

            // Get callback URL for this app (use sidecar URL if configured)
            const baseUrl = getApiBaseUrl() || window.location.origin;
            const callbackUrl = `${baseUrl}/api/auth/callback`;

            // Redirect to platform login with callback
            window.location.href = `${url}/login?redirect_uri=${encodeURIComponent(callbackUrl)}`;
        } catch (err) {
            console.error('Email sign-in error:', err);
            setError('Failed to start sign-in. Please try again.');
            setIsLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-header">
                    <div className="login-logo">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M12 2L2 7l10 5 10-5-10-5z" />
                            <path d="M2 17l10 5 10-5" />
                            <path d="M2 12l10 5 10-5" />
                        </svg>
                    </div>
                    <h1>Welcome to Panini</h1>
                    <p>Sign in to continue to your personal AI assistant</p>
                </div>

                {error && (
                    <div className="login-error">
                        {error}
                    </div>
                )}

                <div className="login-buttons">
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
                        <span>Continue with Google</span>
                    </button>

                    <div className="login-divider">
                        <span>or</span>
                    </div>

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
                        <span>Continue with Email</span>
                    </button>
                </div>

                <div className="login-footer">
                    <p>
                        By continuing, you agree to Panini's Terms of Service and Privacy Policy.
                    </p>
                </div>
            </div>
        </div>
    );
}
