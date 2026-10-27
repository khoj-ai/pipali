import { test, expect, describe } from 'bun:test';
import { buildChatHistory, mergeHistoryWithLive } from '../../src/client/utils/chat-messages';
import type { Message } from '../../src/client/types';
import type { ATIFStep } from '../../src/server/processor/conversation/atif/atif.types';

function userMsg(id: string, content: string, opts?: Partial<Message>): Message {
    return { id, stableId: id, role: 'user', content, ...opts };
}

function assistantMsg(id: string, content: string, opts?: Partial<Message>): Message {
    return { id, stableId: id, role: 'assistant', content, ...opts };
}

const toolThought = (id: string, name: string, result?: string) => ({
    id, type: 'tool_call' as const, content: '', toolName: name,
    ...(result !== undefined ? { toolResult: result } : { isPending: true }),
});

describe('mergeHistoryWithLive — soft interrupt duplication', () => {
    /**
     * Core bug repro: after a soft interrupt, the interrupted run's assistant
     * (UUID stableId, no content, with thoughts) was incorrectly preserved
     * and appended at the end of the chat — duplicating the thoughts already
     * present in history under a numeric step_id.
     */
    test('interrupted run assistant is NOT duplicated after history merge', () => {
        const history: Message[] = [
            userMsg('1', 'original question'),
            assistantMsg('2', '', {
                thoughts: [toolThought('tc1', 'search', 'r1'), toolThought('tc2', 'read', 'r2')],
            }),
            userMsg('4', 'interrupt message'),
            assistantMsg('6', 'final response', {
                thoughts: [toolThought('tc3', 'search', 'r3')],
            }),
        ];

        const live: Message[] = [
            userMsg('1', 'original question'),
            // Run A: stopped, thoughts but no content, UUID stableId
            assistantMsg('run-A', '', {
                stableId: 'run-A', isStreaming: false,
                thoughts: [toolThought('tc1', 'search', 'r1'), toolThought('tc2', 'read', 'r2')],
            }),
            userMsg('4', 'interrupt message'),
            // Run B: completed, content present, UUID stableId, numeric id matching history
            assistantMsg('6', 'final response', {
                stableId: 'run-B', isStreaming: false,
                thoughts: [toolThought('tc3', 'search', 'r3')],
            }),
        ];

        const merged = mergeHistoryWithLive(history, live);

        expect(merged).toHaveLength(4);
        // The last message must be the final response, not a duplicate of run A's thoughts
        expect(merged[3]!.content).toBe('final response');
    });

    /**
     * Edge case: user interrupts twice rapidly (A → B → C). Both A and B are
     * stopped runs with thoughts but no content. Neither should survive merge.
     */
    test('multiple interrupted runs do not duplicate', () => {
        const history: Message[] = [
            userMsg('1', 'q1'),
            assistantMsg('2', '', { thoughts: [toolThought('tc1', 'search', 'r1')] }),
            userMsg('3', 'interrupt 1'),
            assistantMsg('4', '', { thoughts: [toolThought('tc2', 'read', 'r2')] }),
            userMsg('5', 'interrupt 2'),
            assistantMsg('7', 'done', { thoughts: [toolThought('tc3', 'write', 'r3')] }),
        ];

        const live: Message[] = [
            userMsg('1', 'q1'),
            assistantMsg('run-A', '', {
                stableId: 'run-A', isStreaming: false,
                thoughts: [toolThought('tc1', 'search', 'r1')],
            }),
            userMsg('3', 'interrupt 1'),
            assistantMsg('run-B', '', {
                stableId: 'run-B', isStreaming: false,
                thoughts: [toolThought('tc2', 'read', 'r2')],
            }),
            userMsg('5', 'interrupt 2'),
            assistantMsg('7', 'done', {
                stableId: 'run-C', isStreaming: false,
                thoughts: [toolThought('tc3', 'write', 'r3')],
            }),
        ];

        const merged = mergeHistoryWithLive(history, live);

        expect(merged).toHaveLength(6);
        expect(merged[5]!.content).toBe('done');
    });

    /**
     * History loads while a run is still streaming. The live streaming placeholder
     * must survive the merge so step_start events can attach to it.
     */
    test('streaming placeholder survives merge with partial history', () => {
        // History was persisted up through the last completed turn
        const history: Message[] = [
            userMsg('1', 'question'),
            assistantMsg('2', 'previous answer'),
            userMsg('3', 'follow-up'),
        ];

        // Live state: user sent follow-up, assistant is mid-run with some thoughts
        const live: Message[] = [
            userMsg('1', 'question'),
            assistantMsg('2', 'previous answer'),
            userMsg('3', 'follow-up'),
            assistantMsg('run-X', '', {
                stableId: 'run-X', isStreaming: true,
                thoughts: [toolThought('tc1', 'search', 'r1'), toolThought('tc2', 'read')],
            }),
        ];

        const merged = mergeHistoryWithLive(history, live);

        expect(merged).toHaveLength(4);
        expect(merged[3]!.isStreaming).toBe(true);
        expect(merged[3]!.thoughts).toHaveLength(2);
    });

    test('run error card survives merge because it is not persisted', () => {
        const history: Message[] = [
            userMsg('1', 'question'),
            assistantMsg('2', '', { thoughts: [toolThought('tc1', 'read', 'ok')] }),
        ];

        const live: Message[] = [
            ...history,
            assistantMsg('run-error-1', '', {
                runErrorInfo: { message: '{"error":{"message":"provider failed"}}' },
            }),
        ];

        const merged = mergeHistoryWithLive(history, live);

        expect(merged).toHaveLength(3);
        expect(merged[2]?.runErrorInfo?.message).toContain('provider failed');
        expect(merged[2]?.content).toBe('');
    });

    /**
     * Completed assistant has UUID stableId (not yet reconciled) but its numeric
     * id matches history. The role:id dedup should prevent duplication even though
     * stableIds differ.
     */
    test('completed assistant deduped by role:id when stableIds differ', () => {
        const history: Message[] = [
            userMsg('1', 'q'),
            assistantMsg('5', 'answer', { stableId: '5' }),
        ];

        const live: Message[] = [
            userMsg('1', 'q'),
            // RUN_COMPLETE set id='5' (stepId) but stableId stayed as UUID
            assistantMsg('5', 'answer', { stableId: 'run-uuid', isStreaming: false }),
        ];

        const merged = mergeHistoryWithLive(history, live);

        expect(merged).toHaveLength(2);
    });

    /**
     * Optimistic user message (UUID id, not yet persisted) must survive merge so
     * the user sees their message while the server processes it.
     */
    test('optimistic user message preserved until server persists it', () => {
        const history: Message[] = [
            userMsg('1', 'first question'),
            assistantMsg('2', 'first answer'),
        ];

        const live: Message[] = [
            userMsg('1', 'first question'),
            assistantMsg('2', 'first answer'),
            userMsg('client-uuid', 'follow-up', { stableId: 'client-uuid' }),
        ];

        const merged = mergeHistoryWithLive(history, live);

        expect(merged).toHaveLength(3);
        expect(merged[2]!.content).toBe('follow-up');
    });
});

describe('buildChatHistory — turns woken by background work', () => {
    const step = (step_id: number, source: ATIFStep['source'], fields: Partial<ATIFStep> = {}): ATIFStep => ({
        step_id,
        timestamp: `2026-10-26T18:${String(step_id).padStart(2, '0')}:00.000Z`,
        source,
        ...fields,
    });
    const toolStep = (step_id: number, name: string): ATIFStep => step(step_id, 'agent', {
        message: '',
        tool_calls: [{ tool_call_id: `call-${step_id}`, function_name: name, arguments: {} }],
        observation: { results: [{ source_call_id: `call-${step_id}`, content: 'ok' }] },
    });
    const recall = (step_id: number): ATIFStep => step(step_id, 'system', {
        message: `# Memory recalled\nmemory ${step_id}`,
        extra: { kind: 'memory_recall', memory_paths: ['a.md'] },
    });
    const label = (count: number) => `Recalled ${count}`;

    // The shape of a conversation that delegated work to a background command: the
    // command reporting back woke it into a turn with no user message of its own.
    const answered = [
        step(1, 'user', { message: 'Fix the dependabot alerts' }),
        recall(2),
        toolStep(3, 'shell_command'),
        step(4, 'agent', { message: 'Started Claude Code, I will report back.' }),
        step(5, 'system', { message: '[Background command finished]', extra: { kind: 'background_command_update' } }),
        recall(6),
        toolStep(7, 'view_file'),
    ];
    const wokenAnswer = step(8, 'agent', { message: 'Claude Code bumped the dependencies.' });

    test('a woken turn gets its own answer and steps, after the answer before it', () => {
        const { messages, turnOpen } = buildChatHistory([...answered, wokenAnswer], label);

        expect(messages.map(m => [m.role, m.id, m.content])).toEqual([
            ['user', '1', 'Fix the dependabot alerts'],
            ['assistant', '4', 'Started Claude Code, I will report back.'],
            ['assistant', '8', 'Claude Code bumped the dependencies.'],
        ]);
        expect(messages[1]!.thoughts?.map(t => t.toolName ?? t.content)).toEqual(['**Recalled 1**\n> memory 2', 'shell_command']);
        expect(messages[2]!.thoughts?.map(t => t.toolName ?? t.content)).toEqual(['**Recalled 1**\n> memory 6', 'view_file']);
        // Timed from the report that woke it, not from the user's message
        expect(messages[2]!.startedAt).toBe(answered[4]!.timestamp);
        expect(turnOpen).toBe(false);
    });

    test('a woken turn still running is open from just after the answer before it', () => {
        const midRun = buildChatHistory(answered, label);
        expect(midRun.messages.map(m => [m.id, m.isUnanswered])).toEqual([['1', undefined], ['4', undefined], ['7', true]]);
        // Its steps so far are its own, not the previous answer's
        expect(midRun.messages[1]!.thoughts).toHaveLength(2);
        expect(midRun.messages[2]!.thoughts?.map(t => t.toolName ?? t.content)).toEqual(['**Recalled 1**\n> memory 6', 'view_file']);
        expect(midRun.turnOpen).toBe(true);

        // Before its first step lands, only the report says a turn has begun
        const justWoken = buildChatHistory(answered.slice(0, 5), label);
        expect(justWoken.messages.map(m => m.id)).toEqual(['1', '4']);
        expect(justWoken.turnOpen).toBe(true);
    });

    test('a report the run in flight picks up stays in its turn', () => {
        const { messages, turnOpen } = buildChatHistory([
            step(1, 'user', { message: 'Run the tests in the background' }),
            toolStep(2, 'shell_command'),
            step(3, 'system', { message: '[Background command finished]', extra: { kind: 'background_command_update' } }),
            toolStep(4, 'view_file'),
            step(5, 'agent', { message: 'They passed while I was still working.' }),
        ], label);

        expect(messages.map(m => [m.id, m.thoughts?.length])).toEqual([['1', undefined], ['5', 2]]);
        expect(turnOpen).toBe(false);
    });

    test('a woken turn starts no earlier than the answer it follows', () => {
        const answer = step(4, 'agent', { message: 'Started them, I will report back.' });
        const { messages } = buildChatHistory([
            step(1, 'user', { message: 'Run the tests in the background' }),
            answer,
            // Delivered while the answer was being written, then moved after it to wake a turn
            step(5, 'system', {
                message: '[Background command finished]',
                extra: { kind: 'background_command_update' },
                timestamp: step(3, 'system').timestamp,
            }),
            step(6, 'agent', { message: 'They passed.' }),
        ], label);

        expect(messages[2]!.startedAt).toBe(answer.timestamp);
    });

    test('steps after an answer with no turn opened get an untimed reply of their own', () => {
        // Left by a message deleted while its run was still going
        const { messages, turnOpen } = buildChatHistory([
            step(1, 'user', { message: 'Run the tests in the background' }),
            step(2, 'agent', { message: 'Started them, I will report back.' }),
            toolStep(3, 'view_file'),
        ], label);

        expect(messages.map(m => [m.id, m.startedAt, m.isUnanswered])).toEqual([
            ['1', undefined, undefined],
            ['2', step(1, 'user').timestamp, undefined],
            ['3', undefined, undefined],
        ]);
        expect(turnOpen).toBe(false);
    });
});
