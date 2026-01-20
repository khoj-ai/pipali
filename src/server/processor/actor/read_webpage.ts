/**
 * Read Webpage Actor Tool
 *
 * Reads and extracts content from web pages using configured providers.
 * Supports Exa for content extraction with direct URL fetch as fallback.
 * Uses LLM to extract relevant information from the raw webpage content.
 */

import { db } from '../../db';
import { WebScraper } from '../../db/schema';
import { desc, eq } from 'drizzle-orm';
import { platformFetch } from '../../http/platform-fetch';
import { extractRelevantContent } from './webpage_extractor';
import type { MetricsAccumulator } from '../director/types';
import { isInternalUrl, getInternalUrlReason } from '../../security';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'read_webpage' });

// Timeout for webpage fetch requests (in milliseconds)
const FETCH_REQUEST_TIMEOUT = 60000;

// Get environment variables at runtime (not module load time)
function getExaApiKey(): string | undefined {
    return process.env.EXA_API_KEY;
}

function getExaApiBaseUrl(): string {
    return process.env.EXA_API_URL || 'https://api.exa.ai';
}

// User agent for direct URL fetching
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Arguments for the read_webpage tool
 */
export interface ReadWebpageArgs {
    /** The URL of the webpage to read */
    url: string;
    /** The query/question to extract relevant information for */
    query?: string;
}

/**
 * Result from read_webpage tool
 */
export interface ReadWebpageResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Options for webpage reading operations
 */
export interface ReadWebpageOptions {
    /** Confirmation context for requesting user approval on internal URLs */
    confirmationContext?: ConfirmationContext;
    /** Metrics accumulator for tracking LLM usage */
    metricsAccumulator?: MetricsAccumulator;
}

/**
 * Get enabled web scrapers from database, ordered by priority (highest first)
 */
async function getEnabledWebScrapers(): Promise<(typeof WebScraper.$inferSelect)[]> {
    try {
        const scrapers = await db
            .select()
            .from(WebScraper)
            .where(eq(WebScraper.enabled, true))
            .orderBy(desc(WebScraper.priority));
        return scrapers;
    } catch (error) {
        log.debug('No web scrapers configured in database, using environment variables');
        return [];
    }
}

/**
 * Read webpage content using Pipali Platform API
 * Uses platformFetch for automatic token refresh on 401 errors
 */
async function readWithPlatform(
    url: string,
    query: string | undefined,
    apiBaseUrl: string
): Promise<string | null> {
    const endpoint = `${apiBaseUrl}/read-webpage`;

    const payload: { url: string; query?: string } = { url };
    if (query) {
        payload.query = query;
    }

    log.debug(`Read using Pipali Platform: ${url}`);

    const result = await platformFetch<{ content?: string; title?: string; url: string }>(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: FETCH_REQUEST_TIMEOUT,
    });

    // Platform returns { content: "...", title?: "...", url: "..." }
    if (!result.data.content) {
        return null;
    }

    if (result.wasRetried) {
        log.debug('Platform request succeeded after token refresh');
    }

    return result.data.content;
}

/**
 * Read webpage content using Exa API
 */
async function readWithExa(
    url: string,
    apiKey?: string,
    apiBaseUrl?: string
): Promise<string | null> {
    const effectiveApiKey = apiKey || getExaApiKey();
    const effectiveBaseUrl = apiBaseUrl || getExaApiBaseUrl();

    if (!effectiveApiKey) {
        throw new Error('Exa API key not configured');
    }

    const contentsEndpoint = `${effectiveBaseUrl}/contents`;
    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': effectiveApiKey,
    };

    const payload = {
        urls: [url],
        text: true,
        livecrawl: 'fallback',
        livecrawlTimeout: 15000,
    };

    log.debug(`Reading with Exa: ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_REQUEST_TIMEOUT);

    try {
        const response = await fetch(contentsEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Exa contents failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const results = data.results || [];

        if (results.length === 0 || !results[0].text) {
            return null;
        }

        return results[0].text;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('Webpage fetch timed out');
        }
        throw error;
    }
}

/**
 * Read webpage content using direct URL fetch
 * Fetches HTML and converts to text using simple HTML parsing
 */
async function readWithDirectFetch(url: string): Promise<string | null> {
    log.debug(`Reading with direct fetch: ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            signal: controller.signal,
            redirect: 'follow',
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
            throw new Error(`Unsupported content type: ${contentType}`);
        }

        const html = await response.text();
        return htmlToText(html);
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('Webpage fetch timed out');
        }
        throw error;
    }
}

/**
 * Simple HTML to text conversion
 * Strips HTML tags and extracts text content
 */
function htmlToText(html: string): string {
    // Remove script and style elements
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

    // Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // Replace common block elements with newlines
    text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi, '\n');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode common HTML entities
    text = text.replace(/&nbsp;/gi, ' ');
    text = text.replace(/&amp;/gi, '&');
    text = text.replace(/&lt;/gi, '<');
    text = text.replace(/&gt;/gi, '>');
    text = text.replace(/&quot;/gi, '"');
    text = text.replace(/&#39;/gi, "'");
    text = text.replace(/&apos;/gi, "'");

    // Normalize whitespace
    text = text.replace(/\t/g, ' ');
    text = text.replace(/ +/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n\n');
    text = text.trim();

    // Limit length to avoid overwhelming the context
    const maxLength = 50000;
    if (text.length > maxLength) {
        text = text.slice(0, maxLength) + '\n\n[Content truncated...]';
    }

    return text;
}

/**
 * Validate URL format
 */
function isValidUrl(urlString: string): boolean {
    try {
        const url = new URL(urlString);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Main read_webpage function
 *
 * Security:
 * - Internal/private network URLs require user confirmation
 */
export async function readWebpage(
    args: ReadWebpageArgs,
    options?: ReadWebpageOptions | MetricsAccumulator
): Promise<ReadWebpageResult> {
    const { url, query } = args;

    // Handle both old signature (metricsAccumulator) and new signature (options object)
    const opts: ReadWebpageOptions = options && 'confirmationContext' in options
        ? options
        : { metricsAccumulator: options as MetricsAccumulator | undefined };

    if (!url || url.trim().length === 0) {
        return {
            query: 'Read webpage',
            file: '',
            uri: '',
            compiled: 'Error: URL is required',
        };
    }

    if (!isValidUrl(url)) {
        return {
            query: `**Reading webpage**: ${url}`,
            file: url,
            uri: url,
            compiled: 'Error: Invalid URL format. URL must start with http:// or https://',
        };
    }

    // Check if URL points to internal/private network and request confirmation
    if (isInternalUrl(url) && opts.confirmationContext) {
        const reason = getInternalUrlReason(url) || 'internal network resource';
        const confirmResult = await requestOperationConfirmation(
            'fetch_internal_url',
            url,
            opts.confirmationContext,
            {
                toolName: 'read_webpage',
                toolArgs: { url, query },
                additionalMessage: `This URL points to a ${reason}.\n\nInternal network resources may expose sensitive information. Are you sure you want to access this URL?`,
            }
        );

        if (!confirmResult.approved) {
            return {
                query: `**Reading webpage**: ${url}`,
                file: url,
                uri: url,
                compiled: `Webpage fetch cancelled: ${confirmResult.denialReason || 'User denied access to internal network URL'}`,
            };
        }
    }

    try {
        // Get configured web scrapers from database
        const scrapers = await getEnabledWebScrapers();

        let rawContent: string | null = null;
        let lastError: Error | null = null;
        let usedProvider = 'unknown';

        // Try database-configured scrapers first (ordered by priority)
        for (const scraper of scrapers) {
            try {
                if (scraper.type === 'exa') {
                    rawContent = await readWithExa(
                        url,
                        scraper.apiKey || undefined,
                        scraper.apiBaseUrl || undefined
                    );
                } else if (scraper.type === 'platform') {
                    // Platform scraper - uses platformFetch for automatic token refresh
                    if (scraper.apiBaseUrl) {
                        rawContent = await readWithPlatform(
                            url,
                            query,
                            scraper.apiBaseUrl
                        );
                    }
                }
                // 'direct' type scrapers are handled in the final fallback

                if (rawContent) {
                    usedProvider = scraper.type;
                    log.debug(`Successfully read with ${scraper.type}`);
                    break;
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                log.warn(`Failed with ${scraper.type}: ${lastError.message}`);
            }
        }

        // Fallback to environment variable Exa if no database scrapers worked
        if (!rawContent && getExaApiKey()) {
            try {
                log.debug('Trying Exa with environment variable API key');
                rawContent = await readWithExa(url);
                if (rawContent) {
                    usedProvider = 'Exa (env)';
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                log.warn(`Exa env fallback failed: ${lastError.message}`);
            }
        }

        // Direct URL fetch as final fallback
        if (!rawContent) {
            try {
                log.debug('Trying direct URL fetch');
                rawContent = await readWithDirectFetch(url);
                if (rawContent) {
                    usedProvider = 'Direct fetch';
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                log.warn(`Direct fetch failed: ${lastError.message}`);
            }
        }

        if (!rawContent) {
            const errorMessage = lastError
                ? `Failed to read webpage. Error: ${lastError.message}`
                : 'Failed to read webpage content.';

            return {
                query: `**Reading webpage**: ${url}`,
                file: url,
                uri: url,
                compiled: errorMessage,
            };
        }

        log.debug(`Got ${rawContent.length} chars of raw content from ${usedProvider}`);

        // Extract relevant content using LLM if query is provided and not platform scraper
        let extractedContent: string;
        if (query && usedProvider !== 'platform') {
            try {
                log.debug(`Extracting relevant content for query: "${query}"`);
                extractedContent = await extractRelevantContent(rawContent, query, opts.metricsAccumulator);
                log.debug(`Extracted ${extractedContent.length} chars of relevant content`);
            } catch (error) {
                log.warn(`Content extraction failed, using raw content: ${error}`);
                // Fallback to truncated raw content if extraction fails
                extractedContent = rawContent.slice(0, 10000);
                if (rawContent.length > 10000) {
                    extractedContent += '\n\n[Content truncated...]';
                }
            }
        } else {
            // No query provided, use truncated raw content
            extractedContent = rawContent.slice(0, 10000);
            if (rawContent.length > 10000) {
                extractedContent += '\n\n[Content truncated...]';
            }
        }

        return {
            query: `**Reading webpage**: ${url}`,
            file: url,
            uri: url,
            compiled: extractedContent,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`Error: ${errorMessage}`);

        return {
            query: `**Reading webpage**: ${url}`,
            file: url,
            uri: url,
            compiled: `Error reading webpage: ${errorMessage}`,
        };
    }
}
