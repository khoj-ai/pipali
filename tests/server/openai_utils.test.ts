import { test, expect, describe } from 'bun:test';
import { ToolMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { formatMessagesForOpenAI } from '../../src/server/processor/conversation/openai/utils';

describe('formatMessagesForOpenAI', () => {
    describe('non-image messages', () => {
        test('should pass through SystemMessage unchanged', () => {
            const messages = [new SystemMessage('You are a helpful assistant')];
            const result = formatMessagesForOpenAI(messages);

            expect(result.length).toBe(1);
            expect(result[0]).toBeInstanceOf(SystemMessage);
            expect(result[0]!.content).toBe('You are a helpful assistant');
        });

        test('should pass through HumanMessage unchanged', () => {
            const messages = [new HumanMessage('Hello')];
            const result = formatMessagesForOpenAI(messages);

            expect(result.length).toBe(1);
            expect(result[0]).toBeInstanceOf(HumanMessage);
            expect(result[0]!.content).toBe('Hello');
        });

        test('should pass through AIMessage unchanged', () => {
            const messages = [new AIMessage('Hi there!')];
            const result = formatMessagesForOpenAI(messages);

            expect(result.length).toBe(1);
            expect(result[0]).toBeInstanceOf(AIMessage);
            expect(result[0]!.content).toBe('Hi there!');
        });

        test('should pass through text-only ToolMessage unchanged', () => {
            const messages = [
                new ToolMessage({
                    content: 'File contents here',
                    tool_call_id: 'call_123',
                    name: 'view_file',
                }),
            ];
            const result = formatMessagesForOpenAI(messages);

            expect(result.length).toBe(1);
            expect(result[0]).toBeInstanceOf(ToolMessage);
            expect(result[0]!.content).toBe('File contents here');
        });
    });

    describe('image content handling', () => {
        test('should convert ToolMessage with provider-agnostic image format to HumanMessage', () => {
            const imageContent = [
                { type: 'text', text: 'Read image file: test.png\nSize: 1.5 KB\nFormat: image/png' },
                {
                    type: 'image',
                    source_type: 'base64',
                    mime_type: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                },
            ];

            const messages = [
                new ToolMessage({
                    content: imageContent,
                    tool_call_id: 'call_456',
                    name: 'view_file',
                }),
            ];

            const result = formatMessagesForOpenAI(messages);

            // Should produce 2 messages: text-only ToolMessage + HumanMessage with image
            expect(result.length).toBe(2);

            // First message: text-only ToolMessage for tool result acknowledgment
            expect(result[0]).toBeInstanceOf(ToolMessage);
            const toolMsg = result[0] as ToolMessage;
            expect(toolMsg.content).toBe('Read image file: test.png\nSize: 1.5 KB\nFormat: image/png');
            expect(toolMsg.tool_call_id).toBe('call_456');

            // Second message: HumanMessage with OpenAI-formatted image
            expect(result[1]).toBeInstanceOf(HumanMessage);
            const humanMsg = result[1] as HumanMessage;
            expect(Array.isArray(humanMsg.content)).toBe(true);

            const content = humanMsg.content as Array<{ type: string; [key: string]: any }>;
            expect(content.length).toBe(2);

            // Text block should be preserved
            expect(content[0]!.type).toBe('text');
            expect(content[0]!.text).toContain('Read image file:');

            // Image should be converted to OpenAI format
            expect(content[1]!.type).toBe('image_url');
            expect(content[1]!.image_url).toBeDefined();
            expect(content[1]!.image_url.url).toMatch(/^data:image\/png;base64,/);
        });

        test('should pass through already OpenAI-formatted image content', () => {
            const imageContent = [
                { type: 'text', text: 'Image description' },
                {
                    type: 'image_url',
                    image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
                },
            ];

            const messages = [
                new ToolMessage({
                    content: imageContent,
                    tool_call_id: 'call_789',
                    name: 'view_file',
                }),
            ];

            const result = formatMessagesForOpenAI(messages);

            expect(result.length).toBe(2);

            // HumanMessage should have image_url passed through unchanged
            const humanMsg = result[1] as HumanMessage;
            const content = humanMsg.content as Array<{ type: string; [key: string]: any }>;
            expect(content[1]!.type).toBe('image_url');
            expect(content[1]!.image_url.url).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
        });

        test('should use default text when no text block in image content', () => {
            const imageContent = [
                {
                    type: 'image',
                    source_type: 'base64',
                    mime_type: 'image/png',
                    data: 'abc123',
                },
            ];

            const messages = [
                new ToolMessage({
                    content: imageContent,
                    tool_call_id: 'call_no_text',
                    name: 'view_file',
                }),
            ];

            const result = formatMessagesForOpenAI(messages);

            expect(result.length).toBe(2);

            // ToolMessage should have default text
            const toolMsg = result[0] as ToolMessage;
            expect(toolMsg.content).toBe('Image loaded successfully');
        });

        test('should handle multiple images in single ToolMessage', () => {
            const imageContent = [
                { type: 'text', text: 'Multiple images' },
                { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'png1data' },
                { type: 'image', source_type: 'base64', mime_type: 'image/jpeg', data: 'jpeg2data' },
            ];

            const messages = [
                new ToolMessage({
                    content: imageContent,
                    tool_call_id: 'call_multi',
                    name: 'view_file',
                }),
            ];

            const result = formatMessagesForOpenAI(messages);

            expect(result.length).toBe(2);

            const humanMsg = result[1] as HumanMessage;
            const content = humanMsg.content as Array<{ type: string; [key: string]: any }>;
            expect(content.length).toBe(3);
            expect(content[1]!.type).toBe('image_url');
            expect(content[1]!.image_url.url).toBe('data:image/png;base64,png1data');
            expect(content[2]!.type).toBe('image_url');
            expect(content[2]!.image_url.url).toBe('data:image/jpeg;base64,jpeg2data');
        });
    });

    describe('mixed message sequences', () => {
        test('should handle conversation with image tool call in context', () => {
            const messages = [
                new SystemMessage('You are a helpful assistant'),
                new HumanMessage('What is in this image?'),
                new AIMessage({
                    content: '',
                    tool_calls: [{ id: 'call_img', name: 'view_file', args: { path: 'photo.png' } }],
                }),
                new ToolMessage({
                    content: [
                        { type: 'text', text: 'Read image file: photo.png' },
                        { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'imagedata' },
                    ],
                    tool_call_id: 'call_img',
                    name: 'view_file',
                }),
            ];

            const result = formatMessagesForOpenAI(messages);

            // System + Human + AI + ToolMessage(text) + HumanMessage(image) = 5
            expect(result.length).toBe(5);
            expect(result[0]).toBeInstanceOf(SystemMessage);
            expect(result[1]).toBeInstanceOf(HumanMessage);
            expect(result[2]).toBeInstanceOf(AIMessage);
            expect(result[3]).toBeInstanceOf(ToolMessage);
            expect(result[4]).toBeInstanceOf(HumanMessage);

            // Verify the image is in the last HumanMessage
            const imgHumanMsg = result[4] as HumanMessage;
            const content = imgHumanMsg.content as Array<{ type: string; [key: string]: any }>;
            expect(content[1]!.type).toBe('image_url');
        });

        test('should handle multiple tool calls with one being an image', () => {
            const messages = [
                new AIMessage({
                    content: '',
                    tool_calls: [
                        { id: 'call_text', name: 'view_file', args: { path: 'readme.md' } },
                        { id: 'call_img', name: 'view_file', args: { path: 'diagram.png' } },
                    ],
                }),
                new ToolMessage({
                    content: '# Readme\nThis is a readme file.',
                    tool_call_id: 'call_text',
                    name: 'view_file',
                }),
                new ToolMessage({
                    content: [
                        { type: 'text', text: 'Read image file: diagram.png' },
                        { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'pngdata' },
                    ],
                    tool_call_id: 'call_img',
                    name: 'view_file',
                }),
            ];

            const result = formatMessagesForOpenAI(messages);

            // AI + ToolMessage(text) + ToolMessage(text for image) + HumanMessage(image) = 4
            expect(result.length).toBe(4);
            expect(result[0]).toBeInstanceOf(AIMessage);
            expect(result[1]).toBeInstanceOf(ToolMessage);
            expect((result[1] as ToolMessage).content).toContain('Readme');
            expect(result[2]).toBeInstanceOf(ToolMessage);
            expect((result[2] as ToolMessage).content).toBe('Read image file: diagram.png');
            expect(result[3]).toBeInstanceOf(HumanMessage);
        });
    });
});
