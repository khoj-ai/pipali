import { test, expect, describe, mock, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Automation, AutomationExecution, Conversation, MemorySettings, User } from '../../src/server/db/schema';
import { dreamWindow, dreamAutomationId, maybeDream, stopDreaming } from '../../src/server/memory/dream';
import { getLoadedSkills, installBuiltinSkills, loadSkills, resetBuiltinSkill } from '../../src/server/skills';
import { formatTranscript, selectConversations } from '../../src/server/skills/builtin/memory-dream/scripts/transcripts';

// Keep the module's other exports intact: mock.module replaces it process-wide, and
// src/server/automation re-exports all of them.
const actualExecutor = await import('../../src/server/automation/executor');

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
    const rewritten: Record<string, unknown>[] = [];

    mock.module(import.meta.resolve('../../src/server/automation/executor'), () => ({
        ...actualExecutor,
        async queueExecution(automationId: string) {
            queued.push(automationId);
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

    test('the prompt is repointed at the skill this release ships', async () => {
        install([]);

        await maybeDream(user);

        expect(rewritten).toHaveLength(1);
        expect(rewritten[0]!.prompt).toMatch(/memory-dream[/\\]SKILL\.md\.$/);
    });
});

describe('transcript digest', () => {
    const conversation = { id: 'c1', title: 'Ledger cleanup', updatedAt: '2026-08-19T09:00:00.000Z' };

    test('keeps what was said and drops the machinery around it', () => {
        const transcript = formatTranscript(conversation, [
            { source: 'system', message: 'You are Pipali.' },
            { source: 'user', message: 'reconcile august' },
            { source: 'agent', message: 'Reading the ledger', tool_calls: [{ function_name: 'read_file' }] },
            { source: 'agent', message: 'Done - three entries were duplicated.' },
            { source: 'user', message: 'use beancount next time, not csv' },
            { source: 'user', message: '[Handoff Context] Summary of earlier turns', extra: { is_compaction: true } },
        ]);

        expect(transcript).toBe([
            '## Ledger cleanup (2026-08-19T09:00:00.000Z)',
            'user: reconcile august',
            'pipali: Done - three entries were duplicated.',
            'user: use beancount next time, not csv',
        ].join('\n'));
    });

    test('a conversation that only ran tools contributes nothing', () => {
        expect(formatTranscript(conversation, [
            { source: 'agent', message: 'Working', tool_calls: [{ function_name: 'shell_command' }] },
        ])).toBe('');
    });

    test('reviews only what the user held themselves, since the cutoff', () => {
        const selected = selectConversations([
            { id: 'own', title: 'Own', updatedAt: '2026-08-19T09:00:00.000Z' },
            { id: 'old', title: 'Old', updatedAt: '2026-08-01T09:00:00.000Z' },
            { id: 'routine', title: 'Routine', updatedAt: '2026-08-19T10:00:00.000Z', isAutomation: true },
            { id: 'subtask', title: 'Subtask', updatedAt: '2026-08-19T11:00:00.000Z', parentConversationId: 'own' },
        ], new Date('2026-08-18T00:00:00.000Z'), 30);

        expect(selected.map(conversation => conversation.id)).toEqual(['own']);
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
