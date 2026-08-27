import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import {
    formatMemoryRecall,
    getMemory,
    hasMemoryInteraction,
    memoryPathsExtra,
    surfacedMemories,
    MEMORY_RECALL_KIND,
} from '../../src/server/memory';
import { parseSelectedMemories, recallMemories } from '../../src/server/memory/recall';

describe('memory recall', () => {
    const testDir = path.join(os.tmpdir(), 'memory-recall-tests');
    const previousDir = process.env.PIPALI_MEMORY_DIR;
    const previousMock = globalThis.__pipaliMockLLM;

    /** Stand in for the selector model, capturing what it was asked */
    const selectorReplies = (reply: string) => {
        const queries: string[] = [];
        globalThis.__pipaliMockLLM = (query: string) => {
            queries.push(query);
            return { message: reply };
        };
        return queries;
    };

    const memory = (file: string, description: string, body = 'Body.') =>
        Bun.write(
            path.join(testDir, file),
            `---\ndescription: ${description}\ntype: feedback\nmodified: 2026-08-01T00:00:00.000Z\n---\n\n${body}\n`,
        );

    beforeAll(() => {
        process.env.PIPALI_MEMORY_DIR = testDir;
    });

    beforeEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
        await fs.mkdir(testDir, { recursive: true });
    });

    afterAll(async () => {
        process.env.PIPALI_MEMORY_DIR = previousDir;
        globalThis.__pipaliMockLLM = previousMock;
        await fs.rm(testDir, { recursive: true, force: true });
    });

    describe('parseSelectedMemories', () => {
        test('reads plain JSON, fenced JSON, and JSON buried in prose', () => {
            expect(parseSelectedMemories('{"selected_memories": ["a.md", "b.md"]}')).toEqual(['a.md', 'b.md']);
            expect(parseSelectedMemories('```json\n{"selected_memories": ["a.md"]}\n```')).toEqual(['a.md']);
            expect(parseSelectedMemories('Sure! Here you go: {"selected_memories": []}')).toEqual([]);
        });

        test('reads the list when the model answers without the object around it', () => {
            // Small models routinely reply in these shapes despite the prompt asking
            // for an object, and reading only the object shape dropped the whole turn
            expect(parseSelectedMemories('```json\n<selected_memories>\n["a.md", "b.md"]\n</selected_memories>\n```'))
                .toEqual(['a.md', 'b.md']);
            expect(parseSelectedMemories('<selected_memories>\n[]\n</selected_memories>')).toEqual([]);
            expect(parseSelectedMemories('```json\n["a.md"]\n```')).toEqual(['a.md']);
            // A broken object no longer aborts the read when a usable list follows
            expect(parseSelectedMemories('picking {these}: ["a.md"]')).toEqual(['a.md']);
        });

        test('rejects replies that do not hold a selection', () => {
            expect(parseSelectedMemories('I could not decide.')).toBeUndefined();
            expect(parseSelectedMemories('{"selected_memories": "a.md"}')).toBeUndefined();
            expect(parseSelectedMemories('{broken json')).toBeUndefined();
            expect(parseSelectedMemories('')).toBeUndefined();
            // A reply carrying no list stays unreadable rather than an empty selection
            expect(parseSelectedMemories('```json\n<memory_catalogue>\n</memory_catalogue>\n```')).toBeUndefined();
        });

        test('keeps only string entries', () => {
            expect(parseSelectedMemories('{"selected_memories": ["a.md", 3, null]}')).toEqual(['a.md']);
        });
    });

    describe('surfacedMemories', () => {
        test('collects memory paths across steps and ignores malformed extras', () => {
            expect(surfacedMemories([
                { source: 'system', extra: { kind: MEMORY_RECALL_KIND, memory_paths: ['a.md', 'b.md'] } },
                { source: 'user', message: 'hi' },
                { source: 'system', extra: { kind: MEMORY_RECALL_KIND, memory_paths: ['b.md', 'c.md'] } },
                { source: 'system', extra: { memory_paths: 'not-an-array' } },
                { source: 'system', extra: { memory_paths: [42] } },
            ])).toEqual(new Set(['a.md', 'b.md', 'c.md']));

            expect(surfacedMemories([{ source: 'user', message: 'hi' }])).toEqual(new Set());
        });

        test('an agent step that opened a memory counts as holding it', () => {
            expect(surfacedMemories([
                { source: 'system', extra: { kind: MEMORY_RECALL_KIND, memory_paths: ['recalled.md'] } },
                { source: 'agent', extra: memoryPathsExtra([
                    { function_name: 'view_file', arguments: { path: path.join(testDir, 'opened.md') } },
                ]) },
            ])).toEqual(new Set(['recalled.md', 'opened.md']));
        });
    });

    describe('memoryPathsExtra', () => {
        test('names the memories a step opened or wrote, once each', () => {
            expect(memoryPathsExtra([
                { function_name: 'view_file', arguments: { path: path.join(testDir, 'a.md') } },
                { function_name: 'write_file', arguments: { file_path: path.join(testDir, 'b.md') } },
                { function_name: 'edit_file', arguments: { file_path: path.join(testDir, 'a.md') } },
            ])).toEqual({ memory_paths: ['a.md', 'b.md'] });
        });

        // A grep hit is matching lines, not the fact itself, so it must not suppress
        // the recall that would put the whole memory in context
        test('leaves a step that only searched or listed unstamped', () => {
            expect(memoryPathsExtra([
                { function_name: 'grep_files', arguments: { path: testDir } },
                { function_name: 'list_files', arguments: { path: testDir } },
                { function_name: 'view_file', arguments: { path: '/etc/hosts' } },
                { function_name: 'view_file', arguments: {} },
            ])).toBeUndefined();

            expect(memoryPathsExtra(undefined)).toBeUndefined();
        });
    });

    describe('formatMemoryRecall', () => {
        test('holds each body under its path and lists identities in extra', async () => {
            await memory('a-fact.md', 'The first fact', 'Use tabs.');
            await memory('b-fact.md', 'The second fact', 'Use spaces.');

            const recall = formatMemoryRecall([
                (await getMemory('a-fact.md'))!,
                (await getMemory('b-fact.md'))!,
            ]);

            expect(recall.message).toStartWith('# Memory recalled');
            expect(recall.message).toContain('use only if it actually applies');
            expect(recall.message).toContain(`Memory: ${path.join(testDir, 'a-fact.md')}\n\nUse tabs.`);
            expect(recall.message).toContain(`Memory: ${path.join(testDir, 'b-fact.md')}\n\nUse spaces.`);
            expect(recall.extra).toEqual({
                kind: MEMORY_RECALL_KIND,
                memory_paths: ['a-fact.md', 'b-fact.md'],
            });
        });

        test('truncates an oversized body instead of flooding the conversation', async () => {
            await memory('huge.md', 'An oversized memory', 'x'.repeat(10_000));

            const recall = formatMemoryRecall([(await getMemory('huge.md'))!]);

            expect(recall.message.length).toBeLessThan(10_000);
            expect(recall.message).toContain('[truncated - view the file for the rest]');
        });
    });

    test('hasMemoryInteraction counts a recall step as memory reaching the conversation', () => {
        expect(hasMemoryInteraction([
            { source: 'system', extra: { kind: MEMORY_RECALL_KIND, memory_paths: ['a.md'] } },
        ])).toBe(true);
    });

    describe('recallMemories', () => {
        test('injects what the selector picked and nothing else', async () => {
            await memory('editor.md', 'Preferred code editor', 'They use Helix.');
            await memory('ledger.md', 'Where the ledger lives', 'Under ~/finance.');
            const queries = selectorReplies('{"selected_memories": ["editor.md"]}');

            const recall = await recallMemories('which editor do I like?', new Set());

            expect(recall?.message).toContain('They use Helix.');
            expect(recall?.message).not.toContain('Under ~/finance.');
            expect(recall?.extra.memory_paths).toEqual(['editor.md']);
            // The selector saw the catalogue and the message, in one query
            expect(queries).toHaveLength(1);
            expect(queries[0]).toContain('editor.md (feedback): Preferred code editor');
            expect(queries[0]).toContain('which editor do I like?');
        });

        test('memories the conversation already holds are neither offered nor re-injected', async () => {
            await memory('editor.md', 'Preferred code editor');
            await memory('ledger.md', 'Where the ledger lives');
            // A selector gone rogue re-picks the surfaced memory anyway
            const queries = selectorReplies('{"selected_memories": ["editor.md"]}');

            const recall = await recallMemories('which editor do I like?', new Set(['editor.md']));

            expect(queries[0]).not.toContain('editor.md');
            expect(queries[0]).toContain('ledger.md');
            expect(recall).toBeUndefined();
        });

        test('ignores filenames the selector made up', async () => {
            await memory('editor.md', 'Preferred code editor');
            selectorReplies('{"selected_memories": ["invented.md", "editor.md"]}');

            const recall = await recallMemories('which editor do I like?', new Set());

            expect(recall?.extra.memory_paths).toEqual(['editor.md']);
        });

        test('injects at most five memories however many the selector returns', async () => {
            const files = Array.from({ length: 7 }, (_, i) => `fact-${i}.md`);
            for (const file of files) await memory(file, `Fact number ${file}`);
            selectorReplies(JSON.stringify({ selected_memories: files }));

            const recall = await recallMemories('tell me everything', new Set());

            expect(recall?.extra.memory_paths).toHaveLength(5);
        });

        test('skips the selector entirely when nothing is left to offer', async () => {
            await memory('editor.md', 'Preferred code editor');
            const queries = selectorReplies('{"selected_memories": ["editor.md"]}');

            expect(await recallMemories('hello', new Set(['editor.md']))).toBeUndefined();
            expect(await recallMemories('hello', new Set())).toBeDefined();
            expect(queries).toHaveLength(1);
        });

        test('recalls nothing when the selector picks nothing, rambles, or breaks', async () => {
            await memory('editor.md', 'Preferred code editor');

            selectorReplies('{"selected_memories": []}');
            expect(await recallMemories('hello', new Set())).toBeUndefined();

            selectorReplies('I think the editor memory could be relevant?');
            expect(await recallMemories('hello', new Set())).toBeUndefined();

            globalThis.__pipaliMockLLM = () => {
                throw new Error('selector down');
            };
            expect(await recallMemories('hello', new Set())).toBeUndefined();
        });
    });
});
