import { test, expect, describe } from 'bun:test';
import { getCollapsedPreviewThoughts } from '../../src/client/components/thoughts/ThoughtsSection';
import { newestSentence } from '../../src/client/components/thoughts/ThoughtItem';
import { formatCharCount } from '../../src/client/utils/formatting';
import {
    buildDelegatedTaskTitleMap,
    formatDelegationToolResult,
    formatToolArgsRich,
    getDelegatedConversationId,
} from '../../src/client/utils/formatting';
import { formatConversationHeader } from '../../src/shared';
import type { Thought } from '../../src/client/types';

describe('collapsed thoughts preview', () => {
    test('hides internal thinking', () => {
        const preview = getCollapsedPreviewThoughts([
            {
                id: 'thinking-1',
                type: 'thought',
                content: 'First line\n\nMost recent line',
                isInternalThought: true,
            },
        ]);

        expect(preview).toHaveLength(0);
    });

    test('does not show assistant-only messages without a tool step', () => {
        const message = '**Plan**\nRun the search before editing.';
        const preview = getCollapsedPreviewThoughts([
            {
                id: 'message-1',
                type: 'thought',
                content: message,
            },
        ]);

        expect(preview).toHaveLength(0);
    });

    test('keeps assistant messages and tool calls from the latest step only', () => {
        const toolCall: Thought = {
            id: 'tool-1',
            type: 'tool_call',
            content: '',
            toolName: 'list_files',
            toolArgs: { path: '.' },
            toolResult: '- src/\n- tests/',
            stepGroupId: 'step-2',
        };
        const secondToolCall: Thought = {
            id: 'tool-2',
            type: 'tool_call',
            content: '',
            toolName: 'view_file',
            toolArgs: { path: 'README.md' },
            toolResult: 'README contents',
            stepGroupId: 'step-2',
        };

        const preview = getCollapsedPreviewThoughts([
            {
                id: 'thinking-1',
                type: 'thought',
                content: 'Thinking',
                isInternalThought: true,
                stepGroupId: 'step-1',
            },
            {
                id: 'message-1',
                type: 'thought',
                content: 'Earlier step message.',
                stepGroupId: 'step-1',
            },
            {
                id: 'tool-0',
                type: 'tool_call',
                content: '',
                toolName: 'search_web',
                toolArgs: { query: 'earlier' },
                toolResult: 'Earlier result',
                stepGroupId: 'step-1',
            },
            {
                id: 'message-2',
                type: 'thought',
                content: 'I will inspect the workspace.',
                stepGroupId: 'step-2',
            },
            toolCall,
            secondToolCall,
        ]);

        expect(preview).toHaveLength(3);
        expect(preview[0]?.content).toBe('I will inspect the workspace.');
        expect(preview[1]?.type).toBe('tool_call');
        expect(preview[1]?.toolName).toBe('list_files');
        expect(preview[1]?.toolResult).toBeUndefined();
        expect(preview[2]?.type).toBe('tool_call');
        expect(preview[2]?.toolName).toBe('view_file');
        expect(preview[2]?.toolResult).toBeUndefined();
    });
});

describe('delegated conversation link', () => {
    const id = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';

    test('finds the conversation whether the task was backgrounded or waited on', () => {
        // Backgrounded delegation reports as JSON
        expect(getDelegatedConversationId('delegate_task', JSON.stringify({ status: 'started', conversation_id: id })))
            .toBe(id);
        // Delegation waited on in the foreground comes back as the inspect_task summary,
        // built by the server. Parsing what it actually writes is what keeps the two in step.
        expect(getDelegatedConversationId('delegate_task', `${formatConversationHeader(id)}\nTitle: Some task\nStatus: done`))
            .toBe(id);
    });

    test('offers no link when there is no task to open', () => {
        expect(getDelegatedConversationId('delegate_task', 'Error: Conversation not found')).toBeUndefined();
        expect(getDelegatedConversationId('delegate_task', undefined)).toBeUndefined();
        // Another tool naming a conversation is not a task this step started
        expect(getDelegatedConversationId('inspect_task', `Conversation: ${id}`)).toBeUndefined();
    });
});

describe('delegated task trajectory labels', () => {
    const id = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
    const delegationText = {
        background: 'in background',
        modelTier: (tier: string) => `to ${tier} model`,
        waitForTasks: (tasks: string) => `on ${tasks}`,
        noRunInProgress: 'No run was in progress.',
    };

    test('shows a selected model tier beside the delegated task title', () => {
        const formatted = formatToolArgsRich('delegate_task', {
            title: 'Review the proposal',
            message: 'Review it carefully.',
            model_tier: 'flagship',
        }, false, undefined, undefined, delegationText);

        expect(formatted?.text).toBe('Review the proposal');
        expect(formatted?.secondary?.toLowerCase()).toContain('flagship');
        expect(formatted?.secondary).toContain(delegationText.background);

        const inherited = formatToolArgsRich('delegate_task', {
            title: 'Review the proposal',
            message: 'Review it carefully.',
        }, false, undefined, undefined, delegationText);
        expect(inherited?.secondary).toContain(delegationText.background);
        expect(inherited?.secondary).not.toContain('model');
    });

    test('shows delegated task titles when waiting instead of conversation ids', () => {
        const titles = buildDelegatedTaskTitleMap([{
            type: 'tool_call',
            toolName: 'delegate_task',
            toolArgs: { title: 'Review the proposal' },
            toolResult: JSON.stringify({ status: 'started', conversation_id: id }),
        }]);

        const formatted = formatToolArgsRich('wait_for_tasks', {
            conversation_ids: [id],
        }, false, undefined, titles, delegationText);

        expect(formatted?.text).toContain('Review the proposal');
        expect(formatted?.text).not.toContain(id);
    });

    test('drops redundant machine results and cleans useful summaries', () => {
        const referencedId = '947d63f2-e63b-4a19-bae2-904d6a8bf89e';
        expect(formatDelegationToolResult('delegate_task', JSON.stringify({
            status: 'started',
            conversation_id: id,
        }))).toBeNull();

        const formatted = formatDelegationToolResult('wait_for_tasks', [
            formatConversationHeader(id),
            'Title: Review the proposal',
            'Status: completed or idle',
            '',
            'Final response:',
            'The proposal looks good.',
            formatConversationHeader(referencedId),
        ].join('\n'));

        expect(formatted).toContain('The proposal looks good.');
        expect(formatted).not.toContain(id);
        expect(formatted).toContain(referencedId);
    });
});

describe('file tool formatting', () => {
    test('hides the memory directory for every file operation across platforms', () => {
        const unixMemory = '/Users/alex/.pipali/memory/prefers-short-replies.md';
        const windowsMemory = 'C:\\Users\\alex\\.pipali\\memory\\prefers-short-replies.md';

        for (const [toolName, args] of [
            ['view_file', { path: unixMemory }],
            ['edit_file', { file_path: unixMemory }],
            ['write_file', { file_path: unixMemory }],
            ['view_file', { path: windowsMemory }],
        ] as const) {
            expect(formatToolArgsRich(toolName, args)).toMatchObject({
                text: 'prefers-short-replies.md',
                secondary: 'in memories',
            });
        }
    });

    test('extracts and shortens ordinary file locations across platforms', () => {
        expect(formatToolArgsRich('view_file', { path: '/work/notes.md' })?.secondary).toBe('in /work');
        expect(formatToolArgsRich('view_file', { path: 'C:\\Users\\alex\\Documents\\notes.md' })).toMatchObject({
            text: 'notes.md',
            secondary: 'in Documents',
        });
    });
});

describe('sampled reasoning line', () => {
    test('holds the last finished sentence while the next is being written', () => {
        // Sampling mid-sentence would show a fragment starting mid-word
        expect(newestSentence('A poem it is, then. I should pick a form. Maybe a son'))
            .toBe('I should pick a form.');
    });

    test('shows the opening sentence before any is finished', () => {
        expect(newestSentence('The user wants a poem')).toBe('The user wants a poem');
    });

    test('advances once the sentence closes', () => {
        expect(newestSentence('The user wants a poem. Sonnet, then.')).toBe('Sonnet, then.');
    });

    test('does not mistake list markers and abbreviations for sentence ends', () => {
        // Models that number their reasoning steps otherwise strand the row on "2."
        expect(newestSentence('1. First I need to read the file. 2. Then I sho'))
            .toBe('1. First I need to read the file.');
        expect(newestSentence('Let me check the config. e.g. the timeout is wro'))
            .toBe('Let me check the config.');
        expect(newestSentence('It uses v1.2 of the schema so I should upda'))
            .toBe('It uses v1.2 of the schema so I should upda');
    });

    test('tracks the newest paragraph', () => {
        expect(newestSentence('Form settled.\n\nNow the rhyme scheme. Working through it'))
            .toBe('Now the rhyme scheme.');
    });
});

describe('streamed character counts', () => {
    test('reads compactly above a thousand', () => {
        expect(formatCharCount(347)).toBe('347');
        expect(formatCharCount(1100)).toBe('1.1K');
        expect(formatCharCount(12345)).toBe('12.3K');
        expect(formatCharCount(1_234_567)).toBe('1.2M');
    });

    test('holds its width as it ticks, so the row does not jitter', () => {
        // 1.0K rather than 1K: a counter that changes width redraws the whole row
        expect(formatCharCount(1000)).toBe('1.0K');
        expect(formatCharCount(1090)).toBe('1.1K');
    });
});
