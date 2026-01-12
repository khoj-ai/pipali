/**
 * Type definitions for Platform authentication
 */

export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt?: Date;
}

export interface PlatformUserInfo {
    id: string;
    email: string;
    name: string | null;
    profilePictureUrl: string | null;
    isServerOwner: boolean;
}

export interface OAuthFlowResult {
    success: boolean;
    tokens?: AuthTokens;
    userInfo?: PlatformUserInfo;
    error?: string;
}

export interface AuthConfig {
    platformUrl: string;
    callbackPort?: number;  // Default: auto-find available port
    timeout?: number;       // Default: 5 minutes
}
