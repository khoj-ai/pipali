import { test, expect, describe } from 'bun:test';
import { truncateToolOutput, MAX_TOOL_OUTPUT_CHARS, buildSystemPrompt, research } from '../../src/server/processor/director';
import { isFirstRunEasterEgg } from '../../src/server/utils';
import type { ATIFTrajectory, ATIFStep } from '../../src/server/processor/conversation/atif/atif.types';

type MultimodalContent = Array<{ type: string; [key: string]: string }>;

describe('truncateToolOutput', () => {
    describe('string content', () => {
        test('should not truncate strings under the limit', () => {
            const content = 'Short content';
            const result = truncateToolOutput(content);
            expect(result).toBe(content);
        });

        test('should not truncate strings exactly at the limit', () => {
            const content = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS);
            const result = truncateToolOutput(content);
            expect(result).toBe(content);
        });

        test('should truncate strings over the limit', () => {
            const content = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1000);
            const result = truncateToolOutput(content);

            expect(typeof result).toBe('string');
            expect((result as string).length).toBeLessThan(content.length);
            expect(result).toContain('[Output truncated:');
            expect(result).toContain(`showing first ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()}`);
            expect(result).toContain(`of ${content.length.toLocaleString()} characters]`);
        });

        test('should preserve beginning of truncated content', () => {
            const prefix = 'START_MARKER_';
            const content = prefix + 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1000);
            const result = truncateToolOutput(content) as string;

            expect(result.startsWith(prefix)).toBe(true);
        });
    });

    describe('multimodal array content', () => {
        test('should not truncate text items under the limit', () => {
            const content: MultimodalContent = [
                { type: 'text', text: 'Short text' },
                { type: 'image', data: 'base64data', mimeType: 'image/png' },
            ];
            const result = truncateToolOutput(content);

            expect(Array.isArray(result)).toBe(true);
            expect(result).toEqual(content);
        });

        test('should truncate text items over the limit', () => {
            const longText = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 500);
            const content: MultimodalContent = [
                { type: 'text', text: longText },
            ];
            const result = truncateToolOutput(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(1);
            expect(result[0]!.type).toBe('text');
            const text = result[0]!['text'];
            if (text === undefined) throw new Error('Expected text content');
            expect(text.length).toBeLessThan(longText.length);
            expect(text).toContain('[Output truncated:');
        });

        test('should preserve non-text items (images) unchanged', () => {
            const imageData = 'base64imagedata'.repeat(10000); // Large image data
            const content: MultimodalContent = [
                { type: 'text', text: 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 100) },
                { type: 'image', data: imageData, mimeType: 'image/png' },
            ];
            const result = truncateToolOutput(content) as MultimodalContent;

            expect(result.length).toBe(2);
            expect(result[1]!.type).toBe('image');
            expect(result[1]!.data).toBe(imageData); // Image data preserved exactly
        });

        test('should preserve non-text items (audio) unchanged', () => {
            const audioData = 'base64audiodata'.repeat(10000);
            const content: MultimodalContent = [
                { type: 'audio', data: audioData, mimeType: 'audio/mp3' },
            ];
            const result = truncateToolOutput(content) as MultimodalContent;

            expect(result.length).toBe(1);
            expect(result[0]!.type).toBe('audio');
            expect(result[0]!.data).toBe(audioData);
        });

        test('should handle mixed content with some text over limit', () => {
            const shortText = 'Short';
            const longText = 'y'.repeat(MAX_TOOL_OUTPUT_CHARS + 200);
            const content: MultimodalContent = [
                { type: 'text', text: shortText },
                { type: 'text', text: longText },
                { type: 'image', data: 'imgdata', mimeType: 'image/jpeg' },
            ];
            const result = truncateToolOutput(content) as MultimodalContent;

            // First text unchanged
            expect(result.length).toBe(3);
            expect(result[0]!['text']).toBe(shortText);
            // Second text truncated
            const truncated = result[1]!['text'];
            if (truncated === undefined) throw new Error('Expected text content');
            expect(truncated.length).toBeLessThan(longText.length);
            expect(truncated).toContain('[Output truncated:');
            // Image unchanged
            expect(result[2]!['data']).toBe('imgdata');
        });
    });
});

describe('buildSystemPrompt', () => {
    test('keeps memories on by default and removes the entire memory surface when disabled', async () => {
        const catalogue = 'prefers-short-answers.md (feedback): Prefer concise answers';
        const enabled = await buildSystemPrompt({ memoryCatalogue: catalogue });
        const disabled = await buildSystemPrompt({ memoryCatalogue: catalogue, memoriesEnabled: false });

        expect(enabled).toContain('persistent file-based memory');
        expect(enabled).toContain(catalogue);
        expect(enabled).toContain('write fact files');
        expect(disabled).not.toContain('persistent file-based memory');
        expect(disabled).not.toContain(catalogue);
        expect(disabled).not.toContain('write fact files');
        expect(disabled).not.toContain('<memory_catalogue>');
    });

    test('should include first conversation instructions when isFirstEverConversation is true', async () => {
        const prompt = await buildSystemPrompt({
            isFirstEverConversation: true,
            username: 'TestUser',
        });

        expect(prompt).toContain('First Conversation');
        expect(prompt).toContain('USER.md');
    });

    test('should not include first conversation instructions when isFirstEverConversation is false', async () => {
        const prompt = await buildSystemPrompt({
            isFirstEverConversation: false,
            username: 'TestUser',
        });

        expect(prompt).not.toContain('First Conversation');
    });

    test('should not include first conversation instructions when isFirstEverConversation is undefined', async () => {
        const prompt = await buildSystemPrompt({
            username: 'TestUser',
        });

        expect(prompt).not.toContain('First Conversation');
    });

    // The inventory is also gated on the deferral threshold; see shouldDeferMcpTools in search_tools.test.ts
    test('omits the external tool inventory when no MCP servers are connected', async () => {
        const prompt = await buildSystemPrompt({ username: 'TestUser' });

        expect(prompt).not.toContain('External Tools');
        expect(prompt).not.toContain('<connected_tools>');
        expect(prompt).not.toContain('{mcp_context}');
    });
});

const trajectory = (steps: Array<Partial<ATIFStep>>): ATIFTrajectory => ({
    schema_version: 'ATIF-v1.4',
    session_id: 'session-1',
    agent: { name: 'pipali-agent', version: '1.0.0', model_name: 'mock' },
    steps: steps.map((step, i) => ({
        step_id: i + 1,
        timestamp: new Date().toISOString(),
        source: 'user',
        ...step,
    })) as ATIFStep[],
});

describe('research request tracing', () => {
    // Requests are traced with the conversation row id, the handle that resolves
    // against /api/chat/:id/history. The ATIF session_id is a separate identifier.
    test('reports the conversation and run ids, not the ATIF session id', async () => {
        const previousMock = globalThis.__pipaliMockLLM;
        const traced: Array<Record<string, string | undefined>> = [];
        globalThis.__pipaliMockLLM = (_query, ctx) => {
            traced.push({ conversationId: ctx?.conversationId, sessionId: ctx?.sessionId, runId: ctx?.runId });
            return { message: 'Done.', raw: [] };
        };
        try {
            for await (const iteration of research({
                chatHistory: trajectory([{ source: 'user', message: 'hi' }]),
                conversationId: 'conversation-1',
                runId: 'run-1',
                maxIterations: 2,
            })) {
                if (iteration.isToolCallStart) continue;
            }
        } finally {
            globalThis.__pipaliMockLLM = previousMock;
        }

        // Distinct sentinels, so a slip in the positional call reads as a swap here
        expect(traced).toEqual([{ conversationId: 'conversation-1', sessionId: 'session-1', runId: 'run-1' }]);
    });
});

describe('easter egg onboarding trigger', () => {
    test('should match "we have not been properly introduced" variants', () => {
        expect(isFirstRunEasterEgg('we have not been properly introduced')).toBe(true);
        expect(isFirstRunEasterEgg('we have not been properly introduced!')).toBe(true);
        expect(isFirstRunEasterEgg("we haven't been properly introduced")).toBe(true);
        expect(isFirstRunEasterEgg("We havent been properly introduced")).toBe(true);
    });

    test('should match "i\'m new here"', () => {
        expect(isFirstRunEasterEgg("I'm new here")).toBe(true);
        expect(isFirstRunEasterEgg("im new here")).toBe(true);
        expect(isFirstRunEasterEgg("I am new here")).toBe(true);
        expect(isFirstRunEasterEgg("i am new here!")).toBe(true);
        expect(isFirstRunEasterEgg("Hi, I'm new here")).toBe(true);
        expect(isFirstRunEasterEgg("hi I am new here")).toBe(true);
    });

    test('should not match unrelated messages', () => {
        expect(isFirstRunEasterEgg('hello')).toBe(false);
        expect(isFirstRunEasterEgg('we have been introduced')).toBe(false);
        expect(isFirstRunEasterEgg('I think we have not been properly introduced yet')).toBe(false);
    });
});
