import { test, expect, describe, mock, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Automation, AutomationExecution, Conversation, MemorySettings, User } from '../../src/server/db/schema';
import { dreamWindow, dreamAutomationId, maybeDream, stopDreaming } from '../../src/server/memory/dream';
import { getLoadedSkills, installBuiltinSkills, loadSkills, resetBuiltinSkill } from '../../src/server/skills';
import { formatTranscript, selectConversations } from '../../src/server/skills/builtin/memory-dream/scripts/transcripts';

// Keep the module's other exports intact: mock.module replaces it process-wide, and
// src/server/automation re-exports all of them. Copied, as the mock rewrites the module's own.
const executorModule = import.meta.resolve('../../src/server/automation/executor');
const actualExecutor = { ...await import('../../src/server/automation/executor') };

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-08-19T20:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * HOUR);

describe('dream gate', () => {
    const created = hoursAgo(300);

    test('both a quiet week and a busy afternoon are left alone', async () => {
        expect(await dreamWindow(created, hoursAgo(200), async () => 2, now)).toBeUndefined();
        expect(await dreamWindow(created, hoursAgo(4), async () => 40, now)).toBeUndefined();
    });

    test('a day with enough conversations behind it consolidates, reviewing since the last dream', async () => {
        expect(await dreamWindow(created, hoursAgo(13), async () => 5, now)).toEqual(hoursAgo(13));
    });

    test("the first dream reviews from the routine's own creation", async () => {
        expect(await dreamWindow(created, undefined, async () => 5, now)).toEqual(created);
    });

    test('the conversation count is not queried while the clock still holds it shut', async () => {
        let counted = 0;
        await dreamWindow(created, hoursAgo(1), async () => { counted++; return 100; }, now);
        expect(counted).toBe(0);
    });
});

describe('dream automation id', () => {
    test('is stable per user, so the routine is never created twice', () => {
        expect(dreamAutomationId(1)).toBe(dreamAutomationId(1));
        expect(dreamAutomationId(1)).not.toBe(dreamAutomationId(2));
        expect(dreamAutomationId(7)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

/**
 * The window has to come from the execution log: `Automation.lastExecutedAt` is stamped
 * only once the run returns, and the dream's own returning run is what re-checks the gate.
 */
describe('a dream that already started does not queue another', () => {
    const user = { id: 1 } as typeof User.$inferSelect;
    const queued: string[] = [];
    const triggers: { external?: { metadata?: Record<string, unknown> } }[] = [];
    const rewritten: Record<string, unknown>[] = [];

    mock.module(executorModule, () => ({
        ...actualExecutor,
        async queueExecution(automationId: string, trigger: typeof triggers[number]) {
            queued.push(automationId);
            triggers.push(trigger);
            return { executionId: 'exec-new', conversationId: 'conv-new' };
        },
    }));

    /** Rows for a query the code may or may not order and limit before awaiting */
    const rows = (values: Record<string, unknown>[]) => Object.assign(Promise.resolve(values), {
        orderBy: () => ({ limit: () => Promise.resolve(values) }),
    });

    /**
     * A store with plenty to consolidate, and a routine not yet stamped as executed.
     *
     * The routine carries no prompt, so every run rewrites it - which is what the
     * pointer at the skill is supposed to do when a release moves it.
     */
    function install(executions: { createdAt: Date; status: string }[]) {
        queued.length = 0;
        triggers.length = 0;
        rewritten.length = 0;
        globalThis.__pipaliUnitDb = {
            select(table: unknown) {
                if (table === MemorySettings) return rows([]);
                if (table === Automation) {
                    return rows([{
                        id: dreamAutomationId(user.id),
                        status: 'active',
                        createdAt: new Date(Date.now() - 30 * 24 * HOUR),
                        lastExecutedAt: null,
                    }]);
                }
                if (table === AutomationExecution) return rows(executions);
                if (table === Conversation) return rows([{ total: 40 }]);
                throw new Error('Unexpected table read');
            },
            update(_table: unknown, values: unknown) {
                rewritten.push(values as Record<string, unknown>);
            },
        };
    }

    afterEach(() => { globalThis.__pipaliUnitDb = undefined; });

    // Test files after this one share the process, and queue routines for real
    afterAll(() => { mock.module(executorModule, () => actualExecutor); });

    test('the run it just finished finds the window already closed', async () => {
        install([{ createdAt: new Date(Date.now() - 3 * 60 * 1000), status: 'completed' }]);

        await maybeDream(user);

        expect(queued).toEqual([]);
    });

    test('a routine that has never dreamt still does', async () => {
        install([]);

        await maybeDream(user);

        expect(queued).toEqual([dreamAutomationId(user.id)]);
    });

    test('the dream is told how many memories its catalogue left out', async () => {
        const memoryDir = path.join(os.tmpdir(), 'memory-dream-tests', 'memory');
        const previousDir = process.env.PIPALI_MEMORY_DIR;
        await fs.mkdir(memoryDir, { recursive: true });
        process.env.PIPALI_MEMORY_DIR = memoryDir;

        try {
            // Descriptions heavy enough that eight fill the catalogue, leaving two out
            for (let day = 0; day < 10; day++) {
                await Bun.write(
                    path.join(memoryDir, `bulky-${day}.md`),
                    `---\ndescription: ${`Memory ${day} `.padEnd(3000, 'x')}\nmodified: 2026-03-1${day}T00:00:00.000Z\n---\n\nBody.\n`,
                );
            }
            install([]);

            await maybeDream(user);

            expect(triggers[0]?.external?.metadata).toEqual({
                review_since: expect.any(String),
                unlisted_memories: 2,
            });
        } finally {
            process.env.PIPALI_MEMORY_DIR = previousDir;
            await fs.rm(memoryDir, { recursive: true, force: true });
        }
    });

    test('the prompt is repointed at the skill this release ships', async () => {
        install([]);

        await maybeDream(user);

        expect(rewritten).toHaveLength(1);
        expect(rewritten[0]!.prompt).toMatch(/memory-dream[/\\]SKILL\.md\.$/);
    });
});

describe('transcript digest', () => {
    const since = new Date('2026-08-19T00:00:00.000Z');
    // Times as the conversation list gives them: UTC, without a zone
    const conversation = {
        id: 'c1',
        title: 'Ledger cleanup',
        createdAt: '2026-08-10 08:00:00.000',
        updatedAt: '2026-08-19 09:00:00.000',
    };
    const at = (dayAndTime: string) => `2026-08-${dayAndTime}:00.000Z`;
    const transcriptsScript = path.join(
        import.meta.dir, '..', '..', 'src', 'server', 'skills', 'builtin', 'memory-dream', 'scripts', 'transcripts.ts',
    );

    test('keeps what was said and drops the machinery around it', () => {
        const transcript = formatTranscript(conversation, [
            { source: 'system', message: 'You are Pipali.', timestamp: at('19T08:59') },
            { source: 'user', message: 'reconcile august', timestamp: at('19T09:00') },
            { source: 'agent', message: 'Reading the ledger', tool_calls: [{ function_name: 'read_file' }], timestamp: at('19T09:01') },
            {
                source: 'agent',
                message: 'Checking before I merge',
                timestamp: at('19T09:02'),
                tool_calls: [
                    { tool_call_id: 'ask', function_name: 'ask_user', arguments: { title: 'Merge the duplicates?', description: 'Three entries repeat.' } },
                    { tool_call_id: 'note', function_name: 'ask_user', arguments: { title: 'Backup written' } },
                ],
                observation: { results: [
                    { source_call_id: 'ask', content: 'User responded: keep the one with a receipt' },
                    { source_call_id: 'note', content: 'User acknowledged: "Backup written"' },
                ] },
            },
            { source: 'agent', message: 'Done - three entries were duplicated.', timestamp: at('19T09:03') },
            { source: 'user', message: 'use beancount next time, not csv', timestamp: at('19T09:04') },
            { source: 'user', message: '[Handoff Context] Summary of earlier turns', extra: { is_compaction: true }, timestamp: at('19T09:05') },
        ], since, 'UTC');

        expect(transcript).toBe([
            '## Ledger cleanup',
            '2026-08-19 09:00 user: reconcile august',
            '2026-08-19 09:02 pipali asked: Merge the duplicates? - Three entries repeat.',
            '2026-08-19 09:02 user responded: keep the one with a receipt',
            '2026-08-19 09:03 pipali: Done - three entries were duplicated.',
            '2026-08-19 09:04 user: use beancount next time, not csv',
        ].join('\n'));
    });

    test('a conversation that only ran tools contributes nothing', () => {
        expect(formatTranscript(conversation, [
            { source: 'agent', message: 'Working', tool_calls: [{ function_name: 'shell_command' }], timestamp: at('19T09:00') },
        ], since, 'UTC')).toBe('');
    });

    test('a conversation carried over the cutoff shows only what came after, led by the reply it reacts to', () => {
        const history = [
            { source: 'user', message: 'reconcile august', timestamp: at('18T09:00') },
            { source: 'agent', message: 'Done - three entries were duplicated.', timestamp: at('18T09:02') },
            // Written after the cutoff, and still not something anyone said
            { source: 'user', message: '[Handoff Context] Summary of earlier turns', extra: { is_compaction: true }, timestamp: at('19T08:59') },
            { source: 'user', message: 'use beancount next time, not csv', timestamp: at('19T09:00') },
        ];

        expect(formatTranscript(conversation, history, since, 'UTC')).toBe([
            '## Ledger cleanup',
            '(earlier) 2026-08-18 09:02 pipali: Done - three entries were duplicated.',
            '2026-08-19 09:00 user: use beancount next time, not csv',
        ].join('\n'));
        expect(formatTranscript(conversation, history, new Date(at('19T12:00')), 'UTC')).toBe('');
    });

    test('a fork shows only what was said after it was made', () => {
        // Copied from a routine run earlier the same day, inside the review window
        const fork = { ...conversation, createdAt: '2026-08-19 08:00:00.000' };

        expect(formatTranscript(fork, [
            { source: 'user', message: 'Summarize my inbox.', timestamp: at('19T07:00') },
            { source: 'agent', message: 'Three threads need a reply.', timestamp: at('19T07:01') },
            { source: 'user', message: 'draft the one to Dana, keep it short', timestamp: at('19T09:00') },
        ], since, 'UTC')).toBe([
            '## Ledger cleanup',
            '(earlier) 2026-08-19 07:01 pipali: Three threads need a reply.',
            '2026-08-19 09:00 user: draft the one to Dana, keep it short',
        ].join('\n'));
    });

    test('reviews only what the user held themselves, since the cutoff', () => {
        const { selected } = selectConversations([
            { ...conversation, id: 'own' },
            { ...conversation, id: 'old', updatedAt: '2026-08-01 09:00:00.000' },
            { ...conversation, id: 'routine', isAutomation: true },
            { ...conversation, id: 'subtask', parentConversationId: 'own' },
        ], since, 30);

        expect(selected.map(conversation => conversation.id)).toEqual(['own']);
    });

    test('a message is timed on the clock of the zone it is shown in', () => {
        // "Yesterday" in a message is the user's day, which here has already turned over
        expect(formatTranscript(conversation, [
            { source: 'user', message: 'the invoice went out yesterday', timestamp: at('19T20:00') },
        ], since, 'Asia/Kolkata')).toContain('2026-08-20 01:30 user: the invoice went out yesterday');
    });

    test('reads list times as UTC wherever the machine is, counting what the limit left out', async () => {
        // A process keeps the zone it started in on some platforms, so one east of UTC, where
        // the same times read as local fall before the cutoff, is started for this
        const script = `
            import { selectConversations } from ${JSON.stringify(Bun.pathToFileURL(transcriptsScript).href)};
            const { selected, total } = selectConversations(${JSON.stringify([
                { ...conversation, id: 'first-hour', updatedAt: '2026-08-19 00:30:00.000' },
                { ...conversation, id: 'third-hour', updatedAt: '2026-08-19 02:30:00.000' },
            ])}, new Date(${since.getTime()}), 1);
            console.log(JSON.stringify({ selected: selected.map(conversation => conversation.id), total }));`;
        const run = Bun.spawn([process.execPath, '-e', script], {
            env: { ...process.env, TZ: 'Asia/Kolkata' },
            stdout: 'pipe',
            stderr: 'inherit',
        });

        expect(JSON.parse(await new Response(run.stdout).text())).toEqual({ selected: ['third-hour'], total: 2 });
    });
});

/**
 * The routine and the skill are both derived, so turning memory off can remove them
 * outright rather than leaving an active routine and a runnable procedure behind.
 */
describe('turning memory off takes the dream with it', () => {
    const builtinDir = path.join(import.meta.dir, '..', '..', 'src', 'server', 'skills', 'builtin', 'memory-dream');
    const skillsDir = path.join(os.tmpdir(), 'memory-dream-tests', 'skills');
    const deleted: unknown[] = [];

    beforeEach(async () => {
        deleted.length = 0;
        await fs.rm(path.dirname(skillsDir), { recursive: true, force: true });
        await fs.mkdir(skillsDir, { recursive: true });
        process.env.PIPALI_SKILLS_DIR = skillsDir;
        globalThis.__pipaliUnitDb = {
            delete(table: unknown) {
                deleted.push(table);
                return Promise.resolve();
            },
        };
    });

    afterEach(async () => {
        globalThis.__pipaliUnitDb = undefined;
        delete process.env.PIPALI_SKILLS_DIR;
        await fs.rm(path.dirname(skillsDir), { recursive: true, force: true });
    });

    test('the routine row and the installed skill are both removed', async () => {
        await fs.cp(builtinDir, path.join(skillsDir, 'memory-dream'), { recursive: true });
        await loadSkills();

        await stopDreaming(1);

        expect(deleted).toEqual([Automation]);
        expect(await Bun.file(path.join(skillsDir, 'memory-dream', 'SKILL.md')).exists()).toBe(false);
        expect(getLoadedSkills().map(skill => skill.name)).not.toContain('memory-dream');
    });

    test('a user who never turned memory on has nothing to remove', async () => {
        await loadSkills();

        await stopDreaming(1);

        expect(deleted).toEqual([Automation]);
    });

    /**
     * Startup installs every builtin skill it ships. The dream's is the exception:
     * putting it back would undo the removal above on the next restart.
     */
    test('startup leaves the skill off disk, and the next dream puts it there', async () => {
        expect((await installBuiltinSkills()).installed).not.toContain('memory-dream');
        expect(await Bun.file(path.join(skillsDir, 'memory-dream', 'SKILL.md')).exists()).toBe(false);

        expect((await resetBuiltinSkill('memory-dream')).success).toBe(true);
        expect(await Bun.file(path.join(skillsDir, 'memory-dream', 'SKILL.md')).exists()).toBe(true);

        // Once installed it is a builtin like any other, kept up to date on startup
        expect((await installBuiltinSkills()).unchanged).toContain('memory-dream');
    });
});
