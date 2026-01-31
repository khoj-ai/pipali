import { test, expect, describe } from 'bun:test';
import { truncateToolOutput, MAX_TOOL_OUTPUT_CHARS, buildSystemPrompt } from '../../src/server/processor/director';
import { isFirstRunEasterEgg } from '../../src/server/utils';

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
