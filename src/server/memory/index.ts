/**
 * Memory module
 *
 * Durable facts Pipali writes about the user, kept as plain markdown under
 * ~/.pipali/memory/ - one fact per file. The catalogue loaded into every system
 * prompt is derived from those files' frontmatter, so it is always synced with
 * what is on disk. Bodies are pulled in on demand with view_file.
 */

import path from 'path';
import os from 'os';
import { lstat, mkdir, readdir, unlink } from 'fs/promises';
import { parseFrontmatter } from '../frontmatter';
import { createChildLogger } from '../logger';
import { PIPALI_MEMORY_RELATIVE_DIR } from '../../shared';

const log = createChildLogger({ component: 'memory' });

/** Past this the catalogue stops being scannable and starts taxing every request */
const CATALOGUE_MAX_BYTES = 25_000;

/** `<file> (<type>): <description>`, with type optional - the catalogue's only shape */
const CATALOGUE_ENTRY = /^(\S+?)(?: \(([^)]*)\))?: (.*)$/;

/** Distinctive enough to tell our section apart from a USER.md that mentions memory */
const MEMORY_SECTION_LEAD = 'You have a persistent file-based memory at';

const CATALOGUE_BLOCK = /<memory_catalogue>\n([\s\S]*?)\n<\/memory_catalogue>/;

/** Carried on an update step so the catalogue it announced can be read back */
const CATALOGUE_KEY = 'memory_catalogue';

export const MEMORY_UPDATE_KIND = 'memory_update';
export const MEMORY_STATE_KIND = 'memory_state';

export const MEMORY_PAUSED_MESSAGE = `# Memory paused

Memory is paused for this session. Do not read or write memories, and do not reference previously loaded memory content.`;

export interface MemorySummary {
    file: string;
    description?: string;
    type?: string;
    modified: string;
}

export interface StoredMemory extends MemorySummary {
    content: string;
}

/** Stated once, so the system prompt and a rejected write cannot teach different formats */
const MEMORY_FRONTMATTER = `---
description: <required. One line, shown in the catalogue - write it so a future
you can tell from this line alone whether the memory is worth opening>
type: user | feedback | project | resource
---`;

/**
 * The parts of a conversation step this module reads. Declared structurally rather
 * than imported from ATIF, so memory depends on nothing under processor/ - which
 * imports memory. Real trajectory steps satisfy it as they are, no conversion.
 */
interface CatalogueStep {
    source: string;
    message?: string;
    extra?: Record<string, unknown>;
    tool_calls?: Array<{
        function_name: string;
        arguments: Record<string, unknown>;
    }>;
}

/**
 * Memory prompt context and system steps needed to sync a conversation with the current memory state.
 */
interface MemoryContextPlan {
    memoryCatalogue?: string;
    systemSteps: Array<{
        message: string;
        extra: Record<string, unknown>;
    }>;
}

export function getMemoryDir(): string {
    return process.env.PIPALI_MEMORY_DIR || path.join(os.homedir(), PIPALI_MEMORY_RELATIVE_DIR);
}

/**
 * Create the memory directory, so the agent can write to it without checking
 * whether it exists first.
 */
export async function initializeMemory(): Promise<void> {
    try {
        await mkdir(getMemoryDir(), { recursive: true });
    } catch (err) {
        log.warn({ err }, 'Failed to create memory directory (non-fatal)');
    }
}

/**
 * Record mtime as the `modified` stamp of a memory written by hand.
 *
 * A failed write must not hide the memory, so this swallows rather than throws -
 * the catalogue uses the same timestamp either way, it just goes on asking.
 */
async function stampModified(memoryPath: string, content: string, modified: number): Promise<void> {
    const file = path.basename(memoryPath);
    try {
        await Bun.write(memoryPath, stampProvenance(content, undefined, new Date(modified)));
        log.info({ file }, 'Stamped a hand-written memory with the time it was last changed');
    } catch (err) {
        log.warn({ err, file }, 'Could not stamp memory');
    }
}

/**
 * Whether a path holds a memory.
 */
export function isMemoryFile(absolutePath: string): boolean {
    const relative = path.relative(getMemoryDir(), absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return false;
    }
    return relative.endsWith('.md');
}

function isMemoryName(file: string): boolean {
    return file === path.basename(file) && file.endsWith('.md');
}

async function readStoredMemory(file: string): Promise<StoredMemory | undefined> {
    if (!isMemoryName(file)) return undefined;

    const memoryPath = path.join(getMemoryDir(), file);
    try {
        if (!(await lstat(memoryPath)).isFile()) return undefined;

        const handle = Bun.file(memoryPath);
        const raw = await handle.text();
        const parsed = parseFrontmatter(raw);
        const stampedModified = Date.parse(parsed?.fields.modified ?? '');
        const modified = Number.isNaN(stampedModified)
            ? new Date(handle.lastModified).toISOString()
            : new Date(stampedModified).toISOString();

        return {
            file,
            description: parsed?.fields.description || undefined,
            type: parsed?.fields.type || undefined,
            modified,
            content: parsed?.body ?? raw,
        };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn({ err, file }, 'Failed to read memory');
        }
        return undefined;
    }
}

/** List direct memory files newest-first without loading their bodies into the response. */
export async function listMemories(): Promise<MemorySummary[]> {
    let entries;
    try {
        entries = await readdir(getMemoryDir(), { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.error({ err }, 'Failed to list memories');
        }
        return [];
    }

    const memories = await Promise.all(
        entries
            .filter(entry => entry.isFile() && isMemoryName(entry.name))
            .map(entry => readStoredMemory(entry.name)),
    );

    return memories
        .filter((memory): memory is StoredMemory => memory !== undefined)
        .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified) || a.file.localeCompare(b.file))
        .map(({ content: _, ...summary }) => summary);
}

/** Read one direct memory file. Invalid paths and missing files are indistinguishable. */
export async function getMemory(file: string): Promise<StoredMemory | undefined> {
    return readStoredMemory(file);
}

/** Delete one direct memory file, returning false when it is invalid or no longer exists. */
export async function deleteMemory(file: string): Promise<boolean> {
    if (!isMemoryName(file)) return false;

    const memoryPath = path.join(getMemoryDir(), file);
    try {
        if (!(await lstat(memoryPath)).isFile()) return false;
        await unlink(memoryPath);
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
    }
}

/** Delete every direct memory file while preserving the directory and unrelated files. */
export async function deleteAllMemories(): Promise<number> {
    let entries;
    try {
        entries = await readdir(getMemoryDir(), { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
    }

    const deleted = await Promise.all(
        entries
            .filter(entry => entry.isFile() && isMemoryName(entry.name))
            .map(entry => deleteMemory(entry.name)),
    );
    return deleted.filter(Boolean).length;
}

/**
 * Why this content cannot be stored as a memory, phrased for whoever wrote it.
 *
 * Checked when writing rather than when reading: a memory without a description is
 * unreachable, and the only one who can fix that is whoever is holding the text.
 */
export function memoryWriteError(content: string): string | undefined {
    const parsed = parseFrontmatter(content);
    if (parsed?.fields.description) {
        return undefined;
    }

    return `Error: nothing written - ${parsed ? 'this memory has no description' : 'this memory has no frontmatter'}.
A memory is only ever found by its description, so one without it can never be recalled. Write it as:

${MEMORY_FRONTMATTER}

<the fact>`;
}

/**
 * Build the catalogue from the frontmatter of every memory on disk, one line each,
 * most recently changed first.
 *
 * Derived rather than maintained, so a memory cannot go missing from the catalogue
 * and the catalogue cannot point at a memory that is gone.
 */
export async function loadCatalogue(): Promise<string> {
    const memoryDir = getMemoryDir();
    let files: string[];
    try {
        files = await readdir(memoryDir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.error({ err }, 'Failed to list memory directory');
        }
        return '';
    }

    const memories = files.filter(file => isMemoryFile(path.join(memoryDir, file)));
    const entries = await Promise.all(memories.map(async file => {
        try {
            const memoryPath = path.join(memoryDir, file);
            const handle = Bun.file(memoryPath);
            const content = await handle.text();
            const parsed = parseFrontmatter(content);
            const description = parsed?.fields.description;
            if (!description) {
                // write_file and edit_file reject these, so this must be a hand-written memory.
                log.warn({ file }, 'Memory has no description, leaving it out of the catalogue');
                return undefined;
            }

            // Use inline timestamp; it outlives mtime, which a sync, git clone could reset.
            // Set mtime as inline timestamp if a memory file is missing one.
            let modified = Date.parse(parsed.fields.modified ?? '');
            if (!modified) {
                modified = handle.lastModified;
                await stampModified(memoryPath, content, modified);
            }

            const type = parsed.fields.type;
            return {
                modified,
                line: type ? `${file} (${type}): ${description}` : `${file}: ${description}`,
            };
        } catch (err) {
            log.warn({ err, file }, 'Skipping unreadable memory');
            return undefined;
        }
    }));

    const catalogue = entries
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .sort((a, b) => b.modified - a.modified || a.line.localeCompare(b.line))
        .map(entry => entry.line)
        .join('\n');

    if (Buffer.byteLength(catalogue, 'utf-8') > CATALOGUE_MAX_BYTES) {
        log.warn({ max: CATALOGUE_MAX_BYTES, count: memories.length }, 'Memory catalogue is over budget, it needs consolidating');
    }
    return catalogue;
}

/**
 * Recover the catalogue a system prompt listed. Tells a prompt carrying no memory
 * section (undefined) apart from one whose catalogue was empty ('').
 */
export function extractCatalogue(text: string): string | undefined {
    const block = text.match(CATALOGUE_BLOCK);
    if (block) {
        return block[1];
    }
    return text.includes(MEMORY_SECTION_LEAD) ? '' : undefined;
}

/**
 * What a conversation knows about the catalogue, in one pass over its steps:
 * what its system prompt listed, frozen at conversation start, and what it has
 * been told since. Both undefined before this conversation ever saw memory.
 */
export function catalogueState(steps: CatalogueStep[]): { inPrompt?: string; shown?: string } {
    let inPrompt: string | undefined;
    let shown: string | undefined;

    for (const step of steps) {
        if (step.source !== 'system') continue;

        const announced = step.extra?.[CATALOGUE_KEY];
        if (typeof announced === 'string') {
            shown = announced;
            continue;
        }

        const listed = extractCatalogue(step.message ?? '');
        if (listed !== undefined) {
            inPrompt ??= listed;
            shown = listed;
        }
    }

    return { inPrompt, shown };
}

const MEMORY_FILE_TOOL_PATHS: Record<string, string> = {
    view_file: 'path',
    edit_file: 'file_path',
    write_file: 'file_path',
};

/** Whether this conversation used a file tool against persistent memory. */
export function hasMemoryInteraction(steps: CatalogueStep[]): boolean {
    return steps.some(step => step.tool_calls?.some(toolCall => {
        const pathKey = MEMORY_FILE_TOOL_PATHS[toolCall.function_name];
        if (!pathKey) return false;

        const filePath = toolCall.arguments[pathKey];
        if (typeof filePath !== 'string') return false;

        const absolutePath = filePath.startsWith('~/')
            ? path.join(os.homedir(), filePath.slice(2))
            : path.isAbsolute(filePath)
                ? filePath
                : path.resolve(os.homedir(), filePath);
        return isMemoryFile(absolutePath);
    }) ?? false);
}

/** Memory state established by the conversation prompt and later transition steps. */
export function memoryState(steps: CatalogueStep[]): boolean | undefined {
    let state: boolean | undefined;

    for (const step of steps) {
        if (step.source !== 'system') continue;

        if (step.extra?.kind === MEMORY_STATE_KIND && typeof step.extra.memory_enabled === 'boolean') {
            state = step.extra.memory_enabled;
        } else if (step.message?.trim() === '# Memory enabled') {
            state = true;
        } else if (extractCatalogue(step.message ?? '') !== undefined) {
            state ??= true;
        }
    }

    return state;
}

export function shouldPauseMemory(steps: CatalogueStep[]): boolean {
    return hasMemoryInteraction(steps) && memoryState(steps) !== false;
}

export function memoryStateExtra(enabled: boolean, catalogue?: string): Record<string, unknown> {
    return {
        kind: MEMORY_STATE_KIND,
        memory_enabled: enabled,
        ...(catalogue === undefined ? {} : { [CATALOGUE_KEY]: catalogue }),
    };
}

/** Metadata for an update step, so a later turn can read back what it announced */
export function catalogueUpdateExtra(catalogue: string): Record<string, unknown> {
    return { kind: MEMORY_UPDATE_KIND, [CATALOGUE_KEY]: catalogue };
}

/**
 * Describe how the catalogue changed since the conversation last saw it.
 *
 * Compares the file on disk against what this conversation was told, so it is
 * works across whoever did the change - current agent, a parallel conversation,
 * the consolidation pass, or the user in their editor.
 */
export function formatCatalogueUpdate(shown: string, current: string): string | undefined {
    if (shown === current) {
        return undefined;
    }

    const shownEntries = parseCatalogue(shown);
    const currentEntries = parseCatalogue(current);

    const added: string[] = [];
    const rewritten: string[] = [];
    for (const [file, description] of currentEntries) {
        const before = shownEntries.get(file);
        if (before === undefined) {
            added.push(`${file}: ${description}`);
        } else if (before !== description) {
            rewritten.push(`${file}: ${description}`);
        }
    }
    const deleted = [...shownEntries.keys()].filter(file => !currentEntries.has(file));

    if (!added.length && !rewritten.length && !deleted.length) {
        return undefined;
    }

    const sections = [`# Memory updated`];

    if (added.length) {
        sections.push(`Added:\n${added.join('\n')}`);
    }
    if (rewritten.length) {
        sections.push(`Rewritten:\n${rewritten.join('\n')}`);
    }
    if (deleted.length) {
        sections.push(`Deleted:\n${deleted.join('\n')}`);
    }

    return sections.join('\n\n');
}

/** Read a rendered catalogue back into `file -> description` */
function parseCatalogue(catalogue: string): Map<string, string> {
    const entries = new Map<string, string>();
    for (const line of catalogue.split('\n')) {
        const entry = line.match(CATALOGUE_ENTRY);
        if (entry) {
            entries.set(entry[1]!, entry[3]!);
        }
    }
    return entries;
}

/**
 * Stamp provenance onto a memory file programmatically.
 *
 * Add where memory came from (on write) and when it last changed.
 */
export function stampProvenance(content: string, conversationId?: string, now: Date = new Date()): string {
    const parsed = parseFrontmatter(content);
    // A file without frontmatter is not a well-formed memory. Synthesizing a
    // fence for it would hide that rather than fix it.
    if (!parsed) {
        return content;
    }

    const yaml = parsed.yaml.split(/\r?\n/).filter(line => !line.startsWith('modified:'));
    if (conversationId && !parsed.fields.origin_conversation_id) {
        yaml.push(`origin_conversation_id: ${conversationId}`);
    }
    yaml.push(`modified: ${now.toISOString()}`);

    const frontmatter = `---\n${yaml.join('\n')}\n---\n`;
    return parsed.body ? `${frontmatter}\n${parsed.body}\n` : frontmatter;
}

/**
 * Build the memory section of the system prompt.
 *
 * Delegated conversations can see memories but do not get the writing instructions.
 */
export function formatMemoryForPrompt(catalogue: string, options?: { canWrite?: boolean }): string {
    const memoryDir = getMemoryDir();
    const canWrite = options?.canWrite ?? true;

    const sections = [`# Memory
${MEMORY_SECTION_LEAD} \`${memoryDir}\`. Each memory is one file holding one
fact. <memory_catalogue> lists every one of them as \`file (type): description\`, most recently
changed first. Read any whose descriptions look relevant. A memory reflects
what was true when it was written, so if one names a file, path or tool, check it still exists
before acting on it.`];

    if (canWrite) {
        sections.push(`The directory already exists - write fact files to it directly using write_file, in this format:

${MEMORY_FRONTMATTER}

<the fact. For feedback and project memories, follow with **Why:** and **How to apply:** lines.
Link related memories with [[their-filename]], without the .md.>

Name the file after the fact it holds, as a short kebab-case slug.

- \`user\` - who they are: role, expertise, working preferences.
- \`feedback\` - how you should work, corrections and confirmed approaches alike. Always say why.
- \`project\` - ongoing work, goals and constraints not easily derivable from their files. Write dates absolute.
- \`resource\` - where to find things (links, file paths), operational/environmental quirks (os, apps), and other miscellaneous useful facts.

The catalogue is built from these files, so writing one is the whole job - there is no index to keep up.
To forget something, delete its file; to revise it, edit it in place.

Every stored fact should make you more personable and useful to them.
Save sparingly though - every fact you keep makes the rest harder to find.
Check whether an existing memory already covers it and update that file rather than adding a near-duplicate.
Delete memories that turn out to be wrong or contradicted by new information.
Don't save what their files already record, or what only matters to this conversation;
if asked to remember something like that, ask what was non-obvious about it and save that instead.`);
    }

    // Tagged rather than inlined so descriptions cannot be read as part of the
    // instructions around them, and so the catalogue can be recovered from a
    // persisted system prompt later
    if (catalogue) {
        sections.push(`<memory_catalogue>\n${catalogue}\n</memory_catalogue>\n`);
    }

    return sections.join('\n\n');
}

export async function resolveMemoryContext(args: {
    steps: CatalogueStep[],
    memoriesEnabled: boolean,
    isNewConversation: boolean
}): Promise<MemoryContextPlan> {
    const {steps, memoriesEnabled, isNewConversation} = args;

    // If memory is disabled
    if (!memoriesEnabled) {
        // Add memory paused instruction to existing conversations that accessed memory
        return {
            systemSteps: !isNewConversation && shouldPauseMemory(steps) ? [{
                message: MEMORY_PAUSED_MESSAGE,
                extra: memoryStateExtra(false),
            }] : [],
        };
    }

    const currentCatalogue = await loadCatalogue();
    const seenCatalogue = catalogueState(steps);
    const priorState = memoryState(steps);
    const systemSteps: MemoryContextPlan['systemSteps'] = [];

    // Resume a paused conversation, or introduce memory to an existing conversation that has never seen it.
    if (priorState === false || (seenCatalogue.shown === undefined && !isNewConversation)) {
        systemSteps.push({
            message: '# Memory enabled',
            extra: memoryStateExtra(
                true,
                // Preserve previously shown catalogue until any following update is persisted.
                seenCatalogue.shown == undefined ? currentCatalogue : undefined),
        });
    }

    // Announce catalogue changes in order after the conversation's last known memory state.
    if (seenCatalogue.shown !== undefined) {
        const update = formatCatalogueUpdate(seenCatalogue.shown, currentCatalogue);
        if (update) {
            systemSteps.push({
                message: update,
                extra: catalogueUpdateExtra(currentCatalogue),
            });
        }
    }

    return {
        memoryCatalogue: seenCatalogue.inPrompt ?? seenCatalogue.shown ?? currentCatalogue,
        systemSteps,
    }
}
