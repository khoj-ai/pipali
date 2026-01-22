/**
 * Platform Fetch Utility
 *
 * A fetch wrapper that handles 401 errors from the Pipali Platform API
 * by automatically refreshing the access token and retrying the request.
 *
 * This provides transparent token refresh for all platform API calls:
 * - LLM calls via OpenAI-compatible API
 * - Web search via platform tools
 * - Webpage reading via platform tools
 */

import { refreshAccessToken, getValidAccessToken } from '../auth';
import { createChildLogger } from '../logger';
import { PlatformBillingError } from './billing-errors';

const log = createChildLogger({ component: 'platform-fetch' });

/**
 * Custom error class for authentication failures that cannot be recovered
 */
export class PlatformAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlatformAuthError';
    }
}

/**
 * Options for platform fetch requests
 */
export interface PlatformFetchOptions extends Omit<RequestInit, 'headers'> {
    /** Request headers - Authorization will be set/updated automatically */
    headers?: Record<string, string>;
    /** Access token to use (if not provided, will be fetched) */
    accessToken?: string;
    /** Maximum number of retry attempts on 401 (default: 1) */
    maxRetries?: number;
    /** Request timeout in milliseconds (default: 60000) */
    timeout?: number;
}

/**
 * Result of a platform fetch request
 */
export interface PlatformFetchResult<T = unknown> {
    /** The response data (JSON parsed) */
    data: T;
    /** The raw response object */
    response: Response;
    /** Whether the request was retried after token refresh */
    wasRetried: boolean;
    /** The access token that was used for the successful request */
    usedToken: string;
}

/**
 * Check if an error message indicates an authentication/token issue
 */
function isTokenError(status: number, errorText: string): boolean {
    if (status === 401) return true;

    const lowerError = errorText.toLowerCase();
    return (
        lowerError.includes('invalid') && lowerError.includes('token') ||
        lowerError.includes('expired') && lowerError.includes('token') ||
        lowerError.includes('unauthorized') ||
        lowerError.includes('authentication')
    );
}

/**
 * Fetch from a platform API endpoint with automatic token refresh on 401
 *
 * @param url - The platform API URL to fetch
 * @param options - Fetch options including headers, body, etc.
 * @returns The parsed JSON response
 * @throws PlatformAuthError if authentication cannot be recovered
 * @throws Error for other fetch failures
 *
 * @example
 * ```ts
 * const result = await platformFetch<{ content: string }>('https://platform.pipali.ai/tools/read-webpage', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ url: 'https://example.com' }),
 * });
 * console.log(result.data.content);
 * ```
 */
export async function platformFetch<T = unknown>(
    url: string,
    options: PlatformFetchOptions = {}
): Promise<PlatformFetchResult<T>> {
    const {
        accessToken: providedToken,
        maxRetries = 1,
        timeout = 60000,
        headers: providedHeaders = {},
        signal: providedSignal,
        ...fetchOptions
    } = options;

    // Get a valid access token if not provided
    let token: string | undefined = providedToken;
    if (!token) {
        const validToken = await getValidAccessToken();
        if (!validToken) {
            throw new PlatformAuthError('No valid access token available. Please sign in again.');
        }
        token = validToken;
    }

    // Set up timeout if not using an external signal
    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (!providedSignal) {
        controller = new AbortController();
        timeoutId = setTimeout(() => controller!.abort(), timeout);
    }

    const signal = providedSignal || controller?.signal;

    const makeRequest = async (currentToken: string, attempt: number): Promise<PlatformFetchResult<T>> => {
        const headers = {
            ...providedHeaders,
            'Authorization': `Bearer ${currentToken}`,
        };

        try {
            const response = await fetch(url, {
                ...fetchOptions,
                headers,
                signal,
            });

            if (response.ok) {
                const data = await response.json() as T;
                return {
                    data,
                    response,
                    wasRetried: attempt > 0,
                    usedToken: currentToken,
                };
            }

            // Handle non-OK responses
            const errorText = await response.text();

            // Check for 402 billing error - don't retry, throw immediately
            if (response.status === 402) {
                const billingError = PlatformBillingError.fromResponse(response.status, errorText);
                if (billingError) {
                    throw billingError;
                }
                // Fallback if not parseable as billing error format
                throw new Error(`Platform billing error: ${errorText}`);
            }

            // Check if this is a token/auth error we can retry
            if (isTokenError(response.status, errorText) && attempt < maxRetries) {
                log.info({ url, status: response.status, attempt }, 'Got auth error, attempting token refresh');

                // Force refresh the token
                const newToken = await refreshAccessToken();
                if (newToken) {
                    log.info('Token refreshed successfully, retrying request');
                    return makeRequest(newToken, attempt + 1);
                }

                // Refresh failed - auth is broken
                log.error('Token refresh failed, cannot recover');
                throw new PlatformAuthError('Authentication expired and refresh failed. Please sign in again.');
            }

            // Non-auth error or max retries exceeded
            throw new Error(`Platform API error: ${response.status} - ${errorText}`);
        } catch (error) {
            if (error instanceof PlatformAuthError || error instanceof PlatformBillingError) {
                throw error;
            }
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Platform request timed out after ${timeout}ms`);
            }
            throw error;
        }
    };

    try {
        return await makeRequest(token, 0);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Get a valid access token with automatic refresh if needed.
 * Re-exported for convenience when callers need the token directly.
 */
export { getValidAccessToken, refreshAccessToken };

/**
 * Execute a function that uses a platform access token, automatically
 * retrying with a fresh token if a 401 error occurs.
 *
 * This is useful for cases where you can't use platformFetch directly,
 * such as the OpenAI client which manages its own HTTP calls.
 *
 * @param fn - Function that takes an access token and returns a promise
 * @param options - Options for the operation
 * @returns The result of the function
 * @throws PlatformAuthError if authentication cannot be recovered
 *
 * @example
 * ```ts
 * const response = await withTokenRefresh(async (token) => {
 *     const client = new OpenAI({ apiKey: token, baseURL: '...' });
 *     return client.responses.stream({ ... }).finalResponse();
 * });
 * ```
 */
export async function withTokenRefresh<T>(
    fn: (token: string) => Promise<T>,
    options: { maxRetries?: number } = {}
): Promise<T> {
    const { maxRetries = 1 } = options;

    // Get initial token
    let token = await getValidAccessToken();
    if (!token) {
        throw new PlatformAuthError('No valid access token available. Please sign in again.');
    }

    const execute = async (currentToken: string, attempt: number): Promise<T> => {
        try {
            return await fn(currentToken);
        } catch (error) {
            // Rethrow billing errors immediately - don't retry
            if (error instanceof PlatformBillingError) {
                throw error;
            }

            // Extract error information from SDK errors
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStatus = (error as any)?.status;
            const errorBody = (error as any)?.error;

            // Check for billing errors (402 status or billing-related error body)
            const bodyType = typeof errorBody === 'object' ? errorBody?.type : undefined;
            const bodyCode = typeof errorBody === 'object' ? errorBody?.code : undefined;
            const bodyMessage = typeof errorBody === 'object' ? errorBody?.message : undefined;

            const isBillingError =
                errorStatus === 402 ||
                errorMessage.includes('402') ||
                bodyType === 'billing_error' ||
                bodyCode === 'insufficient_credits' ||
                bodyCode === 'spend_limit_reached' ||
                errorMessage.toLowerCase().includes('insufficient_credits') ||
                errorMessage.toLowerCase().includes('spend_limit_reached') ||
                errorMessage.toLowerCase().includes('billing_error') ||
                (bodyMessage && (
                    bodyMessage.toLowerCase().includes('insufficient credits') ||
                    bodyMessage.toLowerCase().includes('spend limit')
                ));

            if (isBillingError) {
                // Determine the billing error code
                const billingCode = bodyCode === 'spend_limit_reached' ? 'spend_limit_reached'
                    : bodyCode === 'insufficient_credits' ? 'insufficient_credits'
                    : errorMessage.toLowerCase().includes('spend limit') ? 'spend_limit_reached'
                    : 'insufficient_credits';

                throw new PlatformBillingError({
                    code: billingCode,
                    message: bodyMessage || (billingCode === 'insufficient_credits'
                        ? 'Insufficient credits. Please add credits to continue.'
                        : 'Spend limit reached. Please increase your limit or wait for the next billing period.'),
                    credits_balance_cents: errorBody?.credits_balance_cents,
                    current_period_spent_cents: errorBody?.current_period_spent_cents,
                    spend_hard_limit_cents: errorBody?.spend_hard_limit_cents,
                });
            }

            const isAuthError =
                errorStatus === 401 ||
                errorMessage.includes('401') ||
                errorMessage.toLowerCase().includes('unauthorized') ||
                (errorMessage.toLowerCase().includes('invalid') && errorMessage.toLowerCase().includes('token')) ||
                (errorMessage.toLowerCase().includes('expired') && errorMessage.toLowerCase().includes('token'));

            if (isAuthError && attempt < maxRetries) {
                log.info({ attempt, error: errorMessage }, 'Got auth error in withTokenRefresh, attempting refresh');

                const newToken = await refreshAccessToken();
                if (newToken) {
                    log.info('Token refreshed successfully, retrying operation');
                    return execute(newToken, attempt + 1);
                }

                throw new PlatformAuthError('Authentication expired and refresh failed. Please sign in again.');
            }

            throw error;
        }
    };

    return execute(token, 0);
}
