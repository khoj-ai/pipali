import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import {
    isMemoryFile,
    stampProvenance,
    getMemoryDir,
    loadCatalogue,
    formatMemoryForPrompt,
    extractCatalogue,
    catalogueState,
    catalogueUpdateExtra,
    formatCatalogueUpdate,
    hasMemoryInteraction,
    memoryState,
    memoryStateExtra,
    shouldPauseMemory,
    resolveMemoryContext,
    MEMORY_PAUSED_MESSAGE,
    listMemories,
    getMemory,
    deleteMemory,
    deleteAllMemories,
} from '../../src/server/memory';
import { parseFrontmatter } from '../../src/server/frontmatter';
import { writeFile } from '../../src/server/processor/actor/write_file';
import { editFile } from '../../src/server/processor/actor/edit_file';

describe('memory', () => {
    const testDir = path.join(os.tmpdir(), 'memory-tests');

    const withMemoryDir = async <T>(dir: string, run: () => Promise<T>): Promise<T> => {
        const previousDir = process.env.PIPALI_MEMORY_DIR;
        process.env.PIPALI_MEMORY_DIR = dir;
        try {
            return await run();
        } finally {
            process.env.PIPALI_MEMORY_DIR = previousDir;
        }
    };

    beforeAll(async () => {
        process.env.PIPALI_MEMORY_DIR = testDir;
        await fs.mkdir(testDir, { recursive: true });
    });

    afterAll(async () => {
        delete process.env.PIPALI_MEMORY_DIR;
        await fs.rm(testDir, { recursive: true, force: true });
    });

    describe('isMemoryFile', () => {
        test('accepts markdown inside the memory directory and nothing else', () => {
            expect(isMemoryFile(path.join(testDir, 'a-fact.md'))).toBe(true);
            expect(isMemoryFile(path.join(testDir, 'notes.txt'))).toBe(false);
            expect(isMemoryFile(getMemoryDir())).toBe(false);

            // Containment, not a prefix match - `${testDir}-elsewhere` starts with the
            // memory directory's path but is a different directory
            expect(isMemoryFile(path.join(testDir, '..', 'escaped.md'))).toBe(false);
            expect(isMemoryFile(`${testDir}-elsewhere/a-fact.md`)).toBe(false);
        });
    });

    describe('stampProvenance', () => {
        const memory = `---
description: Something worth remembering
type: feedback
---

The fact itself.`;

        test('adds origin and modified, and keeps the body intact', () => {
            const stamped = stampProvenance(memory, 'conv-1', new Date('2026-08-05T10:00:00Z'));
            const parsed = parseFrontmatter(stamped);

            expect(parsed?.fields.origin_conversation_id).toBe('conv-1');
            expect(parsed?.fields.modified).toBe('2026-08-05T10:00:00.000Z');
            expect(parsed?.fields.type).toBe('feedback');
            expect(parsed?.body).toBe('The fact itself.');
        });

        test('refreshes modified without duplicating it, and keeps the original origin', () => {
            const first = stampProvenance(memory, 'conv-1', new Date('2026-08-05T10:00:00Z'));
            const second = stampProvenance(first, 'conv-2', new Date('2026-08-06T10:00:00Z'));

            expect(second.match(/^modified:/gm)?.length).toBe(1);
            expect(parseFrontmatter(second)?.fields.modified).toBe('2026-08-06T10:00:00.000Z');
            expect(parseFrontmatter(second)?.fields.origin_conversation_id).toBe('conv-1');
        });
    });

    describe('catalogue the conversation has seen', () => {
        const catalogue = 'a-fact.md (resource): The first fact';

        test('a rendered prompt round-trips back to the catalogue it listed', () => {
            expect(extractCatalogue(formatMemoryForPrompt(catalogue))).toBe(catalogue);
        });

        test('tells an empty catalogue apart from a prompt with no memory section', () => {
            expect(extractCatalogue(formatMemoryForPrompt(''))).toBe('');
            expect(extractCatalogue('You are Pipali. Here is some context about the user.')).toBeUndefined();
        });

        test('freezes the first catalogue while tracking the newest', () => {
            const updated = `${catalogue}\nb-fact.md: The second fact`;
            const steps = [
                { source: 'system', message: formatMemoryForPrompt(catalogue) },
                { source: 'user', message: 'hi' },
                { source: 'system', message: 'Memory updated', extra: catalogueUpdateExtra(updated) },
                { source: 'user', message: 'again' },
            ];

            expect(catalogueState(steps)).toEqual({ inPrompt: catalogue, shown: updated });
        });

        test('reports nothing for a conversation that has never seen memory', () => {
            expect(catalogueState([{ source: 'user', message: 'hi' }])).toEqual({});
        });
    });

    describe('conversation memory state', () => {
        test('recognizes file tools that interacted with a memory', async () => {
            const memoryPath = path.join(testDir, 'a-fact.md');
            for (const [functionName, args] of [
                ['view_file', { path: memoryPath }],
                ['edit_file', { file_path: memoryPath }],
                ['write_file', { file_path: memoryPath }],
            ] as const) {
                expect(hasMemoryInteraction([{
                    source: 'agent',
                    tool_calls: [{ function_name: functionName, arguments: args }],
                }])).toBe(true);
            }

            await expect(withMemoryDir(path.join(os.homedir(), '.pipali', 'memory'), async () =>
                hasMemoryInteraction([{
                    source: 'agent',
                    tool_calls: [{
                        function_name: 'view_file',
                        arguments: { path: '~/.pipali/memory/a-fact.md' },
                    }],
                }]),
            )).resolves.toBe(true);
            expect(hasMemoryInteraction([{
                source: 'agent',
                tool_calls: [{
                    function_name: 'view_file',
                    arguments: { path: path.join(testDir, '..', 'notes.md') },
                }],
            }])).toBe(false);
        });

        test('tracks explicit pause and resume boundaries', () => {
            const resumedCatalogue = 'a-fact.md (resource): The first fact';
            const steps = [
                { source: 'system', message: formatMemoryForPrompt('') },
                { source: 'system', message: '# Memory paused', extra: memoryStateExtra(false) },
            ];

            expect(memoryState(steps)).toBe(false);

            steps.push({
                source: 'system',
                message: '# Memory enabled',
                extra: memoryStateExtra(true, resumedCatalogue),
            });
            expect(memoryState(steps)).toBe(true);
            expect(catalogueState(steps).shown).toBe(resumedCatalogue);
        });

        test('pauses only once after a conversation interacted with memory', () => {
            const interaction = {
                source: 'agent',
                tool_calls: [{
                    function_name: 'write_file',
                    arguments: { file_path: path.join(testDir, 'a-fact.md') },
                }],
            };

            expect(shouldPauseMemory([
                { source: 'system', message: formatMemoryForPrompt('') },
            ])).toBe(false);
            expect(shouldPauseMemory([interaction])).toBe(true);
            expect(shouldPauseMemory([
                interaction,
                { source: 'system', message: '# Memory paused', extra: memoryStateExtra(false) },
            ])).toBe(false);
        });
    });

    describe('memory context plan', () => {
        const contextDir = path.join(os.tmpdir(), 'memory-context-tests');

        beforeEach(async () => {
            await fs.rm(contextDir, { recursive: true, force: true });
            await fs.mkdir(contextDir, { recursive: true });
        });

        afterAll(async () => {
            await fs.rm(contextDir, { recursive: true, force: true });
        });

        test('pauses an existing conversation with memory interaction only once', async () => {
            await withMemoryDir(contextDir, async () => {
                const steps = [
                    { source: 'system', message: formatMemoryForPrompt('') },
                    {
                        source: 'agent',
                        tool_calls: [{
                            function_name: 'view_file',
                            arguments: { path: path.join(contextDir, 'a-fact.md') },
                        }],
                    },
                ];

                const first = await resolveMemoryContext({
                    steps,
                    memoriesEnabled: false,
                    isNewConversation: false,
                });
                expect(first).toEqual({
                    systemSteps: [{
                        message: MEMORY_PAUSED_MESSAGE,
                        extra: memoryStateExtra(false),
                    }],
                });

                const pausedStep = first.systemSteps[0]!;
                const second = await resolveMemoryContext({
                    steps: [...steps, { source: 'system', ...pausedStep }],
                    memoriesEnabled: false,
                    isNewConversation: false,
                });
                expect(second.systemSteps).toEqual([]);
            });
        });

        test('introduces memory to an existing conversation but not a new one', async () => {
            await withMemoryDir(contextDir, async () => {
                const currentCatalogue = await loadCatalogue();
                const newConversation = await resolveMemoryContext({
                    steps: [],
                    memoriesEnabled: true,
                    isNewConversation: true,
                });
                expect(newConversation).toEqual({
                    memoryCatalogue: currentCatalogue,
                    systemSteps: [],
                });

                const existingConversation = await resolveMemoryContext({
                    steps: [{ source: 'system', message: 'You are Pipali.' }],
                    memoriesEnabled: true,
                    isNewConversation: false,
                });
                expect(existingConversation).toEqual({
                    memoryCatalogue: currentCatalogue,
                    systemSteps: [{
                        message: '# Memory enabled',
                        extra: memoryStateExtra(true, currentCatalogue),
                    }],
                });
            });
        });

        test('retries a catalogue update if only the preceding enabled step persisted', async () => {
            await withMemoryDir(contextDir, async () => {
                const oldCatalogue = 'a-fact.md (feedback): The old wording';
                await Bun.write(
                    path.join(contextDir, 'a-fact.md'),
                    '---\ndescription: The new wording\ntype: feedback\nmodified: 2026-08-07T00:00:00.000Z\n---\n\nBody.\n',
                );
                const currentCatalogue = await loadCatalogue();
                const steps = [
                    { source: 'system', message: formatMemoryForPrompt(oldCatalogue) },
                    { source: 'system', message: MEMORY_PAUSED_MESSAGE, extra: memoryStateExtra(false) },
                ];

                const first = await resolveMemoryContext({
                    steps,
                    memoriesEnabled: true,
                    isNewConversation: false,
                });
                expect(first.memoryCatalogue).toBe(oldCatalogue);
                expect(first.systemSteps).toHaveLength(2);

                const enabledStep = first.systemSteps[0]!;
                const updateStep = first.systemSteps[1]!;
                expect(enabledStep.message).toBe('# Memory enabled');
                expect(enabledStep.extra.memory_catalogue).toBeUndefined();
                expect(updateStep.message).toContain('Rewritten:\na-fact.md: The new wording');
                expect(updateStep.extra.memory_catalogue).toBe(currentCatalogue);

                const retry = await resolveMemoryContext({
                    steps: [...steps, { source: 'system', ...enabledStep }],
                    memoriesEnabled: true,
                    isNewConversation: false,
                });
                expect(retry.systemSteps).toHaveLength(1);
                expect(retry.systemSteps[0]?.message).toContain('Rewritten:\na-fact.md: The new wording');
            });
        });
    });

    // Every seam a catalogue crosses in production: rendered from the files on disk,
    // embedded in a system prompt, persisted, read back a turn later, and compared
    // against a freshly rendered one. Changing how loadCatalogue writes a line
    // without teaching the parser breaks here, and nowhere else.
    describe('catalogue round trip', () => {
        const roundTripDir = path.join(os.tmpdir(), 'memory-round-trip-tests');
        const memory = (file: string, description: string, type: string, modified: string) =>
            Bun.write(
                path.join(roundTripDir, file),
                `---\ndescription: ${description}\ntype: ${type}\nmodified: ${modified}\n---\n\nBody.\n`,
            );

        beforeAll(async () => {
            await fs.mkdir(roundTripDir, { recursive: true });
        });

        afterAll(async () => {
            await fs.rm(roundTripDir, { recursive: true, force: true });
        });

        test('a change on disk reaches the conversation that froze the older catalogue', async () => {
            await withMemoryDir(roundTripDir, async () => {
                await memory('kept.md', 'Unchanged throughout', 'feedback', '2026-01-01T00:00:00.000Z');
                await memory('reworded.md', 'The old wording', 'project', '2026-02-01T00:00:00.000Z');
                await memory('gone.md', 'About to be deleted', 'resource', '2026-03-01T00:00:00.000Z');

                const frozen = extractCatalogue(formatMemoryForPrompt(await loadCatalogue()))!;
                expect(formatCatalogueUpdate(frozen, await loadCatalogue())).toBeUndefined();

                await memory('fresh.md', 'Brand new', 'feedback', '2026-04-01T00:00:00.000Z');
                await memory('reworded.md', 'The new wording', 'project', '2026-05-01T00:00:00.000Z');
                await fs.rm(path.join(roundTripDir, 'gone.md'));

                const update = formatCatalogueUpdate(frozen, await loadCatalogue())!;
                expect(update).toContain('Added:\nfresh.md: Brand new');
                expect(update).toContain('Rewritten:\nreworded.md: The new wording');
                expect(update).toContain('Deleted:\ngone.md');
                expect(update).not.toContain('kept.md');
            });
        });
    });

    describe('loadCatalogue', () => {
        const catalogueDir = path.join(os.tmpdir(), 'memory-catalogue-tests');
        const withCatalogueDir = <T>(run: () => Promise<T>): Promise<T> => withMemoryDir(catalogueDir, run);

        beforeAll(async () => {
            await fs.mkdir(catalogueDir, { recursive: true });
            await Bun.write(path.join(catalogueDir, 'oldest.md'), '---\ndescription: Stamped longest ago\nmodified: 2026-01-01T00:00:00.000Z\n---\n\nBody.\n');
            await Bun.write(path.join(catalogueDir, 'newest.md'), '---\ndescription: Stamped most recently\ntype: resource\nmodified: 2026-08-01T00:00:00.000Z\n---\n\nBody.\n');
            await Bun.write(path.join(catalogueDir, 'middle.md'), '---\ndescription: Stamped in between\ntype: feedback\nmodified: 2026-04-01T00:00:00.000Z\n---\n\nBody.\n');
            await Bun.write(path.join(catalogueDir, 'no-description.md'), '---\ntype: feedback\n---\n\nBody.\n');
        });

        afterAll(async () => {
            await fs.rm(catalogueDir, { recursive: true, force: true });
        });

        test('stamps a hand-written memory with the time it was last changed, not now', async () => {
            const handWritten = path.join(catalogueDir, 'by-hand.md');
            const lastChanged = new Date('2026-03-01T00:00:00.000Z');
            await Bun.write(handWritten, '---\ndescription: Typed by the user\n---\n\nBody.\n');
            await fs.utimes(handWritten, lastChanged, lastChanged);

            // Ordering it into the middle proves the stamp beat both `now` and the fresh
            // mtime this very write leaves behind
            expect((await withCatalogueDir(loadCatalogue)).split('\n')[2]).toBe('by-hand.md: Typed by the user');
            expect(parseFrontmatter(await Bun.file(handWritten).text())?.fields.modified)
                .toBe(lastChanged.toISOString());

            await fs.rm(handWritten, { force: true });
        });

        test('orders by the stamp rather than the filesystem, newest first', async () => {
            // Written oldest-last, so filesystem order is the reverse of the stamped order.
            // no-description.md is in the fixture and must not appear at all.
            expect(await withCatalogueDir(loadCatalogue)).toBe([
                'newest.md (resource): Stamped most recently',
                'middle.md (feedback): Stamped in between',
                'oldest.md: Stamped longest ago',
            ].join('\n'));
        });
    });

    describe('memory management', () => {
        test('lists, reads, and deletes only direct memory files', async () => {
            const managementDir = path.join(os.tmpdir(), 'memory-management-tests');
            const outsideMemory = path.join(os.tmpdir(), 'memory-management-outside.md');
            await fs.rm(managementDir, { recursive: true, force: true });
            await fs.mkdir(path.join(managementDir, 'nested'), { recursive: true });

            try {
                await Bun.write(
                    path.join(managementDir, 'newest.md'),
                    '---\ndescription: Most recent memory\ntype: project\nmodified: 2026-02-01T00:00:00.000Z\n---\n\nNewest body.\n',
                );
                await Bun.write(
                    path.join(managementDir, 'oldest.md'),
                    '---\ndescription: Older memory\nmodified: 2026-01-01T00:00:00.000Z\n---\n\nOlder body.\n',
                );
                const malformed = path.join(managementDir, 'malformed.md');
                await Bun.write(malformed, 'Visible even without frontmatter.\n');
                await fs.utimes(malformed, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));
                await Bun.write(path.join(managementDir, 'notes.txt'), 'Not a memory.\n');
                await Bun.write(path.join(managementDir, 'nested', 'hidden.md'), 'Nested memory.\n');
                await Bun.write(outsideMemory, 'Outside memory.\n');

                await withMemoryDir(managementDir, async () => {
                    expect((await listMemories()).map(memory => memory.file)).toEqual([
                        'newest.md',
                        'oldest.md',
                        'malformed.md',
                    ]);

                    expect(await getMemory('newest.md')).toMatchObject({
                        file: 'newest.md',
                        description: 'Most recent memory',
                        type: 'project',
                        content: 'Newest body.',
                    });
                    expect((await getMemory('malformed.md'))?.content).toBe('Visible even without frontmatter.\n');

                    expect(await getMemory('../memory-management-outside.md')).toBeUndefined();
                    expect(await deleteMemory('../memory-management-outside.md')).toBe(false);
                    expect(await Bun.file(outsideMemory).exists()).toBe(true);

                    expect(await deleteMemory('oldest.md')).toBe(true);
                    expect(await deleteAllMemories()).toBe(2);
                    expect(await listMemories()).toEqual([]);
                    expect(await Bun.file(path.join(managementDir, 'notes.txt')).exists()).toBe(true);
                    expect(await Bun.file(path.join(managementDir, 'nested', 'hidden.md')).exists()).toBe(true);
                });
            } finally {
                await fs.rm(managementDir, { recursive: true, force: true });
                await fs.rm(outsideMemory, { force: true });
            }
        });
    });

    describe('provenance on writes', () => {
        test('write_file stamps a memory and leaves other files alone', async () => {
            const memoryPath = path.join(testDir, 'written.md');
            await writeFile(
                { file_path: memoryPath, content: '---\ndescription: A written memory\n---\n\nBody.\n' },
                { conversationId: 'conv-write' },
            );
            const stamped = parseFrontmatter(await Bun.file(memoryPath).text());
            expect(stamped?.fields.origin_conversation_id).toBe('conv-write');
            expect(stamped?.fields.modified).toBeDefined();

            const notes = '---\ntitle: Notes\n---\n\nNot a memory.\n';
            const notesPath = path.join(os.tmpdir(), 'memory-tests-notes.md');
            await writeFile({ file_path: notesPath, content: notes }, { conversationId: 'conv-write' });
            expect(await Bun.file(notesPath).text()).toBe(notes);
            await fs.rm(notesPath, { force: true });
        });

        test('write_file refuses a memory with no description and writes nothing', async () => {
            const memoryPath = path.join(testDir, 'undescribed.md');

            const result = await writeFile(
                { file_path: memoryPath, content: '---\ntype: feedback\n---\n\nA fact nobody can find.\n' },
                { conversationId: 'conv-write' },
            );

            expect(result.compiled).toContain('no description');
            expect(result.compiled).toContain('description:');
            expect(await Bun.file(memoryPath).exists()).toBe(false);
        });

        test('edit_file refuses an edit that strips the description, leaving the file as it was', async () => {
            const memoryPath = path.join(testDir, 'keeps-description.md');
            const original = '---\ndescription: Still findable\n---\n\nBody.\n';
            await writeFile({ file_path: memoryPath, content: original }, { conversationId: 'conv-create' });
            const before = await Bun.file(memoryPath).text();

            const result = await editFile(
                { file_path: memoryPath, old_string: 'description: Still findable\n', new_string: '' },
                { conversationId: 'conv-edit' },
            );

            expect(result.compiled).toContain('no description');
            expect(await Bun.file(memoryPath).text()).toBe(before);
        });

        test('edit_file refreshes modified and carries the original origin through', async () => {
            const memoryPath = path.join(testDir, 'edited.md');
            await writeFile(
                { file_path: memoryPath, content: '---\ndescription: An edited memory\n---\n\nOld body.\n' },
                { conversationId: 'conv-create' },
            );
            const created = parseFrontmatter(await Bun.file(memoryPath).text())!;

            // Both stamps would otherwise land in the same millisecond, and a stamp that
            // was never refreshed would pass just as well as one that was
            await Bun.sleep(2);
            await editFile(
                { file_path: memoryPath, old_string: 'Old body.', new_string: 'New body.' },
                { conversationId: 'conv-edit' },
            );
            const edited = parseFrontmatter(await Bun.file(memoryPath).text())!;

            expect(edited.body).toBe('New body.');
            expect(edited.fields.origin_conversation_id).toBe('conv-create');
            expect(new Date(edited.fields.modified!).getTime())
                .toBeGreaterThan(new Date(created.fields.modified!).getTime());
        });
    });
});
