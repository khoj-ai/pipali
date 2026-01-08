/**
 * Platform Authentication Module
 *
 * Handles authentication with the Pipali Platform for the local app.
 * Stores tokens in the local PGlite database and provides functions
 * to check auth status, get tokens, and refresh tokens.
 */

import { db } from '../db';
import { PlatformAuth, User, AiModelApi, ChatModel, WebSearchProvider, WebScraper } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import type { AuthTokens, PlatformUserInfo } from './types';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'auth' });

// Module state
let platformUrl: string = process.env.PIPALI_PLATFORM_URL || 'https://pipali.ai';
let anonMode: boolean = false;

// Mutex for token refresh to prevent race conditions
// When multiple requests detect an expired token simultaneously, only one should refresh
let refreshPromise: Promise<string | null> | null = null;

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
        log.info('Access token expired or expiring soon, refreshing...');
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
            .where(eq(AiModelApi.name, 'Pipali'));

        // Update web search provider
        await db
            .update(WebSearchProvider)
            .set({ apiKey: newToken, updatedAt: new Date() })
            .where(eq(WebSearchProvider.name, 'Pipali'));

        // Update web scraper
        await db
            .update(WebScraper)
            .set({ apiKey: newToken, updatedAt: new Date() })
            .where(eq(WebScraper.name, 'Pipali'));

        log.info('Updated platform provider tokens');
    } catch (error) {
        log.error({ err: error }, 'Failed to update platform provider tokens');
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
        log.error({ err: error }, 'Failed to get stored tokens');
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

        log.info('Tokens stored successfully');
    } catch (error) {
        log.error({ err: error }, 'Failed to store tokens');
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
        log.info('Tokens cleared');
    } catch (error) {
        log.error({ err: error }, 'Failed to clear tokens');
    }
}

/**
 * Refresh the access token using the refresh token
 * Returns the new access token or null if refresh failed
 *
 * Uses a mutex to prevent race conditions when multiple requests
 * try to refresh simultaneously (refresh tokens are single-use)
 */
export async function refreshAccessToken(): Promise<string | null> {
    // If a refresh is already in progress, wait for it instead of starting another
    if (refreshPromise) {
        log.debug('Token refresh already in progress, waiting...');
        return refreshPromise;
    }

    // Start the refresh and store the promise so concurrent calls can wait
    refreshPromise = doRefreshAccessToken();

    try {
        return await refreshPromise;
    } finally {
        // Clear the mutex after completion (success or failure)
        refreshPromise = null;
    }
}

/**
 * Internal function that performs the actual token refresh
 */
async function doRefreshAccessToken(): Promise<string | null> {
    const tokens = await getStoredTokens();
    if (!tokens) {
        return null;
    }

    try {
        log.info('Refreshing access token...');

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
            const errorText = await response.text();
            log.error({ status: response.status, error: errorText }, 'Token refresh failed');

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

        log.info('Token refreshed successfully');
        return data.accessToken;
    } catch (error) {
        log.error({ err: error }, 'Token refresh error');
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
        log.error({ err: error }, 'Failed to get user info');
        return null;
    }
}

/**
 * Sync platform models to the app's local database
 * This sets up Pipali Platform as an AI provider and adds available models
 */
export async function syncPlatformModels(): Promise<void> {
    const tokens = await getStoredTokens();
    if (!tokens) {
        log.debug('No tokens available, skipping platform model sync');
        return;
    }

    try {
        log.info('Syncing platform models...');

        // Fetch models from platform
        const modelsUrl = `${platformUrl}/openai/v1/models`;
        log.debug({ url: modelsUrl }, 'Fetching models from platform');

        const response = await fetch(modelsUrl, {
            headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
            },
        });

        if (!response.ok) {
            if (response.status === 401) {
                // Token expired, try refresh
                log.debug('Got 401, attempting token refresh...');
                const newToken = await refreshAccessToken();
                if (newToken) {
                    return syncPlatformModels(); // Retry
                }
            }
            const errorText = await response.text();
            log.error({ status: response.status, error: errorText.substring(0, 200) }, 'Failed to fetch platform models');
            return;
        }

        // Check content type before parsing
        const contentType = response.headers.get('content-type');
        if (!contentType?.includes('application/json')) {
            const text = await response.text();
            log.error({ contentType, response: text.substring(0, 200) }, 'Platform returned non-JSON response');
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
            log.info('No models available from platform');
            return;
        }

        // Check if Pipali provider already exists
        const [existingProvider] = await db
            .select()
            .from(AiModelApi)
            .where(eq(AiModelApi.name, 'Pipali'));

        let providerId: number;

        if (existingProvider) {
            providerId = existingProvider.id;
            log.debug('Pipali provider already exists');
        } else {
            // Create the Pipali provider
            // The API key will be the access token, and base URL is the platform URL
            const [newProvider] = await db.insert(AiModelApi).values({
                name: 'Pipali',
                apiKey: tokens.accessToken, // This will be refreshed when needed
                apiBaseUrl: `${platformUrl}/openai/v1`,
            }).returning();

            if (!newProvider) {
                log.error('Failed to create Pipali provider');
                return;
            }

            providerId = newProvider.id;
            log.info('Created Pipali provider');
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
            log.info({ added: addedCount, updated: updatedCount, removed: removedCount }, 'Platform models synced');
        } else {
            log.debug('Platform models already up to date');
        }

        // Update the provider's API key with current access token
        await db
            .update(AiModelApi)
            .set({
                apiKey: tokens.accessToken,
                updatedAt: new Date(),
            })
            .where(eq(AiModelApi.id, providerId));

        log.info('Platform model sync complete');
    } catch (error) {
        log.error({ err: error }, 'Failed to sync platform models');
    }
}

/**
 * Sync platform web tools (web search and web scraper) to the app's local database
 * This sets up Pipali as a web search and web scraper provider
 * Platform tools are only used if the user hasn't configured local API keys
 */
export async function syncPlatformWebTools(): Promise<void> {
    const tokens = await getStoredTokens();
    if (!tokens) {
        log.debug('No tokens available, skipping platform web tools sync');
        return;
    }

    try {
        log.info('Syncing platform web tools...');

        // Check if platform web search provider already exists
        const [existingSearchProvider] = await db
            .select()
            .from(WebSearchProvider)
            .where(eq(WebSearchProvider.name, 'Pipali'));

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
            log.debug('Updated Pipali web search provider');
        } else {
            // Create the Pipali web search provider
            await db.insert(WebSearchProvider).values({
                name: 'Pipali',
                type: 'platform',
                apiKey: tokens.accessToken,
                apiBaseUrl: `${platformUrl}/tools`,
                priority: 100, // Low priority so local API keys are tried first
                enabled: true,
            });
            log.info('Created Pipali web search provider');
        }

        // Check if platform web scraper already exists
        const [existingScraper] = await db
            .select()
            .from(WebScraper)
            .where(eq(WebScraper.name, 'Pipali'));

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
            log.debug('Updated Pipali web scraper');
        } else {
            // Create the Pipali web scraper
            await db.insert(WebScraper).values({
                name: 'Pipali',
                type: 'platform',
                apiKey: tokens.accessToken,
                apiBaseUrl: `${platformUrl}/tools`,
                priority: 100, // Low priority so local API keys are tried first
                enabled: true,
            });
            log.info('Created Pipali web scraper');
        }

        log.info('Platform web tools sync complete');
    } catch (error) {
        log.error({ err: error }, 'Failed to sync platform web tools');
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
