/**
 * Mock Preload Script for E2E Tests
 *
 * This script is preloaded before the server starts via --preload flag.
 * It sets globalThis.__paniniMockLLM which the conversation module checks
 * to return deterministic mock responses instead of calling real LLMs.
 */

import { findMatchingScenario, defaultMockScenarios, type MockScenario } from './fixtures/mock-llm';

// Track mock state per scenario (for multi-iteration scenarios)
const scenarioState = new Map<string, { currentIteration: number }>();

// Track the last query to detect new conversations
let lastQuery = '';

// Parse scenarios from environment if provided
function getScenarios(): MockScenario[] {
    const envScenarios = process.env.PANINI_MOCK_SCENARIOS;
    if (envScenarios) {
        try {
            return JSON.parse(envScenarios);
        } catch {
            console.warn('[MockPreload] Failed to parse PANINI_MOCK_SCENARIOS, using defaults');
        }
    }
    return defaultMockScenarios;
}

const scenarios = getScenarios();
console.log(`[MockPreload] Loaded ${scenarios.length} mock scenarios`);

/**
 * Generate mock response based on query and scenario
 */
function getMockResponse(query: string) {
    const scenario = findMatchingScenario(query, scenarios);

    if (!scenario) {
        console.log(`[MockLLM] No matching scenario for query: "${query}"`);
        return {
            message: 'Mock response: No matching scenario found.',
            raw: [],
            thought: undefined,
        };
    }

    console.log(`[MockLLM] Matched scenario: ${scenario.name} for query: "${query}"`);

    // Get or initialize scenario state
    let state = scenarioState.get(scenario.name);

    // If this is a new query (different from last), reset the scenario state
    // This ensures each new conversation starts fresh
    if (query !== lastQuery) {
        console.log(`[MockLLM] New query detected, resetting scenario state for: ${scenario.name}`);
        state = { currentIteration: 0 };
        scenarioState.set(scenario.name, state);
        lastQuery = query;
    } else if (!state) {
        state = { currentIteration: 0 };
        scenarioState.set(scenario.name, state);
    }

    const iterations = scenario.iterations;

    // If we've exhausted iterations, return final response
    if (state.currentIteration >= iterations.length) {
        console.log(`[MockLLM] Scenario ${scenario.name} complete, returning final response`);
        // Reset for next conversation
        scenarioState.delete(scenario.name);
        lastQuery = ''; // Clear to allow fresh start
        return {
            message: scenario.finalResponse,
            raw: [],
            thought: undefined,
        };
    }

    const iteration = iterations[state.currentIteration];
    if (!iteration) {
        return {
            message: scenario.finalResponse,
            raw: [],
            thought: undefined,
        };
    }
    state.currentIteration++;

    console.log(`[MockLLM] Scenario ${scenario.name} iteration ${state.currentIteration}/${iterations.length}`);

    // Add delay if configured (synchronous for simplicity)
    if (scenario.iterationDelayMs && scenario.iterationDelayMs > 0) {
        Bun.sleepSync(scenario.iterationDelayMs);
    }

    // Return in the format expected by director (response.raw with {name, args, id})
    return {
        message: undefined,
        raw: iteration.toolCalls.map((tc) => ({
            name: tc.function_name,
            args: tc.arguments,
            id: tc.tool_call_id,
        })),
        thought: iteration.thought,
    };
}

/**
 * Reset mock state - call this when a new WebSocket connection is established
 * to ensure each test/conversation starts fresh
 */
function resetMockState() {
    scenarioState.clear();
    lastQuery = '';
    console.log('[MockLLM] State reset');
}

// Set global mock function for the server to use
declare global {
    var __paniniMockLLM: typeof getMockResponse | undefined;
    var __paniniMockReset: typeof resetMockState | undefined;
}

globalThis.__paniniMockLLM = getMockResponse;
globalThis.__paniniMockReset = resetMockState;

console.log('[MockPreload] ✅ Mock LLM initialized');
