/**
 * Web Search Actor Tool
 *
 * Performs web searches using configured search providers (Exa, Serper).
 * Returns search results including titles, links, and snippets.
 */

import { db } from '../../db';
import { WebSearchProvider } from '../../db/schema';
import { desc, eq } from 'drizzle-orm';
import { getValidAccessToken } from '../../auth';

// Timeout for web search requests (in milliseconds)
const SEARCH_REQUEST_TIMEOUT = 30000;

// Maximum query length for Serper API
const SERPER_MAX_QUERY_LENGTH = 2048;

// Get environment variables at runtime (not module load time)
function getExaApiKey(): string | undefined {
    return process.env.EXA_API_KEY;
}

function getExaApiBaseUrl(): string {
    return process.env.EXA_API_URL || 'https://api.exa.ai';
}

function getSerperApiKey(): string | undefined {
    return process.env.SERPER_DEV_API_KEY;
}

function getSerperApiBaseUrl(): string {
    return process.env.SERPER_DEV_URL || 'https://google.serper.dev';
}

/**
 * Arguments for the web_search tool
 */
export interface WebSearchArgs {
    /** The search query */
    query: string;
    /** Maximum number of results to return (default: 10, max: 20) */
    max_results?: number;
    /** Country code for localized results (e.g., 'US', 'GB') */
    country_code?: string;
}

/**
 * A single search result
 */
export interface SearchResult {
    title: string;
    link: string;
    snippet?: string;
}

/**
 * Extended search result with additional Serper-specific fields
 */
export interface ExtendedSearchResult {
    organic: SearchResult[];
    answerBox?: {
        title: string;
        snippet?: string;
        link?: string;
    };
    knowledgeGraph?: {
        title: string;
        type?: string;
        description?: string;
    };
    peopleAlsoAsk?: Array<{
        question: string;
        snippet?: string;
        link?: string;
    }>;
}

/**
 * Result from web_search tool
 */
export interface WebSearchResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Get enabled web search providers from database, ordered by priority (highest first)
 */
async function getEnabledWebSearchProviders(): Promise<(typeof WebSearchProvider.$inferSelect)[]> {
    try {
        const providers = await db
            .select()
            .from(WebSearchProvider)
            .where(eq(WebSearchProvider.enabled, true))
            .orderBy(desc(WebSearchProvider.priority));
        return providers;
    } catch (error) {
        console.log('[WebSearch] No web search providers configured in database, using environment variables');
        return [];
    }
}

/**
 * Search using Serper API (Google Search)
 */
async function searchWithSerper(
    query: string,
    maxResults: number,
    countryCode: string,
    apiKey?: string,
    apiBaseUrl?: string
): Promise<ExtendedSearchResult> {
    const effectiveApiKey = apiKey || getSerperApiKey();
    const effectiveBaseUrl = apiBaseUrl || getSerperApiBaseUrl();

    if (!effectiveApiKey) {
        throw new Error('Serper API key not configured');
    }

    // Truncate query if it exceeds maximum length
    let effectiveQuery = query;
    if (query.length > SERPER_MAX_QUERY_LENGTH) {
        console.warn(`[WebSearch] Truncating query. Length ${query.length} exceeds ${SERPER_MAX_QUERY_LENGTH}`);
        effectiveQuery = query.slice(0, SERPER_MAX_QUERY_LENGTH);
    }

    const searchEndpoint = `${effectiveBaseUrl}/search`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-KEY': effectiveApiKey,
    };

    const payload = {
        q: effectiveQuery,
        gl: countryCode.toLowerCase(),
        num: maxResults,
    };

    console.log(`[WebSearch] Searching Serper for: "${effectiveQuery.slice(0, 100)}${effectiveQuery.length > 100 ? '...' : ''}"`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_REQUEST_TIMEOUT);

    try {
        const response = await fetch(searchEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Serper search failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();

        // Extract organic results
        const organic: SearchResult[] = (data.organic || []).map((item: any) => ({
            title: item.title || '',
            link: item.link || '',
            snippet: item.snippet || '',
        }));

        // Build extended result with additional Serper fields
        const result: ExtendedSearchResult = { organic };

        // Answer box (featured snippet)
        if (data.answerBox) {
            result.answerBox = {
                title: data.answerBox.title || '',
                snippet: data.answerBox.snippet || data.answerBox.answer || '',
                link: data.answerBox.link,
            };
        }

        // Knowledge graph
        if (data.knowledgeGraph) {
            result.knowledgeGraph = {
                title: data.knowledgeGraph.title || '',
                type: data.knowledgeGraph.type,
                description: data.knowledgeGraph.description,
            };
        }

        // People also ask
        if (data.peopleAlsoAsk && Array.isArray(data.peopleAlsoAsk)) {
            result.peopleAlsoAsk = data.peopleAlsoAsk.map((item: any) => ({
                question: item.question || '',
                snippet: item.snippet,
                link: item.link,
            }));
        }

        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('Search request timed out');
        }
        throw error;
    }
}

/**
 * Search using Pipali Platform API
 */
async function searchWithPlatform(
    query: string,
    maxResults: number,
    countryCode: string,
    apiKey: string,
    apiBaseUrl: string
): Promise<ExtendedSearchResult> {
    const searchEndpoint = `${apiBaseUrl}/web-search`;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    const payload = {
        query,
        max_results: maxResults,
        country_code: countryCode,
    };

    console.log(`[WebSearch] Search using Pipali Platform for: "${query.slice(0, 100)}${query.length > 100 ? '...' : ''}"`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_REQUEST_TIMEOUT);

    try {
        const response = await fetch(searchEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Platform search failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();

        // Platform returns { results: [...], answerBox?, knowledgeGraph?, peopleAlsoAsk? }
        const organic: SearchResult[] = (data.results || []).map((item: any) => ({
            title: item.title || '',
            link: item.link || '',
            snippet: item.snippet || '',
        }));

        const result: ExtendedSearchResult = { organic };

        if (data.answerBox) {
            result.answerBox = data.answerBox;
        }
        if (data.knowledgeGraph) {
            result.knowledgeGraph = data.knowledgeGraph;
        }
        if (data.peopleAlsoAsk) {
            result.peopleAlsoAsk = data.peopleAlsoAsk;
        }

        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('Search request timed out');
        }
        throw error;
    }
}

/**
 * Search using Exa API
 */
async function searchWithExa(
    query: string,
    maxResults: number,
    countryCode: string,
    apiKey?: string,
    apiBaseUrl?: string
): Promise<ExtendedSearchResult> {
    const effectiveApiKey = apiKey || getExaApiKey();
    const effectiveBaseUrl = apiBaseUrl || getExaApiBaseUrl();

    if (!effectiveApiKey) {
        throw new Error('Exa API key not configured');
    }

    const searchEndpoint = `${effectiveBaseUrl}/search`;
    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': effectiveApiKey,
    };

    const payload = {
        query,
        type: 'auto',
        userLocation: countryCode.toUpperCase(),
        numResults: maxResults,
        contents: {
            text: false,
            highlights: {
                numSentences: 3,
                highlightsPerUrl: 1,
            },
        },
    };

    console.log(`[WebSearch] Searching Exa for: "${query}"`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_REQUEST_TIMEOUT);

    try {
        const response = await fetch(searchEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Exa search failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const results = data.results || [];

        const organic: SearchResult[] = results.map((item: any) => ({
            title: item.title || '',
            link: item.url || '',
            snippet: item.highlights?.[0] || item.text?.slice(0, 200) || '',
        }));

        return { organic };
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('Search request timed out');
        }
        throw error;
    }
}

/**
 * Main web search function
 */
export async function webSearch(args: WebSearchArgs): Promise<WebSearchResult> {
    const {
        query,
        max_results = 10,
        country_code = 'US',
    } = args;

    if (!query || query.trim().length === 0) {
        return {
            query: 'Web search',
            file: '',
            uri: '',
            compiled: 'Error: Search query is required',
        };
    }

    const effectiveMaxResults = Math.min(Math.max(1, max_results), 20);

    try {
        // Get configured web search providers from database
        const providers = await getEnabledWebSearchProviders();

        let extendedResult: ExtendedSearchResult | null = null;
        let lastError: Error | null = null;

        // Try database-configured providers first (ordered by priority)
        for (const provider of providers) {
            try {
                if (provider.type === 'serper') {
                    extendedResult = await searchWithSerper(
                        query,
                        effectiveMaxResults,
                        country_code,
                        provider.apiKey || undefined,
                        provider.apiBaseUrl || undefined
                    );
                } else if (provider.type === 'exa') {
                    extendedResult = await searchWithExa(
                        query,
                        effectiveMaxResults,
                        country_code,
                        provider.apiKey || undefined,
                        provider.apiBaseUrl || undefined
                    );
                } else if (provider.type === 'platform') {
                    // Platform provider - get a valid access token
                    if (provider.apiBaseUrl) {
                        const validToken = await getValidAccessToken();
                        if (validToken) {
                            extendedResult = await searchWithPlatform(
                                query,
                                effectiveMaxResults,
                                country_code,
                                validToken,
                                provider.apiBaseUrl
                            );
                        }
                    }
                }

                if (extendedResult && extendedResult.organic.length > 0) {
                    console.log(`[WebSearch] Found ${extendedResult.organic.length} results using ${provider.name}`);
                    break;
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                console.warn(`[WebSearch] Failed with ${provider.name}: ${lastError.message}`);
            }
        }

        // Fallback to environment variables if no database providers worked
        if (!extendedResult || extendedResult.organic.length === 0) {
            // Try Serper first (better results with answer boxes, knowledge graph)
            if (getSerperApiKey()) {
                try {
                    console.log('[WebSearch] Trying Serper with environment variable API key');
                    extendedResult = await searchWithSerper(query, effectiveMaxResults, country_code);
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    console.warn(`[WebSearch] Serper env fallback failed: ${lastError.message}`);
                }
            }

            // Then try Exa
            if ((!extendedResult || extendedResult.organic.length === 0) && getExaApiKey()) {
                try {
                    console.log('[WebSearch] Trying Exa with environment variable API key');
                    extendedResult = await searchWithExa(query, effectiveMaxResults, country_code);
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    console.warn(`[WebSearch] Exa env fallback failed: ${lastError.message}`);
                }
            }
        }

        if (!extendedResult || extendedResult.organic.length === 0) {
            const errorMessage = lastError
                ? `No search results found. Last error: ${lastError.message}`
                : 'No search results found. Ensure a web search provider (Serper or Exa) is configured.';

            return {
                query: `**Web search for**: "${query}"`,
                file: '',
                uri: '',
                compiled: errorMessage,
            };
        }

        // Format results for display
        const parts: string[] = [];

        // Add answer box if present
        if (extendedResult.answerBox) {
            parts.push(`**Featured Answer**: ${extendedResult.answerBox.title}`);
            if (extendedResult.answerBox.snippet) {
                parts.push(extendedResult.answerBox.snippet);
            }
            if (extendedResult.answerBox.link) {
                parts.push(`Source: ${extendedResult.answerBox.link}`);
            }
            parts.push('');
        }

        // Add knowledge graph if present
        if (extendedResult.knowledgeGraph) {
            parts.push(`**${extendedResult.knowledgeGraph.title}**${extendedResult.knowledgeGraph.type ? ` (${extendedResult.knowledgeGraph.type})` : ''}`);
            if (extendedResult.knowledgeGraph.description) {
                parts.push(extendedResult.knowledgeGraph.description);
            }
            parts.push('');
        }

        // Add organic results
        parts.push(`**Search Results** (${extendedResult.organic.length} found):\n`);
        const formattedResults = extendedResult.organic.map((r, i) => {
            let entry = `${i + 1}. **${r.title}**\n   ${r.link}`;
            if (r.snippet) {
                entry += `\n   ${r.snippet}`;
            }
            return entry;
        }).join('\n\n');
        parts.push(formattedResults);

        // Add people also ask if present
        if (extendedResult.peopleAlsoAsk && extendedResult.peopleAlsoAsk.length > 0) {
            parts.push('\n**Related Questions**:');
            for (const paa of extendedResult.peopleAlsoAsk.slice(0, 3)) {
                parts.push(`- ${paa.question}`);
            }
        }

        return {
            query: `**Web search for**: "${query}"`,
            file: '',
            uri: '',
            compiled: parts.join('\n'),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[WebSearch] Error: ${errorMessage}`);

        return {
            query: `**Web search for**: "${query}"`,
            file: '',
            uri: '',
            compiled: `Error performing web search: ${errorMessage}`,
        };
    }
}
