#!/usr/bin/env bun
/**
 * Print what was said in the user's recent conversations, for the dream to read.
 *
 * A raw conversation history is mostly tool calls and their output - megabytes of it
 * for a working day, and none of it where preferences and corrections live. Those are
 * in what the user typed, and in the replies they were reacting to. This keeps those
 * two and drops the rest.
 *
 * Usage: bun transcripts.ts [--since <ISO date>] [--limit <n>] [--url <server>]
 */

const DEFAULT_URL = 'http://localhost:6464';
const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_DAYS = 7;

/** Long enough to carry a correction with its reasoning, short enough to skim many */
const USER_MAX_CHARS = 1_200;
/** The reply is context for the user's next message, not the material itself */
const AGENT_MAX_CHARS = 400;

interface ConversationSummary {
    id: string;
    title: string;
    updatedAt: string;
    isAutomation?: boolean;
    parentConversationId?: string | null;
}

interface Step {
    source: string;
    message?: string;
    tool_calls?: unknown[];
    extra?: Record<string, unknown>;
}

function truncate(text: string, max: number): string {
    const trimmed = text.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Render one conversation as the exchange between the user and Pipali.
 *
 * Returns an empty string when nothing was said - a conversation that only ever ran
 * tools has nothing for the dream to learn from.
 */
export function formatTranscript(conversation: ConversationSummary, history: Step[]): string {
    const lines = history.flatMap(step => {
        if (step.extra?.is_compaction || !step.message?.trim()) return [];
        if (step.source === 'user') return [`user: ${truncate(step.message, USER_MAX_CHARS)}`];
        // An agent step carrying tool calls is Pipali narrating its own work, not answering
        if (step.source === 'agent' && !step.tool_calls?.length) {
            return [`pipali: ${truncate(step.message, AGENT_MAX_CHARS)}`];
        }
        return [];
    });

    if (lines.length === 0) return '';

    return [`## ${conversation.title} (${conversation.updatedAt})`, ...lines].join('\n');
}

/** Conversations the user held themselves, most recent first */
export function selectConversations(
    conversations: ConversationSummary[],
    since: Date,
    limit: number,
): ConversationSummary[] {
    return conversations
        .filter(conversation => !conversation.isAutomation && !conversation.parentConversationId)
        .filter(conversation => Date.parse(conversation.updatedAt) > since.getTime())
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limit);
}

function readFlag(name: string): string | undefined {
    const index = Bun.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : Bun.argv[index + 1];
}

async function main(): Promise<void> {
    const url = (readFlag('url') ?? process.env.PIPALI_SERVER_URL ?? DEFAULT_URL).replace(/\/$/, '');
    const limit = Number(readFlag('limit') ?? DEFAULT_LIMIT);
    const sinceFlag = Date.parse(readFlag('since') ?? '');
    const since = new Date(Number.isNaN(sinceFlag)
        ? Date.now() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000
        : sinceFlag);

    const listed = await fetch(`${url}/api/conversations`);
    if (!listed.ok) {
        console.error(`Could not list conversations: ${listed.status} ${listed.statusText}. Is the server at ${url}?`);
        process.exit(1);
    }

    const { conversations } = await listed.json() as { conversations: ConversationSummary[] };
    const selected = selectConversations(conversations, since, limit);

    console.log(`Conversations since ${since.toISOString()}: ${selected.length}\n`);

    for (const conversation of selected) {
        const response = await fetch(`${url}/api/chat/${conversation.id}/history`);
        if (!response.ok) continue;
        const { history } = await response.json() as { history: Step[] };
        const transcript = formatTranscript(conversation, history);
        if (transcript) console.log(`${transcript}\n`);
    }
}

if (import.meta.main) {
    await main();
}
