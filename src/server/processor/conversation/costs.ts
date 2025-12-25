/**
 * Model pricing constants for calculating API costs
 * Prices are per million tokens
 */

export interface ModelPricing {
    /** Cost per million input tokens */
    input: number;
    /** Cost per million output tokens */
    output: number;
    /** Cost per million cached/read tokens (optional) */
    cache_read?: number;
    /** Cost per million cache write tokens (optional) */
    cache_write?: number;
    /** Cost per million reasoning/thought tokens (optional) */
    thought?: number;
}

/**
 * Model to cost mapping
 * Prices are in USD per million tokens
 */
export const modelToCost: Record<string, ModelPricing> = {
    // OpenAI Pricing: https://openai.com/api/pricing/
    "gpt-5.1": { input: 1.25, output: 10.00, cache_read: 0.125 },
    "gpt-5.2": { input: 1.75, output: 14.00, cache_read: 0.175 },

    // Gemini Pricing: https://ai.google.dev/pricing
    "gemini-3-flash-preview": { input: 0.50, output: 3.00, cache_read: 0.05 },
    "gemini-3-pro-preview": { input: 2.00, output: 12.0, cache_read: 0.20 },

    // Anthropic Pricing: https://www.anthropic.com/pricing#anthropic-api
    "claude-haiku-4-5": { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 },
    "claude-sonnet-4-5": { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    "claude-opus-4-5": { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },

    // Grok pricing: https://docs.x.ai/docs/models
    "grok-4-1-fast": { input: 0.20, output: 0.50, cache_read: 0.05 },
    "grok-4": { input: 3.0, output: 15.0, cache_read: 0.75 },

    // Groq pricing
    "moonshotai/kimi-k2-instruct-0905": { input: 1.00, output: 3.00 },
    "openai/gpt-oss-120b": { input: 0.15, output: 0.75 },
    "openai/gpt-oss-20b": { input: 0.10, output: 0.50 },

    // Cerebras pricing
    "zai-glm-4.6": { input: 2.25, output: 2.75 },

    // Miscellaneous
    "moonshotai/kimi-k2-thinking": { input: 0.60, output: 2.50 },
};

/**
 * Pricing information that can come from DB or fallback
 */
export interface PricingConfig {
    inputCostPerMillion?: number | null;
    outputCostPerMillion?: number | null;
    cacheReadCostPerMillion?: number | null;
    cacheWriteCostPerMillion?: number | null;
}

/**
 * Calculate the cost of a chat message based on token usage
 * @param modelName - The name of the model used
 * @param inputTokens - Number of prompt/input tokens
 * @param outputTokens - Number of completion/output tokens
 * @param cacheReadTokens - Number of tokens read from cache
 * @param cacheWriteTokens - Number of tokens written to cache
 * @param thoughtTokens - Number of reasoning/thought tokens
 * @param dbPricing - model pricing from database (takes precedence over fallback)
 * @returns Cost in USD
 */
export function calculateCost(
    modelName: string,
    inputTokens: number = 0,
    outputTokens: number = 0,
    cacheReadTokens: number = 0,
    cacheWriteTokens: number = 0,
    thoughtTokens: number = 0,
    dbPricing?: PricingConfig,
): number {
    let inputCostPerMillion: number;
    let outputCostPerMillion: number;
    let cacheReadCostPerMillion: number;
    let cacheWriteCostPerMillion: number;

    // Use pricing from database when set, else fallback to hardcoded pricing
    if (dbPricing?.inputCostPerMillion != null && dbPricing?.outputCostPerMillion != null) {
        // Use pricing from database
        inputCostPerMillion = dbPricing.inputCostPerMillion;
        outputCostPerMillion = dbPricing.outputCostPerMillion;
        cacheReadCostPerMillion = dbPricing.cacheReadCostPerMillion ?? 0;
        cacheWriteCostPerMillion = dbPricing.cacheWriteCostPerMillion ?? 0;
    } else {
        // Fallback to hardcoded pricing
        const pricing = modelToCost[modelName];
        if (!pricing) {
            // If model not found in fallback, return 0 (unknown cost)
            return 0;
        }
        inputCostPerMillion = pricing.input;
        outputCostPerMillion = pricing.output;
        cacheReadCostPerMillion = pricing.cache_read ?? 0;
        cacheWriteCostPerMillion = pricing.cache_write ?? 0;
    }

    // Calculate cost in usd - prices are per million tokens
    const inputCost = inputCostPerMillion * (inputTokens / 1e6);
    const outputCost = outputCostPerMillion * (outputTokens / 1e6);
    const cachedReadCost = cacheReadCostPerMillion * (cacheReadTokens / 1e6);
    const cacheWriteCost = cacheWriteCostPerMillion * (cacheWriteTokens / 1e6);
    // For thought tokens, use output cost as default
    const thoughtCost = outputCostPerMillion * (thoughtTokens / 1e6);

    return inputCost + outputCost + cachedReadCost + cacheWriteCost + thoughtCost;
}
