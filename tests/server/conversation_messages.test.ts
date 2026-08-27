import { test, expect, describe } from 'bun:test';
import type { Responses } from 'openai/resources/responses/responses';
import { toOpenaiTools, getReasoningText } from '../../src/server/processor/conversation/openai/utils';
import { generateChatmlMessagesWithContext } from '../../src/server/processor/conversation/utils';
import type { ATIFStep } from '../../src/server/processor/conversation/atif/atif.types';

describe('toOpenaiTools', () => {
    test('should return undefined for undefined input', () => {
        expect(toOpenaiTools(undefined)).toBeUndefined();
    });

    test('should return undefined for empty array', () => {
        expect(toOpenaiTools([])).toEqual([]);
    });

    test('should convert single tool definition to OpenAI format', () => {
        const tools = [
            {
                name: 'view_file',
                description: 'Read a file',
                schema: { type: 'object', properties: { path: { type: 'string' } } }
            }
        ];
        const result = toOpenaiTools(tools);

        expect(result).toBeDefined();
        expect(result).toHaveLength(1);
        expect(result![0]).toMatchObject({
            type: 'function',
            name: 'view_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
            strict: false,
        });
    });

    test('should convert multiple tool definitions', () => {
        const tools = [
            { name: 'view_file', schema: { type: 'object' } },
            { name: 'edit_file', description: 'Edit a file', schema: { type: 'object' } },
            { name: 'shell_command', schema: { type: 'object' } }
        ];
        const result = toOpenaiTools(tools);

        expect(result).toHaveLength(3);
        expect(result![0]).toMatchObject({ name: 'view_file' });
        expect((result![0] as { description?: string }).description).toBeUndefined();
        expect(result![1]).toMatchObject({ name: 'edit_file', description: 'Edit a file' });
        expect(result![2]).toMatchObject({ name: 'shell_command' });
    });
});

describe('getReasoningText', () => {
    test('should return undefined for undefined input', () => {
        expect(getReasoningText(undefined)).toBeUndefined();
    });

    test('should return undefined for empty summary array', () => {
        const reasoning = { id: '1', type: 'reasoning' as const, summary: [] };
        expect(getReasoningText(reasoning)).toBeUndefined();
    });

    test('should return single summary text', () => {
        const reasoning: Responses.ResponseReasoningItem = {
            id: '1',
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Thinking about the problem' }]
        };
        expect(getReasoningText(reasoning)).toBe('Thinking about the problem');
    });

    test('should concatenate multiple summary texts with double newlines', () => {
        const reasoning: Responses.ResponseReasoningItem = {
            id: '1',
            type: 'reasoning',
            summary: [
                { type: 'summary_text', text: 'First thought' },
                { type: 'summary_text', text: 'Second thought' },
                { type: 'summary_text', text: 'Third thought' }
            ]
        };
        expect(getReasoningText(reasoning)).toBe('First thought\n\nSecond thought\n\nThird thought');
    });
});

describe('generateChatmlMessagesWithContext', () => {
    describe('basic message types', () => {
        test('should create system message when provided', () => {
            const messages = generateChatmlMessagesWithContext('', undefined, 'You are a helpful assistant');

            expect(messages).toHaveLength(1);
            const msg = messages[0] as any;
            expect(msg.role).toBe('system');
            expect(msg.content).toBe('You are a helpful assistant');
        });

        test('should create user message from query', () => {
            const messages = generateChatmlMessagesWithContext('Hello, how are you?');

            expect(messages).toHaveLength(1);
            const msg = messages[0] as any;
            expect(msg.role).toBe('user');
            expect(msg.content).toBe('Hello, how are you?');
        });

        test('should not create user message for empty query', () => {
            const messages = generateChatmlMessagesWithContext('');
            expect(messages).toHaveLength(0);
        });

        test('should combine system message and query', () => {
            const messages = generateChatmlMessagesWithContext('Hello', undefined, 'You are helpful');

            expect(messages).toHaveLength(2);
            expect((messages[0] as any).role).toBe('system');
            expect((messages[0] as any).content).toBe('You are helpful');
            expect((messages[1] as any).role).toBe('user');
            expect((messages[1] as any).content).toBe('Hello');
        });

        test('should skip leading ATIF system steps and preserve later system steps in order', () => {
            const history: Partial<ATIFStep>[] = [
                { step_id: 1, source: 'system', message: 'Persisted base prompt' },
                { step_id: 2, source: 'system', message: 'Persisted base extension' },
                { step_id: 3, source: 'user', message: 'First question' },
                { step_id: 4, source: 'agent', message: 'First answer' },
                { step_id: 5, source: 'system', message: 'New system context' },
                { step_id: 6, source: 'user', message: 'Follow up' },
            ];

            const messages = generateChatmlMessagesWithContext(
                '',
                history as ATIFStep[],
                'Current base prompt',
            );

            expect(messages.map((message: any) => [message.role, message.content])).toEqual([
                ['system', 'Current base prompt'],
                ['user', 'First question'],
                ['assistant', 'First answer'],
                ['system', 'New system context'],
                ['user', 'Follow up'],
            ]);
        });
    });

    describe('user history', () => {
        test('should handle single user message in history', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'First question' }
            ];
            const messages = generateChatmlMessagesWithContext('Follow up', history as ATIFStep[]);

            expect(messages).toHaveLength(2);
            expect((messages[0] as any).role).toBe('user');
            expect((messages[0] as any).content).toBe('First question');
            expect((messages[1] as any).role).toBe('user');
            expect((messages[1] as any).content).toBe('Follow up');
        });

        test('should handle multiple user messages in history', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'Question 1' },
                { source: 'user', message: 'Question 2' },
                { source: 'user', message: 'Question 3' }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect(messages).toHaveLength(3);
            expect((messages[0] as any).content).toBe('Question 1');
            expect((messages[1] as any).content).toBe('Question 2');
            expect((messages[2] as any).content).toBe('Question 3');
        });

        test('should handle empty user message', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: '' }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect(messages).toHaveLength(1);
            expect((messages[0] as any).content).toBe('');
        });
    });

    describe('agent history without tool calls', () => {
        test('should create assistant message for agent response', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'agent', message: 'Here is my response' }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect(messages).toHaveLength(1);
            expect((messages[0] as any).role).toBe('assistant');
            expect((messages[0] as any).content).toBe('Here is my response');
        });

        test('should skip agent step with empty message and no tool calls', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'agent', message: '' }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect(messages).toHaveLength(0);
        });
    });

    describe('agent history with tool calls', () => {
        test('should create function_call and function_call_output for tool interaction', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: 'Let me check that file',
                    tool_calls: [
                        { tool_call_id: 'call_123', function_name: 'view_file', arguments: { path: 'test.txt' } }
                    ],
                    observation: {
                        results: [
                            { source_call_id: 'call_123', content: 'File contents here' }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect(messages).toHaveLength(3);

            // Assistant message
            expect((messages[0] as any).role).toBe('assistant');
            expect((messages[0] as any).content).toBe('Let me check that file');

            // Function call
            expect((messages[1] as any).type).toBe('function_call');
            expect((messages[1] as any).call_id).toBe('call_123');
            expect((messages[1] as any).name).toBe('view_file');
            expect((messages[1] as any).arguments).toBe('{"path":"test.txt"}');

            // Function output
            expect((messages[2] as any).type).toBe('function_call_output');
            expect((messages[2] as any).call_id).toBe('call_123');
            expect((messages[2] as any).output).toBe('File contents here');
        });

        test('should handle multiple tool calls in single agent step', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_1', function_name: 'view_file', arguments: { path: 'a.txt' } },
                        { tool_call_id: 'call_2', function_name: 'view_file', arguments: { path: 'b.txt' } }
                    ],
                    observation: {
                        results: [
                            { source_call_id: 'call_1', content: 'Content A' },
                            { source_call_id: 'call_2', content: 'Content B' }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // 2 function calls + 2 function outputs = 4 messages
            expect(messages).toHaveLength(4);

            expect((messages[0] as any).type).toBe('function_call');
            expect((messages[0] as any).call_id).toBe('call_1');
            expect((messages[1] as any).type).toBe('function_call');
            expect((messages[1] as any).call_id).toBe('call_2');

            expect((messages[2] as any).type).toBe('function_call_output');
            expect((messages[2] as any).call_id).toBe('call_1');
            expect((messages[2] as any).output).toBe('Content A');
            expect((messages[3] as any).type).toBe('function_call_output');
            expect((messages[3] as any).call_id).toBe('call_2');
            expect((messages[3] as any).output).toBe('Content B');
        });

        test('should JSON stringify non-string tool arguments', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_1', function_name: 'search', arguments: { query: 'test', limit: 10 } }
                    ],
                    observation: { results: [{ source_call_id: 'call_1', content: 'results' }] }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect((messages[0] as any).arguments).toBe('{"query":"test","limit":10}');
        });

        test('should JSON stringify object content in tool output', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_1', function_name: 'get_data', arguments: {} }
                    ],
                    observation: {
                        results: [
                            { source_call_id: 'call_1', content: { key: 'value', nested: { data: 123 } } as any }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            const output = (messages[1] as any).output;
            expect(output).toBe('{"key":"value","nested":{"data":123}}');
        });
    });

    describe('image content handling', () => {
        test('should convert provider-agnostic image format to OpenAI input_image', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_img', function_name: 'view_file', arguments: { path: 'photo.png' } }
                    ],
                    observation: {
                        results: [
                            {
                                source_call_id: 'call_img',
                                content: [
                                    { type: 'text', text: 'Read image file: photo.png\nSize: 1.5 KB' },
                                    { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'iVBORw0KGgo=' }
                                ]
                            }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // function_call + function_call_output with multimodal content
            expect(messages).toHaveLength(2);

            expect((messages[0] as any).type).toBe('function_call');

            // Function output contains multimodal content directly
            const output = (messages[1] as any).output;
            expect(Array.isArray(output)).toBe(true);
            expect(output).toHaveLength(2);
            expect(output[0].type).toBe('input_text');
            expect(output[0].text).toContain('Read image file:');
            expect(output[1].type).toBe('input_image');
            expect(output[1].image_url).toBe('data:image/png;base64,iVBORw0KGgo=');
        });

        test('should handle multiple images in single tool result', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_1', function_name: 'view_file', arguments: { path: 'images/' } }
                    ],
                    observation: {
                        results: [
                            {
                                source_call_id: 'call_1',
                                content: [
                                    { type: 'text', text: 'Multiple images loaded' },
                                    { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'png1data' },
                                    { type: 'image', source_type: 'base64', mime_type: 'image/jpeg', data: 'jpg2data' },
                                    { type: 'image', source_type: 'base64', mime_type: 'image/gif', data: 'gif3data' }
                                ]
                            }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            const output = (messages[1] as any).output;
            expect(output).toHaveLength(4);
            expect(output[0].type).toBe('input_text');
            expect(output[1].type).toBe('input_image');
            expect(output[1].image_url).toBe('data:image/png;base64,png1data');
            expect(output[2].type).toBe('input_image');
            expect(output[2].image_url).toBe('data:image/jpeg;base64,jpg2data');
            expect(output[3].type).toBe('input_image');
            expect(output[3].image_url).toBe('data:image/gif;base64,gif3data');
        });

        test('should use default text when image content has no text block', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_1', function_name: 'view_file', arguments: { path: 'img.png' } }
                    ],
                    observation: {
                        results: [
                            {
                                source_call_id: 'call_1',
                                content: [
                                    { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'abc' }
                                ]
                            }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            const output = (messages[1] as any).output;
            expect(Array.isArray(output)).toBe(true);
            expect(output).toHaveLength(1);
            expect(output[0].type).toBe('input_image');
            expect(output[0].image_url).toBe('data:image/png;base64,abc');
        });

        test('should not convert non-image array content', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_1', function_name: 'list_files', arguments: {} }
                    ],
                    observation: {
                        results: [
                            {
                                source_call_id: 'call_1',
                                content: [
                                    { type: 'file', name: 'a.txt' },
                                    { type: 'file', name: 'b.txt' }
                                ]
                            }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // Should be JSON stringified, not converted to user message
            expect(messages).toHaveLength(2);
            expect((messages[1] as any).type).toBe('function_call_output');
            expect((messages[1] as any).output).toContain('"type":"file"');
        });
    });

    describe('raw output passthrough for multi-turn', () => {
        test('should pass through raw output items directly', () => {
            const rawOutput: Responses.ResponseOutputItem[] = [
                {
                    type: 'message',
                    id: 'm1',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Hello there', annotations: [] }],
                    status: 'completed'
                }
            ];
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: 'Hello there',
                    extra: { raw_output: rawOutput }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect(messages).toHaveLength(1);
            expect((messages[0] as any).type).toBe('message');
            expect((messages[0] as any).id).toBe('m1');
        });

        test('should pass through raw output with reasoning', () => {
            const rawOutput: Responses.ResponseOutputItem[] = [
                {
                    type: 'reasoning',
                    id: 'r1',
                    summary: [{ type: 'summary_text', text: 'Thinking...' }]
                },
                {
                    type: 'message',
                    id: 'm1',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Answer', annotations: [] }],
                    status: 'completed'
                }
            ];
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: 'Answer',
                    extra: { raw_output: rawOutput }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect(messages).toHaveLength(2);
            expect((messages[0] as any).type).toBe('reasoning');
            expect((messages[1] as any).type).toBe('message');
        });

        test('should pass through raw output with function calls', () => {
            const rawOutput: Responses.ResponseOutputItem[] = [
                {
                    type: 'function_call',
                    id: 'fc1',
                    call_id: 'call_abc',
                    name: 'view_file',
                    arguments: '{"path":"test.txt"}',
                    status: 'completed'
                }
            ];
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    extra: { raw_output: rawOutput },
                    observation: {
                        results: [{ source_call_id: 'call_abc', content: 'File content' }]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // Raw function call + function output
            expect(messages).toHaveLength(2);
            expect((messages[0] as any).type).toBe('function_call');
            expect((messages[0] as any).id).toBe('fc1');
            expect((messages[1] as any).type).toBe('function_call_output');
        });

        test('should fallback to manual construction when raw_output is empty', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: 'Response',
                    extra: { raw_output: [] }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            expect(messages).toHaveLength(1);
            expect((messages[0] as any).role).toBe('assistant');
        });
    });

    describe('compaction step filtering', () => {
        test('should start from compaction step when one exists', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'First question' },
                { source: 'agent', message: 'First answer' },
                { source: 'user', message: '[Handoff Context] Summary', extra: { is_compaction: true } },
                { source: 'agent', message: 'Response after compaction' },
                { source: 'user', message: 'Follow up question' }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // Only 3 messages from compaction point onwards (compaction step is included)
            expect(messages).toHaveLength(3);
            expect((messages[0] as any).content).toBe('[Handoff Context] Summary');
            expect((messages[1] as any).content).toBe('Response after compaction');
            expect((messages[2] as any).content).toBe('Follow up question');
        });

        test('should use most recent compaction step when multiple exist', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'Very old question' },
                { source: 'user', message: '[Handoff Context] First compaction', extra: { is_compaction: true } },
                { source: 'agent', message: 'Middle response' },
                { source: 'user', message: '[Handoff Context] Second compaction', extra: { is_compaction: true } },
                { source: 'agent', message: 'Final response' }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // Only 2 messages from the second (most recent) compaction
            expect(messages).toHaveLength(2);
            expect((messages[0] as any).content).toBe('[Handoff Context] Second compaction');
            expect((messages[1] as any).content).toBe('Final response');
        });

        test('should not treat step with other extra fields as compaction', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'First', extra: { some_other_field: true } },
                { source: 'agent', message: 'Response' },
                { source: 'user', message: 'Second' }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // All messages should be included since is_compaction is not true
            expect(messages).toHaveLength(3);
        });

        test('should preserve system message when compaction exists', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'Old question' },
                { source: 'agent', message: 'Old answer' },
                { source: 'user', message: '[Handoff Context] Summary', extra: { is_compaction: true } },
                { source: 'agent', message: 'New answer' }
            ];
            const messages = generateChatmlMessagesWithContext(
                '',
                history as ATIFStep[],
                'You are a helpful assistant'
            );

            // System message + 2 messages from compaction point onwards
            expect(messages).toHaveLength(3);
            expect((messages[0] as any).role).toBe('system');
            expect((messages[0] as any).content).toBe('You are a helpful assistant');
            expect((messages[1] as any).content).toBe('[Handoff Context] Summary');
            expect((messages[2] as any).content).toBe('New answer');
        });

        test('should discard injected system steps before the latest compaction', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'Old question' },
                { source: 'system', message: 'Temporary instruction' },
                { source: 'agent', message: 'Old answer' },
                { source: 'user', message: '[Handoff Context] Summary', extra: { is_compaction: true } },
                { source: 'agent', message: 'New answer' },
            ];

            const messages = generateChatmlMessagesWithContext(
                '',
                history as ATIFStep[],
                'Base prompt',
            );

            expect(messages.map((message: any) => message.content)).toEqual([
                'Base prompt',
                '[Handoff Context] Summary',
                'New answer',
            ]);
        });
    });

    describe('mixed conversation sequences', () => {
        test('should handle full conversation with system, user, agent, and tools', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'What is in this file?' },
                {
                    source: 'agent',
                    message: 'Let me read that file for you.',
                    tool_calls: [
                        { tool_call_id: 'call_1', function_name: 'view_file', arguments: { path: 'readme.md' } }
                    ],
                    observation: {
                        results: [{ source_call_id: 'call_1', content: '# Readme\nThis is a readme file.' }]
                    }
                },
                { source: 'user', message: 'Thanks! Can you summarize it?' }
            ];
            const messages = generateChatmlMessagesWithContext(
                'Also tell me the word count',
                history as ATIFStep[],
                'You are a helpful file assistant'
            );

            expect(messages).toHaveLength(7);

            // System message
            expect((messages[0] as any).role).toBe('system');

            // First user message
            expect((messages[1] as any).role).toBe('user');
            expect((messages[1] as any).content).toBe('What is in this file?');

            // Agent response
            expect((messages[2] as any).role).toBe('assistant');

            // Tool call
            expect((messages[3] as any).type).toBe('function_call');

            // Tool output
            expect((messages[4] as any).type).toBe('function_call_output');

            // Second user message from history
            expect((messages[5] as any).role).toBe('user');
            expect((messages[5] as any).content).toBe('Thanks! Can you summarize it?');

            // Current query
            expect((messages[6] as any).role).toBe('user');
            expect((messages[6] as any).content).toBe('Also tell me the word count');
        });

        test('should handle conversation with image tool call in context', () => {
            const history: Partial<ATIFStep>[] = [
                { source: 'user', message: 'What is in this image?' },
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_img', function_name: 'view_file', arguments: { path: 'photo.png' } }
                    ],
                    observation: {
                        results: [
                            {
                                source_call_id: 'call_img',
                                content: [
                                    { type: 'text', text: 'Read image: photo.png' },
                                    { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'imagedata' }
                                ]
                            }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // user + function_call + function_output (with multimodal content) = 3
            expect(messages).toHaveLength(3);
            expect((messages[0] as any).role).toBe('user');
            expect((messages[1] as any).type).toBe('function_call');
            expect((messages[2] as any).type).toBe('function_call_output');

            // Verify image is in the function output
            const output = (messages[2] as any).output;
            expect(Array.isArray(output)).toBe(true);
            expect(output[1].type).toBe('input_image');
        });

        test('should handle multiple tool calls where one returns an image', () => {
            const history: Partial<ATIFStep>[] = [
                {
                    source: 'agent',
                    message: '',
                    tool_calls: [
                        { tool_call_id: 'call_text', function_name: 'view_file', arguments: { path: 'readme.md' } },
                        { tool_call_id: 'call_img', function_name: 'view_file', arguments: { path: 'diagram.png' } }
                    ],
                    observation: {
                        results: [
                            { source_call_id: 'call_text', content: '# Readme\nThis is a readme file.' },
                            {
                                source_call_id: 'call_img',
                                content: [
                                    { type: 'text', text: 'Read image: diagram.png' },
                                    { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'pngdata' }
                                ]
                            }
                        ]
                    }
                }
            ];
            const messages = generateChatmlMessagesWithContext('', history as ATIFStep[]);

            // 2 function_calls + 2 function_outputs = 4
            expect(messages).toHaveLength(4);

            expect((messages[0] as any).type).toBe('function_call');
            expect((messages[0] as any).call_id).toBe('call_text');
            expect((messages[1] as any).type).toBe('function_call');
            expect((messages[1] as any).call_id).toBe('call_img');

            expect((messages[2] as any).type).toBe('function_call_output');
            expect((messages[2] as any).output).toContain('Readme');

            // Image tool output contains multimodal content
            expect((messages[3] as any).type).toBe('function_call_output');
            const imgOutput = (messages[3] as any).output;
            expect(Array.isArray(imgOutput)).toBe(true);
            expect(imgOutput[0].type).toBe('input_text');
            expect(imgOutput[1].type).toBe('input_image');
        });
    });
});
