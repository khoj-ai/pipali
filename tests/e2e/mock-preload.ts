/**
 * Mock Preload Script for E2E Tests
 *
 * This script is preloaded before the server starts via --preload flag.
 * It sets globalThis.__pipaliMockLLM which the conversation module checks
 * to return deterministic mock responses instead of calling real LLMs.
 */

import { appendFileSync } from 'node:fs';
import { findMatchingScenario, defaultMockScenarios, type MockScenario } from './fixtures/mock-llm';
import type { ResponseWithThought } from '../../src/server/processor/conversation/conversation';

type MockMessage = { type?: string | null; role?: string; content?: unknown };
type MockCtx = {
    sessionId?: string;
    runId?: string;
    history?: { steps?: Array<{ observation?: { results?: Array<{ content?: unknown }> } }> };
    messages?: MockMessage[];
};

/** Where each request's shape is recorded, for specs that assert on the payload. */
const requestLogPath = process.env.PIPALI_MOCK_REQUEST_LOG;

function contentText(content: unknown): string {
    return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function recordRequest(query: string, ctx: MockCtx): void {
    if (!requestLogPath || !ctx.messages) return;
    const last = ctx.messages.at(-1);
    appendFileSync(requestLogPath, JSON.stringify({
        // The prompt the turn is answering, which is how a spec finds its own requests.
        query,
        // Opaque per-conversation id, for telling one attempt at a prompt from another.
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        tail: { type: last?.type, role: last?.role, text: contentText(last?.content).slice(0, 300) },
        // Mid-conversation system messages: how inbox updates reach the model
        systemUpdates: ctx.messages
            .slice(1)
            .filter(message => message.role === 'system')
            .map(message => contentText(message.content).slice(0, 300)),
    }) + '\n');
}

/**
 * Anthropic refuses a request that ends on the agent's own turn, and the platform marks
 * that refusal as not recoverable by the model - which is what surfaces it to the user
 * as an error rather than a retry. A trailing system message is accepted, so only the
 * agent's own items are refused here.
 */
function rejectAssistantPrefill(messages: MockMessage[]): void {
    const last = messages.at(-1);
    const isAgentTurn = last?.role === 'assistant'
        || last?.type === 'reasoning'
        || last?.type === 'function_call';
    if (!isAgentTurn) return;

    const tail = `${last?.type ?? 'none'}/${last?.role ?? 'none'}`;
    throw new Error(`400 rejected request ending on ${tail}: ${JSON.stringify({
        error: {
            message: 'This model does not support assistant message prefill. The conversation must end with a user message.',
            recoverable_by_model: false,
        },
    })}`);
}

/**
 * Placeholder a scenario can put in tool arguments to reference every conversation id
 * that earlier delegate_task calls returned in this turn.
 */
const DELEGATED_IDS = '__DELEGATED_IDS__';

/** Placeholder for the pid an earlier backgrounded shell_command returned this turn. */
const BACKGROUND_PID = '__BACKGROUND_PID__';

function findBackgroundPid(ctx?: MockCtx): number | undefined {
    let latest: number | undefined;
    for (const step of ctx?.history?.steps ?? []) {
        for (const result of step?.observation?.results ?? []) {
            if (typeof result.content !== 'string') continue;
            const pid = result.content.match(/as pid (\d+)/)?.[1];
            if (pid) latest = Number(pid);
        }
    }
    return latest;
}

function findDelegatedConversationIds(ctx?: MockCtx): string[] {
    const ids: string[] = [];
    for (const step of ctx?.history?.steps ?? []) {
        for (const result of step?.observation?.results ?? []) {
            if (typeof result.content !== 'string') continue;
            try {
                const parsed = JSON.parse(result.content);
                if (parsed?.conversation_id) ids.push(parsed.conversation_id as string);
            } catch {
                // Not a delegate result.
            }
        }
    }
    return ids;
}

/** Swap placeholders for real handles, so a scenario can act on what it started. */
function resolveToolArguments(args: Record<string, unknown>, ctx?: MockCtx): Record<string, unknown> {
    if (args.pid === BACKGROUND_PID) {
        return { ...args, pid: findBackgroundPid(ctx) ?? -1 };
    }

    // Singular form, for tools that act on one task rather than waiting on several.
    if (args.conversation_id === DELEGATED_IDS) {
        return { ...args, conversation_id: findDelegatedConversationIds(ctx)[0] ?? 'unknown' };
    }

    const ids = args.conversation_ids;
    if (!Array.isArray(ids) || !ids.includes(DELEGATED_IDS)) return args;

    const delegated = findDelegatedConversationIds(ctx);
    return {
        ...args,
        conversation_ids: ids.flatMap(id => (id === DELEGATED_IDS ? delegated : [id])),
    };
}

// Track mock state per session+scenario+query so multiple conversations can run concurrently.
const scenarioState = new Map<string, { currentIteration: number }>();

// Parse scenarios from environment if provided
function getScenarios(): MockScenario[] {
    const envScenarios = process.env.PIPALI_MOCK_SCENARIOS;
    if (envScenarios) {
        try {
            return JSON.parse(envScenarios);
        } catch {
            console.warn('[MockPreload] Failed to parse PIPALI_MOCK_SCENARIOS, using defaults');
        }
    }
    return defaultMockScenarios;
}

const scenarios = getScenarios();
console.log(`[MockPreload] Loaded ${scenarios.length} mock scenarios`);

function getStateKey(query: string, scenarioName: string, ctx?: MockCtx): string {
    const sessionId = ctx?.sessionId ?? 'no-session';
    return `${sessionId}::${scenarioName}::${query}`;
}

/**
 * Generate mock response based on query and scenario
 */
function getMockResponse(query: string, ctx?: MockCtx): ResponseWithThought | Promise<ResponseWithThought> {
    if (ctx?.messages) {
        recordRequest(query, ctx);
        rejectAssistantPrefill(ctx.messages);
    }

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

    const key = getStateKey(query, scenario.name, ctx);
    const sessionId = ctx?.sessionId;

    // Get or initialize scenario state for this session/query
    let state = scenarioState.get(key);
    if (!state) {
        if (sessionId) {
            console.log(`[MockLLM] Initializing state for session: ${sessionId} scenario: ${scenario.name}`);
        }
        state = { currentIteration: 0 };
        scenarioState.set(key, state);
    }

    const iterations = scenario.iterations;

    // If we've exhausted iterations, return final response
    if (state.currentIteration >= iterations.length) {
        console.log(`[MockLLM] Scenario ${scenario.name} complete, returning final response`);
        scenarioState.delete(key);
        const finalResponse: ResponseWithThought = {
            message: scenario.finalResponse,
            raw: [],
            thought: undefined,
        };
        // Async (not sync) sleep, so a mid-flight soft interrupt lands before the run ends.
        if (scenario.finalResponseDelayMs && scenario.finalResponseDelayMs > 0) {
            return Bun.sleep(scenario.finalResponseDelayMs).then(() => finalResponse);
        }
        return finalResponse;
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

    // Return in the format expected by director (ResponseOutputItem[] for tool calls)
    return {
        message: undefined,
        raw: iteration.toolCalls.map((tc) => ({
            type: 'function_call' as const,
            id: tc.tool_call_id,
            call_id: tc.tool_call_id,
            name: tc.function_name,
            arguments: JSON.stringify(resolveToolArguments(tc.arguments as Record<string, unknown>, ctx)),
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
    console.log('[MockLLM] State reset');
}

// Declare the reset function type for global access
declare global {
    var __pipaliMockReset: typeof resetMockState | undefined;
}

globalThis.__pipaliMockLLM = getMockResponse;
globalThis.__pipaliMockReset = resetMockState;

console.log('[MockPreload] ✅ Mock LLM initialized');
