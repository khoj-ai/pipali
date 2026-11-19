#!/usr/bin/env bun
/**
 * Print what was said in the user's conversations since a cutoff, for the dream to read.
 *
 * A raw conversation history is mostly tool calls and their output - megabytes of it
 * for a working day, and none of it where preferences and corrections live. Those are
 * in what the user typed or answered when asked, and in the replies they were reacting
 * to. This keeps those and drops the rest, along with whatever an earlier dream already
 * read.
 *
 * Usage: bun transcripts.ts [--since <ISO date>] [--limit <n>] [--url <server>]
 */

/** The address the server binds by default. localhost can resolve to ::1, where nothing listens */
const DEFAULT_URL = 'http://127.0.0.1:6464';
const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_DAYS = 7;

/** Long enough to carry a correction with its reasoning, short enough to skim many */
const USER_MAX_CHARS = 1_200;

interface ConversationSummary {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    isAutomation?: boolean;
    parentConversationId?: string | null;
}

interface Step {
    source: string;
    timestamp: string;
    message?: string;
    tool_calls?: Array<{ tool_call_id?: string; function_name: string; arguments?: Record<string, unknown> }>;
    observation?: { results?: Array<{ source_call_id: string; content: unknown }> };
    extra?: Record<string, unknown>;
}

/** An ask_user result holding the user's own choice or words, not an acknowledgement or error */
const ANSWERED = /^User (responded|selected|entered)/;

function truncate(text: string, max: number): string {
    const trimmed = text.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * The conversation list gives its times in UTC without a zone, which Date.parse alone
 * reads as local time.
 */
function utcTime(time: string): number {
    return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(time) ? time : `${time}Z`.replace(' ', 'T'));
}

/** The user's own clock unless a zone is named, as "yesterday" in a message means their day */
function localTime(time: number, timeZone?: string): string {
    return new Date(time).toLocaleString('sv-SE', { timeZone }).slice(0, 16);
}

/**
 * What one step holds of the exchange: what the user typed, Pipali's reply to them, or
 * a question it asked through ask_user with what they answered.
 */
function spoken(step: Step): Array<{ speaker: string; text: string }> {
    if (step.extra?.is_compaction) return [];

    // The user's answer is held nowhere but the tool result
    const asked = (step.tool_calls ?? []).flatMap(call => {
        const answer = step.observation?.results?.find(result => result.source_call_id === call.tool_call_id)?.content;
        if (call.function_name !== 'ask_user' || typeof answer !== 'string' || !ANSWERED.test(answer)) return [];
        const question = [call.arguments?.title, call.arguments?.description].filter(Boolean).join(' - ');
        return [
            { speaker: 'pipali', text: `pipali asked: ${question.trim()}` },
            { speaker: 'user', text: truncate(answer.replace('User', 'user'), USER_MAX_CHARS) },
        ];
    });
    if (asked.length > 0) return asked;

    if (!step.message?.trim()) return [];
    if (step.source === 'user') return [{ speaker: 'user', text: `user: ${truncate(step.message, USER_MAX_CHARS)}` }];
    // An agent step carrying tool calls is Pipali narrating its own work, not answering
    if (step.source === 'agent' && !step.tool_calls?.length) {
        return [{ speaker: 'pipali', text: `pipali: ${step.message.trim()}` }];
    }
    return [];
}

/**
 * Render what was said in one conversation since the cutoff, as the exchange between
 * the user and Pipali.
 *
 * The conversation's own creation bounds what is new as well: the steps a fork copies
 * from its source keep the times they were first said.
 *
 * The message before the first new one is kept when the other side sent it - the reply a
 * new message reacts to, or the question a new reply answers.
 *
 * Returns an empty string when nothing new was said.
 */
export function formatTranscript(
    conversation: ConversationSummary,
    history: Step[],
    since: Date,
    timeZone?: string,
): string {
    const newFrom = Math.max(since.getTime(), utcTime(conversation.createdAt));

    // A message's later lines are indented, so a heading inside a reply cannot pass for a
    // conversation's heading or the start of a message
    const said = history.flatMap(step => {
        const time = utcTime(step.timestamp);
        return spoken(step).map(({ speaker, text }) => (
            { speaker, text: `${localTime(time, timeZone)} ${text.replace(/\n(?=[^\n])/g, '\n  ')}`, isNew: time >= newFrom }
        ));
    });

    const first = said.findIndex(message => message.isNew);
    if (first === -1) return '';

    const before = said[first - 1];
    const messages = said.filter(message => message.isNew).map(message => message.text);
    if (before && before.speaker !== said[first]!.speaker) {
        messages.unshift(`(earlier) ${before.text}`);
    }

    return [`## ${conversation.title} (${conversation.id})`, ...messages].join('\n');
}

/**
 * Conversations the user held themselves since the cutoff, most recent first, with how
 * many there were before the limit cut them short.
 */
export function selectConversations(
    conversations: ConversationSummary[],
    since: Date,
    limit: number,
): { selected: ConversationSummary[]; total: number } {
    const recent = conversations
        .filter(conversation => !conversation.isAutomation && !conversation.parentConversationId)
        .filter(conversation => utcTime(conversation.updatedAt) > since.getTime())
        .sort((a, b) => utcTime(b.updatedAt) - utcTime(a.updatedAt));

    return { selected: recent.slice(0, limit), total: recent.length };
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
    const { selected, total } = selectConversations(conversations, since, limit);
    const leftOut = total > selected.length
        ? ` of ${total}, most recent first. Rerun with --limit ${total} for the rest`
        : '';

    console.log(`Conversations since ${localTime(since.getTime())}, in local time: ${selected.length}${leftOut}\n`);

    for (const conversation of selected) {
        const response = await fetch(`${url}/api/chat/${conversation.id}/history`);
        if (!response.ok) continue;
        const { history } = await response.json() as { history: Step[] };
        const transcript = formatTranscript(conversation, history, since);
        if (transcript) console.log(`${transcript}\n`);
    }
}

if (import.meta.main) {
    await main();
}
