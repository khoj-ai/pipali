/**
 * Webpage Content Extractor
 *
 * Uses a fast LLM to extract relevant information from raw webpage content.
 * This ensures only pertinent information is passed to the main research agent.
 */

import { sendMessageToModel } from '../conversation/index';
import type { MetricsAccumulator } from '../director/types';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'webpage_extractor' });

/**
 * Truncate overlong raw webpage content to not overwhelm LLM context.
 */
export function truncateWebpageContent(content: string, maxLength: number = 10e4, truncationReason: string = 'Content truncated...'): string {
    if (content.length > maxLength) {
        return content.slice(0, maxLength) + `\n\n[${truncationReason}]`;
    }
    return content;
}

// System prompt for content extraction
const EXTRACTION_SYSTEM_PROMPT = `As a professional analyst, your job is to extract all pertinent information from a webpage to help answer a user's query.
You will be provided raw text from a webpage.

Adhere to these guidelines while extracting information:

1. Extract all relevant text and links from the webpage that can assist with answering the target query.
2. Craft a comprehensive but compact report with all the necessary data to generate an informed response.
3. Rely strictly on the provided webpage content, without including external information.
4. Provide specific, important snippets from the webpage in your report to establish trust in your summary.
5. Verbatim quote all necessary text, code, or data from the webpage that directly answers the target query.
6. If the webpage content is not relevant to the query, state that clearly.
7. Preserve any URLs, code snippets, or structured data that may be useful.`;

/**
 * Build the extraction prompt
 */
function buildExtractionPrompt(webpageContent: string, query: string, url: string): string {
    // Truncate content if too long (keep within reasonable token limits)
    const content = truncateWebpageContent(webpageContent, 10e4, 'Content truncated due to length...');

    return `<source_url>
${url}
</source_url>

<target_query>
${query}
</target_query>

<webpage_content>
${content}
</webpage_content>

Extract all relevant information from the webpage content to answer the target query. Provide a focused, comprehensive summary.`;
}

/**
 * Extract relevant content from a webpage using LLM
 *
 * @param webpageContent - The raw text content of the webpage
 * @param query - The query/question to extract relevant information for
 * @param url - The URL of the webpage
 * @param metricsAccumulator - Optional accumulator to track LLM usage metrics
 * @returns Extracted relevant content
 */
export async function extractRelevantContent(
    webpageContent: string,
    query: string,
    url: string,
    metricsAccumulator?: MetricsAccumulator
): Promise<string> {
    if (!webpageContent || webpageContent.trim().length === 0) {
        return 'No content to extract from.';
    }

    if (!query || query.trim().length === 0) {
        // If no query, return (truncated) raw content
        return truncateWebpageContent(webpageContent);
    }

    try {
        // Build the extraction prompt
        const extractionPrompt = buildExtractionPrompt(webpageContent, query, url);

        log.debug(`Extracting content for query: "${query.slice(0, 50)}..."`);

        // Use sendMessageToModel abstraction layer. Handles model selection automatically
        const response = await sendMessageToModel(
            extractionPrompt,      // query
            undefined,             // history
            EXTRACTION_SYSTEM_PROMPT, // systemMessage
        );

        if (!response || !response.message) {
            log.warn('No response from model');
            // Fallback to return raw (truncated) content on model failure
            return truncateWebpageContent(webpageContent);
        }

        // Accumulate usage metrics if accumulator provided
        if (metricsAccumulator && response.usage) {
            metricsAccumulator.prompt_tokens += response.usage.prompt_tokens;
            metricsAccumulator.completion_tokens += response.usage.completion_tokens;
            metricsAccumulator.cached_tokens += response.usage.cached_tokens || 0;
            metricsAccumulator.cache_write_tokens += response.usage.cache_write_tokens || 0;
            metricsAccumulator.cost_usd += response.usage.cost_usd;
            log.debug(`Added usage: ${response.usage.prompt_tokens} prompt, ${response.usage.completion_tokens} completion, $${response.usage.cost_usd.toFixed(6)}`);
        }

        return response.message.trim();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ err: error }, `Extraction failed: ${errorMessage}`);

        // Fallback to return raw (truncated) content on error
        return truncateWebpageContent(webpageContent);
    }
}
