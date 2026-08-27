/**
 * Proactive memory recall
 *
 * A fast-model selector reads the memory catalogue plus the user's message and
 * picks the few memories worth injecting before the research loop starts.
 * Uses an LLM as lexical matching could miss a memory using a different phrasing.
 * So a memory recorded in one phrasing ("bought honda civic") can be auto-recalled
 * easily later ("how to fix my car?").
 *
 * Kept out of index.ts because it calls the model: index.ts stays free of
 * processor/ imports, which processor code relies on when importing memory.
 */

import { listMemories, getMemory, formatCatalogueEntry, formatMemoryRecall, type StoredMemory } from './index';
import { sendMessageToFastModel } from '../processor/conversation';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'memory-recall' });

/** At most this many memories are injected per turn */
const MAX_RECALLED = 5;

const SELECTOR_PROMPT = `You are selecting memories that will be useful to Pipali as it handles a user's message.
<memory_catalogue> lists the available memories, one per line as "filename (type): description".
<user_message> holds the user's message.

Return filenames for the memories that will clearly be useful (up to ${MAX_RECALLED}). Only include
memories you are confident will help, based on filename and description alone.
- If unsure, leave it out. Be selective.
- If nothing is clearly useful, return an empty list.
- Be especially conservative with \`user\` and \`project\` memories. These describe the user's
  ongoing context, not what every message is about. A profile saying "works on ledger
  automation" is NOT relevant to a question that merely contains the word "automation"
  unless the question is actually about that work. Match on what the message IS ABOUT, not
  on keyword overlap with who the user is.

Respond with only JSON, no other text: {"selected_memories": ["<filename>", ...]}`;

/** Pull a list of filenames out of one JSON fragment, or undefined if it holds none */
function readSelection(json: string | undefined, pick: (parsed: any) => unknown): string[] | undefined {
    if (!json) return undefined;

    try {
        const selected = pick(JSON.parse(json));
        return Array.isArray(selected)
            ? selected.filter((file): file is string => typeof file === 'string')
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Read the selector's reply, tolerating fences, tags and prose around the list.
 *
 * The asked-for object is tried first, then a bare array: small models often
 * answer with the list wrapped in <selected_memories> tags or on its own, and
 * reading only the object shape silently dropped those turns entirely. A reply
 * carrying no list at all still reads as unreadable rather than as an empty
 * selection, so a broken selector stays visible in the logs.
 */
export function parseSelectedMemories(reply: string): string[] | undefined {
    return readSelection(reply.match(/\{[\s\S]*\}/)?.[0], parsed => parsed?.selected_memories)
        ?? readSelection(reply.match(/\[[\s\S]*?\]/)?.[0], parsed => parsed);
}

/**
 * Pick the memories relevant to the user's message and render them as one
 * recall step, or undefined when nothing is worth injecting.
 *
 * Memories the conversation already holds are excluded before selection, so a
 * memory matching the conversation's standing topic is injected once, not every
 * turn. Never throws - a failed recall costs one turn of proactivity, the model
 * can still reach any memory through the catalogue.
 */
export async function recallMemories(
    userMessage: string,
    surfaced: ReadonlySet<string>,
): Promise<{ message: string; extra: Record<string, unknown> } | undefined> {
    try {
        const candidates = (await listMemories())
            .filter(memory => memory.description && !surfaced.has(memory.file));
        if (candidates.length === 0) return undefined;

        const startTime = Date.now();
        const response = await sendMessageToFastModel(
            `<memory_catalogue>\n${candidates.map(formatCatalogueEntry).join('\n')}\n</memory_catalogue>\n\n<user_message>\n${userMessage}\n</user_message>`,
            SELECTOR_PROMPT,
        );

        const selected = parseSelectedMemories(response?.message ?? '');
        if (selected === undefined) {
            log.warn({ reply: response?.message?.slice(0, 200) }, 'Memory selector reply was unreadable, recalling nothing');
            return undefined;
        }

        const candidateFiles = new Set(candidates.map(candidate => candidate.file));
        const memories = (await Promise.all(
            selected
                .filter(file => candidateFiles.has(file))
                .slice(0, MAX_RECALLED)
                .map(file => getMemory(file)),
        )).filter((memory): memory is StoredMemory => memory !== undefined);

        log.info({
            durationMs: Date.now() - startTime,
            candidates: candidates.length,
            recalled: memories.map(memory => memory.file),
        }, 'Memory recall');

        return memories.length > 0 ? formatMemoryRecall(memories) : undefined;
    } catch (err) {
        log.warn({ err }, 'Memory recall failed, continuing without');
        return undefined;
    }
}
