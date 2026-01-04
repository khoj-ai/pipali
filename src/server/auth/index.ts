/**
 * Platform Authentication Module
 *
 * Handles authentication with the Panini Platform for the local app.
 * Stores tokens in the local PGlite database and provides functions
 * to check auth status, get tokens, and refresh tokens.
 */

import { db } from '../db';
import { PlatformAuth, User, AiModelApi, ChatModel, WebSearchProvider, WebScraper } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import type { AuthTokens, PlatformUserInfo } from './types';

// Module state
let platformUrl: string = process.env.PANINI_PLATFORM_URL || 'https://panini.khoj.dev';
let anonMode: boolean = false;

/**
 * Configure the auth module
 */
export function configureAuth(config: { platformUrl?: string; anonMode?: boolean }) {
    if (config.platformUrl) {
        platformUrl = config.platformUrl;
    }
    if (config.anonMode !== undefined) {
        anonMode = config.anonMode;
    }
}

/**
 * Get the configured platform URL
 */
export function getPlatformUrl(): string {
    return platformUrl;
}

/**
 * Check if running in anonymous mode
 */
export function isAnonMode(): boolean {
    return anonMode;
}

/**
 * Get a valid access token, refreshing if expired
 * This is the main entry point for getting a token to use with platform APIs
 */
export async function getValidAccessToken(): Promise<string | null> {
    const tokens = await getStoredTokens();
    if (!tokens) {
        return null;
    }

    // Check if access token is expired or about to expire (within 1 minute)
    const expiryBuffer = 60 * 1000; // 1 minute
    if (tokens.expiresAt && tokens.expiresAt.getTime() - expiryBuffer < Date.now()) {
        console.log('[Auth] Access token expired or expiring soon, refreshing...');
        const newToken = await refreshAccessToken();
        if (newToken) {
            // Update all platform providers with the new token
            await updatePlatformProviderTokens(newToken);
            return newToken;
        }
        return null;
    }

    return tokens.accessToken;
}

/**
 * Update all platform provider API keys with a new access token
 */
async function updatePlatformProviderTokens(newToken: string): Promise<void> {
    try {
        // Update AI provider
        await db
            .update(AiModelApi)
            .set({ apiKey: newToken, updatedAt: new Date() })
            .where(eq(AiModelApi.name, 'Panini'));

        // Update web search provider
        await db
            .update(WebSearchProvider)
            .set({ apiKey: newToken, updatedAt: new Date() })
            .where(eq(WebSearchProvider.name, 'Panini'));

        // Update web scraper
        await db
            .update(WebScraper)
            .set({ apiKey: newToken, updatedAt: new Date() })
            .where(eq(WebScraper.name, 'Panini'));

        console.log('[Auth] Updated platform provider tokens');
    } catch (error) {
        console.error('[Auth] Failed to update platform provider tokens:', error);
    }
}

/**
 * Check if the user is authenticated with the platform
 */
export async function isAuthenticated(): Promise<boolean> {
    if (anonMode) {
        return false; // In anon mode, always use local keys
    }

    const tokens = await getStoredTokens();
    if (!tokens) {
        return false;
    }

    // Check if access token is expired
    if (tokens.expiresAt && tokens.expiresAt < new Date()) {
        // Try to refresh
        const refreshed = await refreshAccessToken();
        return refreshed !== null;
    }

    return true;
}

/**
 * Get stored authentication tokens
 */
export async function getStoredTokens(): Promise<AuthTokens | null> {
    try {
        // Get the default user
        const [user] = await db.select().from(User).limit(1);
        if (!user) {
            return null;
        }

        // Get the most recent platform auth for this user
        const [auth] = await db
            .select()
            .from(PlatformAuth)
            .where(eq(PlatformAuth.userId, user.id))
            .orderBy(desc(PlatformAuth.updatedAt))
            .limit(1);

        if (!auth) {
            return null;
        }

        return {
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken,
            expiresAt: auth.expiresAt || undefined,
        };
    } catch (error) {
        console.error('[Auth] Failed to get stored tokens:', error);
        return null;
    }
}

/**
 * Store authentication tokens
 */
export async function storeTokens(
    tokens: AuthTokens,
    userInfo?: { platformUserId?: string; platformEmail?: string }
): Promise<void> {
    try {
        // Get the default user
        const [user] = await db.select().from(User).limit(1);
        if (!user) {
            throw new Error('No user found');
        }

        // Check if we already have a platform auth record
        const [existing] = await db
            .select()
            .from(PlatformAuth)
            .where(eq(PlatformAuth.userId, user.id))
            .limit(1);

        if (existing) {
            // Update existing record
            await db
                .update(PlatformAuth)
                .set({
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    expiresAt: tokens.expiresAt,
                    platformUserId: userInfo?.platformUserId || existing.platformUserId,
                    platformEmail: userInfo?.platformEmail || existing.platformEmail,
                    platformUrl: platformUrl,
                    updatedAt: new Date(),
                })
                .where(eq(PlatformAuth.id, existing.id));
        } else {
            // Create new record
            await db.insert(PlatformAuth).values({
                userId: user.id,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
                platformUserId: userInfo?.platformUserId,
                platformEmail: userInfo?.platformEmail,
                platformUrl: platformUrl,
            });
        }

        console.log('[Auth] Tokens stored successfully');
    } catch (error) {
        console.error('[Auth] Failed to store tokens:', error);
        throw error;
    }
}

/**
 * Clear stored authentication tokens (logout)
 */
export async function clearTokens(): Promise<void> {
    try {
        const [user] = await db.select().from(User).limit(1);
        if (!user) {
            return;
        }

        await db.delete(PlatformAuth).where(eq(PlatformAuth.userId, user.id));
        console.log('[Auth] Tokens cleared');
    } catch (error) {
        console.error('[Auth] Failed to clear tokens:', error);
    }
}

/**
 * Refresh the access token using the refresh token
 * Returns the new access token or null if refresh failed
 */
export async function refreshAccessToken(): Promise<string | null> {
    const tokens = await getStoredTokens();
    if (!tokens) {
        return null;
    }

    try {
        console.log('[Auth] Refreshing access token...');

        const response = await fetch(`${platformUrl}/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                refreshToken: tokens.refreshToken,
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('[Auth] Token refresh failed:', error);

            // If refresh fails, clear tokens (user needs to re-authenticate)
            if (response.status === 401) {
                await clearTokens();
            }
            return null;
        }

        const data = await response.json();

        // Calculate expiry (15 minutes from now for access token)
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        // Store the new tokens
        await storeTokens({
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            expiresAt,
        });

        console.log('[Auth] Token refreshed successfully');
        return data.accessToken;
    } catch (error) {
        console.error('[Auth] Token refresh error:', error);
        return null;
    }
}

/**
 * Get user info from the platform
 */
export async function getPlatformUserInfo(): Promise<PlatformUserInfo | null> {
    const tokens = await getStoredTokens();
    if (!tokens) {
        return null;
    }

    try {
        const response = await fetch(`${platformUrl}/auth/me`, {
            headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
            },
        });

        if (!response.ok) {
            if (response.status === 401) {
                // Token expired, try refresh
                const newToken = await refreshAccessToken();
                if (newToken) {
                    return getPlatformUserInfo(); // Retry with new token
                }
            }
            return null;
        }

        const data = await response.json();
        return {
            id: data.user.id,
            email: data.user.email,
            name: data.user.name,
            isServerOwner: data.user.isServerOwner,
        };
    } catch (error) {
        console.error('[Auth] Failed to get user info:', error);
        return null;
    }
}

/**
 * Sync platform models to the app's local database
 * This sets up Panini Platform as an AI provider and adds available models
 */
export async function syncPlatformModels(): Promise<void> {
    const tokens = await getStoredTokens();
    if (!tokens) {
        console.log('[Auth] No tokens available, skipping platform model sync');
        return;
    }

    try {
        console.log('[Auth] Syncing platform models...');

        // Fetch models from platform
        const modelsUrl = `${platformUrl}/openai/v1/models`;
        console.log(`[Auth] Fetching models from: ${modelsUrl}`);

        const response = await fetch(modelsUrl, {
            headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
            },
        });

        if (!response.ok) {
            if (response.status === 401) {
                // Token expired, try refresh
                console.log('[Auth] Got 401, attempting token refresh...');
                const newToken = await refreshAccessToken();
                if (newToken) {
                    return syncPlatformModels(); // Retry
                }
            }
            const errorText = await response.text();
            console.error(`[Auth] Failed to fetch platform models: ${response.status} - ${errorText.substring(0, 200)}`);
            return;
        }

        // Check content type before parsing
        const contentType = response.headers.get('content-type');
        if (!contentType?.includes('application/json')) {
            const text = await response.text();
            console.error(`[Auth] Platform returned non-JSON response (${contentType}): ${text.substring(0, 200)}`);
            return;
        }

        const data = await response.json();
        const platformModels = data.data as Array<{
            id: string;
            owned_by: string;
            name?: string | null;
            model_type?: 'openai' | 'anthropic' | 'google';
            vision_enabled?: boolean;
            use_responses_api?: boolean;
        }>;

        if (!platformModels || platformModels.length === 0) {
            console.log('[Auth] No models available from platform');
            return;
        }

        // Check if Panini provider already exists
        const [existingProvider] = await db
            .select()
            .from(AiModelApi)
            .where(eq(AiModelApi.name, 'Panini'));

        let providerId: number;

        if (existingProvider) {
            providerId = existingProvider.id;
            console.log('[Auth] Panini provider already exists');
        } else {
            // Create the Panini provider
            // The API key will be the access token, and base URL is the platform URL
            const [newProvider] = await db.insert(AiModelApi).values({
                name: 'Panini',
                apiKey: tokens.accessToken, // This will be refreshed when needed
                apiBaseUrl: `${platformUrl}/openai/v1`,
            }).returning();

            if (!newProvider) {
                console.error('[Auth] Failed to create Panini provider');
                return;
            }

            providerId = newProvider.id;
            console.log('[Auth] Created Panini provider');
        }

        // Get existing models for this provider
        const existingModels = await db
            .select()
            .from(ChatModel)
            .where(eq(ChatModel.aiModelApiId, providerId));

        const existingModelNames = new Set(existingModels.map(m => m.name));
        const platformModelNames = new Set(platformModels.map(m => m.id));

        // Add new models and update existing ones
        let addedCount = 0;
        let updatedCount = 0;
        for (const model of platformModels) {
            // Use model_type from platform, fallback to detection if not provided
            const modelType = model.model_type || detectModelType(model.id, model.owned_by);
            const visionEnabled = model.vision_enabled ?? false;
            const useResponsesApi = model.use_responses_api ?? false;
            const friendlyName = model.name || model.id;

            if (!existingModelNames.has(model.id)) {
                await db.insert(ChatModel).values({
                    name: model.id,
                    friendlyName,
                    modelType,
                    visionEnabled,
                    useResponsesApi,
                    aiModelApiId: providerId,
                });
                addedCount++;
            } else {
                // Update existing model with latest platform values
                const existingModel = existingModels.find(m => m.name === model.id);
                if (existingModel) {
                    // Check if any values have changed
                    const hasChanges =
                        existingModel.friendlyName !== friendlyName ||
                        existingModel.modelType !== modelType ||
                        existingModel.visionEnabled !== visionEnabled ||
                        existingModel.useResponsesApi !== useResponsesApi;

                    if (hasChanges) {
                        await db.update(ChatModel)
                            .set({
                                friendlyName,
                                modelType,
                                visionEnabled,
                                useResponsesApi,
                                updatedAt: new Date()
                            })
                            .where(eq(ChatModel.id, existingModel.id));
                        updatedCount++;
                    }
                }
            }
        }

        // Remove models that are no longer available on the platform
        let removedCount = 0;
        for (const existingModel of existingModels) {
            if (!platformModelNames.has(existingModel.name)) {
                await db.delete(ChatModel).where(eq(ChatModel.id, existingModel.id));
                removedCount++;
            }
        }

        if (addedCount > 0 || removedCount > 0 || updatedCount > 0) {
            console.log(`[Auth] Platform models synced: ${addedCount} added, ${updatedCount} updated, ${removedCount} removed`);
        } else {
            console.log('[Auth] Platform models already up to date');
        }

        // Update the provider's API key with current access token
        await db
            .update(AiModelApi)
            .set({
                apiKey: tokens.accessToken,
                updatedAt: new Date(),
            })
            .where(eq(AiModelApi.id, providerId));

        console.log('[Auth] Platform model sync complete');
    } catch (error) {
        console.error('[Auth] Failed to sync platform models:', error);
    }
}

/**
 * Sync platform web tools (web search and web scraper) to the app's local database
 * This sets up Panini as a web search and web scraper provider
 * Platform tools are only used if the user hasn't configured local API keys
 */
export async function syncPlatformWebTools(): Promise<void> {
    const tokens = await getStoredTokens();
    if (!tokens) {
        console.log('[Auth] No tokens available, skipping platform web tools sync');
        return;
    }

    try {
        console.log('[Auth] Syncing platform web tools...');

        // Check if platform web search provider already exists
        const [existingSearchProvider] = await db
            .select()
            .from(WebSearchProvider)
            .where(eq(WebSearchProvider.name, 'Panini'));

        if (existingSearchProvider) {
            // Update API key and ensure it's enabled with low priority (local keys take precedence)
            await db
                .update(WebSearchProvider)
                .set({
                    apiKey: tokens.accessToken,
                    enabled: true,
                    priority: 100, // Low priority so local API keys are tried first
                    updatedAt: new Date(),
                })
                .where(eq(WebSearchProvider.id, existingSearchProvider.id));
            console.log('[Auth] Updated Panini web search provider');
        } else {
            // Create the Panini web search provider
            await db.insert(WebSearchProvider).values({
                name: 'Panini',
                type: 'platform',
                apiKey: tokens.accessToken,
                apiBaseUrl: `${platformUrl}/tools`,
                priority: 100, // Low priority so local API keys are tried first
                enabled: true,
            });
            console.log('[Auth] Created Panini web search provider');
        }

        // Check if platform web scraper already exists
        const [existingScraper] = await db
            .select()
            .from(WebScraper)
            .where(eq(WebScraper.name, 'Panini'));

        if (existingScraper) {
            // Update API key and ensure it's enabled with low priority
            await db
                .update(WebScraper)
                .set({
                    apiKey: tokens.accessToken,
                    enabled: true,
                    priority: 100, // Low priority so local API keys are tried first
                    updatedAt: new Date(),
                })
                .where(eq(WebScraper.id, existingScraper.id));
            console.log('[Auth] Updated Panini web scraper');
        } else {
            // Create the Panini web scraper
            await db.insert(WebScraper).values({
                name: 'Panini',
                type: 'platform',
                apiKey: tokens.accessToken,
                apiBaseUrl: `${platformUrl}/tools`,
                priority: 100, // Low priority so local API keys are tried first
                enabled: true,
            });
            console.log('[Auth] Created Panini web scraper');
        }

        console.log('[Auth] Platform web tools sync complete');
    } catch (error) {
        console.error('[Auth] Failed to sync platform web tools:', error);
    }
}

/**
 * Detect the model type from model name or owner
 */
function detectModelType(modelName: string, ownedBy: string): 'openai' | 'google' | 'anthropic' {
    const name = modelName.toLowerCase();
    const owner = ownedBy.toLowerCase();

    if (name.includes('claude') || owner.includes('anthropic')) {
        return 'anthropic';
    }
    if (name.includes('gemini') || owner.includes('google')) {
        return 'google';
    }
    // Default to openai for GPT models and others
    return 'openai';
}

// Re-export types
export type { AuthTokens, PlatformUserInfo, OAuthFlowResult, AuthConfig } from './types';
