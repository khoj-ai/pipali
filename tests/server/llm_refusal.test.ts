import { test, expect, describe, afterEach } from 'bun:test';
import { sendMessageToGpt } from '../../src/server/processor/conversation/openai';

/**
 * A model that declines to respond reaches the app in one of two shapes: the platform
 * reports a provider's policy stop as an incomplete response with reason content_filter,
 * and OpenAI reports a model's own refusal as a refusal part of a message. Both come
 * through the SDK's stream parser, so the stream here is synthetic SSE it really parses.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

const response = (overrides: Record<string, unknown>) => ({
    id: 'resp_1', object: 'response', created_at: 1, model: 'test-model', status: 'completed',
    output: [], output_text: '', error: null, incomplete_details: null, instructions: null, metadata: null,
    parallel_tool_calls: true, temperature: 1, tool_choice: 'auto', tools: [], top_p: 1,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    ...overrides,
});

const message = (content: unknown[]) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content });

async function ask(terminal: { type: string; response: Record<string, unknown> }) {
    const events = [{ type: 'response.created', response: response({ status: 'in_progress', usage: undefined }) }, terminal];
    const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;
    return sendMessageToGpt([{ role: 'user', content: 'Hello' }], 'test-model', 'key', 'http://llm.test/v1');
}

describe('a model declining to respond', () => {
    test('is a content_filter stop with the category and explanation the platform reports', async () => {
        const result = await ask({
            type: 'response.incomplete',
            response: response({
                status: 'incomplete',
                incomplete_details: { reason: 'content_filter' },
                metadata: { cost_usd: '0.000100', refusal_category: 'cyber', refusal_explanation: 'Looks like exploit development' },
            }),
        });

        expect(result.refusal).toEqual({ category: 'cyber', explanation: 'Looks like exploit development' });
        expect(result.usage?.completion_tokens).toBe(5);
    });

    test('keeps the explanation when the category is not one the app has copy for', async () => {
        const result = await ask({
            type: 'response.incomplete',
            response: response({
                status: 'incomplete',
                incomplete_details: { reason: 'content_filter' },
                metadata: { refusal_category: 'a_category_from_the_future', refusal_explanation: 'Flagged' },
            }),
        });

        expect(result.refusal).toEqual({ explanation: 'Flagged' });
    });

    test('is a refusal with nothing more to say when the provider gives no details', async () => {
        const result = await ask({
            type: 'response.incomplete',
            response: response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
        });

        expect(result.refusal).toEqual({});
    });

    test("is the model's own words when OpenAI reports a refusal part", async () => {
        const result = await ask({
            type: 'response.completed',
            response: response({ output: [message([{ type: 'refusal', refusal: 'I cannot help with that.' }])] }),
        });

        expect(result.refusal).toEqual({ explanation: 'I cannot help with that.' });
        expect(result.message).toBeUndefined();
    });
});

describe('a response that is not a refusal', () => {
    test('is not one when it ran out of output tokens', async () => {
        const result = await ask({
            type: 'response.incomplete',
            response: response({
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                output: [message([{ type: 'output_text', text: 'Cut off mid', annotations: [] }])],
            }),
        });

        expect(result.refusal).toBeUndefined();
        expect(result.message).toBe('Cut off mid');
    });

    test('is not one when it simply completed', async () => {
        const result = await ask({
            type: 'response.completed',
            response: response({ output: [message([{ type: 'output_text', text: 'Done.', annotations: [] }])] }),
        });

        expect(result.refusal).toBeUndefined();
        expect(result.message).toBe('Done.');
    });
});
