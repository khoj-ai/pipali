/**
 * Deterministic voice intent parser for the voice companion.
 *
 * Runs before any LLM involvement. It maps a spoken utterance to a confirmation
 * decision, and recognizes a lightweight "go-ahead" ack. It branches on whether
 * the confirmation is a question (`ask_user`): for questions the spoken reply is
 * the answer (guidance), never an approve/decline.
 *
 * Pure module — no DOM, no I/O — so it's cheap to unit-test exhaustively.
 */

import { ADDRESS_NAME, ADDRESS_LEAD_INS, SPEAK_FREELY_PHRASES, ASK_FIRST_PHRASES, STOP_WORK_PHRASES } from './voice-config';

export type VoiceIntent =
    | { type: 'approve' }
    | { type: 'approve_dont_ask' }
    | { type: 'decline' }
    | { type: 'details' }
    | { type: 'repeat' }
    | { type: 'stop_listening' }
    | { type: 'set_mode'; mode: 'ask_first' | 'speak_freely' }
    | { type: 'guidance'; text: string };

// Single-token filler stripped before matching ("um, yes please" → "yes").
const FILLER = new Set(['um', 'uh', 'er', 'hmm', 'mm', 'like', 'just', 'please', 'well']);

const APPROVE = new Set([
    'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'continue', 'go', 'go ahead',
    'proceed', 'do it', 'confirm', 'confirmed', 'approve', 'approved', 'sounds good',
    'go for it', 'affirmative', 'yes go',
]);
const DECLINE = new Set([
    'no', 'nope', 'nah', 'cancel', 'stop', 'dont', 'do not', 'decline', 'reject',
    'abort', 'never mind', 'nevermind', 'negative',
]);
const DETAILS = new Set([
    'details', 'detail', 'explain', 'more', 'tell me more', 'what', 'what is it',
    'what does it do', 'show me', 'elaborate', 'tell me',
]);
const REPEAT = new Set(['repeat', 'say again', 'again', 'come again', 'what did you say', 'pardon']);
const STOP_LISTENING = [
    'stop listening', 'turn off voice', 'turn voice off', 'disable voice', 'stop voice',
    'exit voice', 'be quiet', 'mute',
];
// A go-ahead is a frictionless readiness ack — approve words plus "show me the details".
const GO_AHEAD_EXTRA = new Set(['ready', 'im ready', 'go on', 'lets hear it', 'lets go']);

/** Lowercase, strip punctuation/apostrophes, drop filler tokens, collapse spaces. */
export function normalizeUtterance(text: string): string {
    return text
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w && !FILLER.has(w))
        .join(' ')
        .trim();
}

// Exact whole-utterance match only: disabling voice is destructive, and
// substring matching let hallucinated or ambient sentences that merely
// contained "stop listening" kill the session (normalize already strips
// filler, so "please stop listening" still matches).
function matchesStopListening(n: string): boolean {
    return STOP_LISTENING.some((p) => n === p);
}

// Same whole-utterance rule: mode phrases are short imperatives, and a
// sentence merely containing one must not flip the speaking etiquette.
function matchesModeSwitch(n: string): 'ask_first' | 'speak_freely' | null {
    if (SPEAK_FREELY_PHRASES.some((p) => n === p)) return 'speak_freely';
    if (ASK_FIRST_PHRASES.some((p) => n === p)) return 'ask_first';
    return null;
}

/**
 * Is this utterance a go-ahead — the user signaling they're ready to listen?
 * Permissive: any approve word, a details request, or a readiness phrase.
 */
export function parseGoAhead(text: string): boolean {
    const n = normalizeUtterance(text);
    if (!n) return false;
    return APPROVE.has(n) || DETAILS.has(n) || GO_AHEAD_EXTRA.has(n);
}

export type OpenVoiceRoute = 'speak_pending' | 'reply' | 'compose';

/** Route addressed speech when no turn is open. `null` means nothing is pending. */
export function routeOpenVoice(payload: string, pendingHeard: boolean | null): OpenVoiceRoute {
    if (pendingHeard === null) return 'compose';
    if (!pendingHeard && (!payload || parseGoAhead(payload))) return 'speak_pending';
    return 'reply';
}

/**
 * Is this utterance "stop what you're doing" — a run to abandon, or a readout
 * the user has heard enough of? Whole-utterance only, on the same reasoning as
 * the other destructive commands: a sentence merely containing "wait" must not
 * throw away work in flight.
 */
export function parseStopWork(text: string): boolean {
    const n = normalizeUtterance(text);
    return !!n && STOP_WORK_PHRASES.includes(n);
}

/** Small-string edit distance via classic DP — inputs are single words. */
function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const curr = [i];
        for (let j = 1; j <= n; j++) {
            curr[j] = Math.min(
                prev[j]! + 1,
                curr[j - 1]! + 1,
                prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        prev = curr;
    }
    return prev[n]!;
}

const LEAD_INS = new Set(ADDRESS_LEAD_INS);

/**
 * Does this open-context utterance address Pipali? Matches the address word as
 * the first token (after optional lead-ins like "hey"), fuzzily — STT mangles
 * the proper noun ("Bipali") and may split it ("Pip ali"). Returns the payload
 * after the address word: "Pipali, also check the logs" → "also check the logs".
 */
export function parseAddressing(text: string): { addressed: boolean; payload: string } {
    const rawTokens = text.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < rawTokens.length && LEAD_INS.has(normalizeUtterance(rawTokens[i]!))) i++;

    const first = normalizeUtterance(rawTokens[i] ?? '');
    if (!first) return { addressed: false, payload: '' };

    let consumed = 0;
    if (first.length >= 4 && editDistance(first, ADDRESS_NAME) <= 2) {
        consumed = 1;
    } else if (i + 1 < rawTokens.length) {
        // STT sometimes splits the name: "Pip ali, do X".
        const merged = first + normalizeUtterance(rawTokens[i + 1]!);
        if (merged.length >= 4 && editDistance(merged, ADDRESS_NAME) <= 1) consumed = 2;
    }
    if (consumed === 0) return { addressed: false, payload: '' };

    const payload = rawTokens
        .slice(i + consumed)
        .join(' ')
        .replace(/^[\s,.:;!?–—-]+/, '')
        .trim();
    return { addressed: true, payload };
}

/**
 * Classify a spoken reply to a confirmation. `isQuestion` should be true for
 * `ask_user` operations, where the reply is a free-form answer (guidance).
 */
export function parseConfirmationIntent(text: string, opts: { isQuestion: boolean }): VoiceIntent {
    const n = normalizeUtterance(text);
    if (!n) return { type: 'guidance', text };

    // Universal commands, available even for questions.
    if (matchesStopListening(n)) return { type: 'stop_listening' };
    const mode = matchesModeSwitch(n);
    if (mode) return { type: 'set_mode', mode };
    if (REPEAT.has(n)) return { type: 'repeat' };
    if (n.includes('dont ask again') || n === 'always' || n === 'yes always') {
        return { type: 'approve_dont_ask' };
    }

    // A question's reply is the answer, not an approve/decline.
    if (opts.isQuestion) return { type: 'guidance', text };

    if (APPROVE.has(n)) return { type: 'approve' };
    if (DECLINE.has(n)) return { type: 'decline' };
    if (DETAILS.has(n)) return { type: 'details' };

    return { type: 'guidance', text };
}
