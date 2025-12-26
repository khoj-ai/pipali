/**
 * Webpage Content Extractor
 *
 * Uses a fast LLM to extract relevant information from raw webpage content.
 * This ensures only pertinent information is passed to the main research agent.
 */

import { sendMessageToModel } from '../conversation/index';
import type { MetricsAccumulator } from '../director/types';

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
function buildExtractionPrompt(webpageContent: string, query: string): string {
    // Truncate content if too long (keep within reasonable token limits)
    const maxContentLength = 30000;
    let content = webpageContent;
    if (content.length > maxContentLength) {
        content = content.slice(0, maxContentLength) + '\n\n[Content truncated due to length...]';
    }

    return `<target_query>
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
 * @param metricsAccumulator - Optional accumulator to track LLM usage metrics
 * @returns Extracted relevant content
 */
export async function extractRelevantContent(
    webpageContent: string,
    query: string,
    metricsAccumulator?: MetricsAccumulator
): Promise<string> {
    if (!webpageContent || webpageContent.trim().length === 0) {
        return 'No content to extract from.';
    }

    if (!query || query.trim().length === 0) {
        // If no query, return truncated raw content
        const maxLength = 5000;
        if (webpageContent.length <= maxLength) {
            return webpageContent;
        }
        return webpageContent.slice(0, maxLength) + '\n\n[Content truncated...]';
    }

    try {
        // Build the extraction prompt
        const extractionPrompt = buildExtractionPrompt(webpageContent, query);

        console.log(`[WebpageExtractor] Extracting content for query: "${query.slice(0, 50)}..."`);

        // Use sendMessageToModel abstraction layer
        // This handles model selection and API routing automatically
        const response = await sendMessageToModel(
            extractionPrompt,      // query
            undefined,             // history
            EXTRACTION_SYSTEM_PROMPT, // systemMessage
            undefined,             // tools (none needed for extraction)
            'auto',                // toolChoice
            false,                 // deepThought
            true,                  // fastMode - use fast model for extraction
            undefined,             // user
        );

        if (!response || !response.message) {
            console.warn('[WebpageExtractor] No response from model');
            return webpageContent.slice(0, 5000) + (webpageContent.length > 5000 ? '\n\n[Content truncated...]' : '');
        }

        // Accumulate usage metrics if accumulator provided
        if (metricsAccumulator && response.usage) {
            metricsAccumulator.prompt_tokens += response.usage.prompt_tokens;
            metricsAccumulator.completion_tokens += response.usage.completion_tokens;
            metricsAccumulator.cached_tokens += response.usage.cached_tokens || 0;
            metricsAccumulator.cost_usd += response.usage.cost_usd;
            console.log(`[WebpageExtractor] Added usage: ${response.usage.prompt_tokens} prompt, ${response.usage.completion_tokens} completion, $${response.usage.cost_usd.toFixed(6)}`);
        }

        return response.message.trim();
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[WebpageExtractor] Extraction failed: ${errorMessage}`);

        // Fallback to truncated raw content on error
        return webpageContent.slice(0, 5000) + (webpageContent.length > 5000 ? '\n\n[Content truncated...]' : '');
    }
}
