/**
 * Turn transcript assembly for segmented hands-free speech.
 *
 * Segments transcribe concurrently and may resolve out of order; the assembler
 * appends them in sequence order and re-checks the transcript tail whenever the
 * contiguous prefix grows. The turn ends only on a tail-position end phrase
 * (or discard phrase) — silence never ends a turn.
 *
 * Pure: strings in, actions out. No audio or network.
 */

import { normalizeUtterance, parseAddressing } from './voice-intent';
import { END_PHRASES, DISCARD_PHRASES, CANCEL_PHRASES, STT_BIAS_PROMPT, VOICE_TUNABLES } from './voice-config';

function tokenize(text: string): string[] {
    return normalizeUtterance(text).split(' ').filter(Boolean);
}

function ngrams(tokens: string[], n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(' '));
    return out;
}

// Whisper-family models hallucinate fixed phrases on noise-only audio.
// Conservative full-string matches only — never drop real dictation.
const HALLUCINATION_PATTERNS: RegExp[] = [
    /^thank you[.!]?$/i,
    /^thanks?[.!]?$/i,
    /^thanks? for watching[\s\S]*$/i,
    /^thank you for watching[\s\S]*$/i,
    /^please (like and )?subscribe[\s\S]*$/i,
    /^subtitles? by[\s\S]*$/i,
    /^(blank[_ ]?audio|silence|music|inaudible)[.!]?$/i,
    // Any wholly-bracketed transcript is a tag, never speech: "[MUSIC PLAYING]",
    // "[Applause]", "[SOUND]" — the enumerated list kept missing the variants.
    /^\[[^\]]*\]$/,
    /^you[.!]?$/i,
    /^[.\s]*$/,
    // "hey pipali" was here as a suspected prompt echo, but it is the documented
    // wake phrase — blocking it meant the one thing the UI teaches did nothing.
    // The min-speech gate already drops noise-only audio, and a bare address can
    // only open a listening turn: visible, and destructive of nothing.
];

// The model also reads its own conditioning text back when the audio holds no
// speech. Trigram containment rather than substring equality: one word of drift
// ("never mind" for the prompt's "nevermind", "Pipli" for "Pipali") was enough
// for an exact match to miss a fifty-word echo entirely. Matching the prompt
// text — not just the commands in it — is what catches an echo of the framing
// prose, which is 30% of the prompt and carries no command phrases at all.
// Derived from the live prompt, so rewording can't leave this behind; the token
// floor keeps short utterances that live in it ("send it", "hey Pipali") usable.
const PROMPT_TRIGRAMS = new Set(ngrams(tokenize(STT_BIAS_PROMPT), 3));
const PROMPT_ECHO_MIN_TOKENS = 6;
const PROMPT_ECHO_MIN_CONTAINMENT = 0.8;

function isPromptEcho(text: string): boolean {
    const tokens = tokenize(text);
    if (tokens.length < PROMPT_ECHO_MIN_TOKENS) return false;
    const grams = ngrams(tokens, 3);
    return grams.filter((g) => PROMPT_TRIGRAMS.has(g)).length / grams.length >= PROMPT_ECHO_MIN_CONTAINMENT;
}

export function isHallucination(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    return isPromptEcho(t) || HALLUCINATION_PATTERNS.some((p) => p.test(t));
}

/**
 * Could this many words have been spoken in this much audio? The signal the
 * wording checks can't see: invented text has no relation to the clip's length,
 * and noise padded into speech routinely runs past what the clip could hold.
 * Catches hallucinations of any wording — but only long ones, since a short
 * invention fits the clip honestly. The wording checks cover that end.
 */
export function isImplausibleSpeechRate(text: string, durationMs: number): boolean {
    if (durationMs <= 0) return false;
    return tokenize(text).length / (durationMs / 1000) > VOICE_TUNABLES.maxWordsPerSecond;
}

/**
 * Is this transcript just Pipali hearing itself? The backstop behind the
 * acoustic echo guard, for the moments it leaks — the start of a readout,
 * before the echo-return estimate has converged.
 *
 * The rule: an utterance made entirely of words Pipali is saying right now
 * cannot be told apart from its own echo, so it is ignored. Multi-word
 * utterances match on adjacent pairs (STT echoes arrive as contiguous
 * fragments); addressed speech is the user by construction and never echo.
 * Failing safe matters most for "yes" — a false barge-in that resolved a
 * confirmation would approve an action nobody asked for.
 */
export function isSelfEcho(heard: string, spoken: string): boolean {
    const h = tokenize(heard);
    const s = tokenize(spoken);
    if (!h.length || !s.length) return false;
    if (parseAddressing(heard).addressed) return false;
    if (h.length === 1) return s.includes(h[0]!);

    const spokenPairs = new Set(s.slice(1).map((w, i) => `${s[i]} ${w}`));
    const heardPairs = h.slice(1).map((w, i) => `${h[i]} ${w}`);
    const shared = heardPairs.filter((pair) => spokenPairs.has(pair)).length;
    return shared / heardPairs.length >= VOICE_TUNABLES.selfEchoBigramRatio;
}

/** Do the last tokens of `text` (normalized) spell out `phrase`? */
export function endsWithPhrase(text: string, phrase: string): boolean {
    const tokens = tokenize(text);
    const phraseTokens = tokenize(phrase);
    if (phraseTokens.length === 0 || phraseTokens.length > tokens.length) return false;
    const tail = tokens.slice(tokens.length - phraseTokens.length);
    return phraseTokens.every((w, i) => tail[i] === w);
}

/**
 * Remove the trailing phrase (plus surrounding filler/punctuation) from the raw
 * text, preserving the message's own casing and punctuation. Walks raw tokens
 * from the end so "…, send it please" strips cleanly.
 */
export function stripTailPhrase(text: string, phrase: string): string {
    const rawTokens = text.split(/\s+/).filter(Boolean);
    const phraseTokens = tokenize(phrase);
    const isFiller = (token: string) => normalizeUtterance(token) === '';

    let i = rawTokens.length;
    const skipFiller = () => { while (i > 0 && isFiller(rawTokens[i - 1]!)) i--; };

    skipFiller();
    for (let k = phraseTokens.length - 1; k >= 0; k--) {
        skipFiller();
        if (i > 0 && normalizeUtterance(rawTokens[i - 1]!) === phraseTokens[k]) i--;
        else return text; // detection/strip mismatch — leave the text untouched
    }
    skipFiller();

    return rawTokens.slice(0, i).join(' ').replace(/[\s,;:]+$/, '').trim();
}

export type TurnAction =
    | { type: 'none' }
    | { type: 'submit'; message: string }
    | { type: 'discard' }   // clear the transcript, keep listening (rephrase)
    | { type: 'cancel' };   // abandon the turn, stop listening

export class TurnTranscript {
    private parts = new Map<number, string>();
    private assembledThrough = -1;
    private assembled: string[] = [];
    private spokeBefore = false;

    /** Add a transcribed segment; returns the action implied by the new tail. */
    addSegment(seq: number, rawText: string): TurnAction {
        const text = isHallucination(rawText) ? '' : rawText.trim();
        this.parts.set(seq, text);

        let advanced = false;
        while (this.parts.has(this.assembledThrough + 1)) {
            this.assembledThrough++;
            const part = this.parts.get(this.assembledThrough)!;
            this.parts.delete(this.assembledThrough);
            if (part) {
                this.assembled.push(part);
                this.spokeBefore = true;
            }
            advanced = true;
        }
        if (!advanced) return { type: 'none' };
        return this.checkTail();
    }

    get text(): string {
        return this.assembled.join(' ');
    }

    /** Whether anything was said this turn, even if scratched since */
    get spoke(): boolean {
        return this.spokeBefore;
    }

    /** Tap-to-end: take whatever has been assembled, no phrase required. */
    finalize(): string {
        return this.text;
    }

    /**
     * Drop everything assembled so far but keep sequence bookkeeping, so
     * segments spoken after a "scratch that" continue to assemble in order.
     */
    clear(): void {
        this.assembled = [];
    }

    private checkTail(): TurnAction {
        const text = this.text;
        if (!text) return { type: 'none' };
        for (const phrase of CANCEL_PHRASES) {
            if (endsWithPhrase(text, phrase)) return { type: 'cancel' };
        }
        for (const phrase of DISCARD_PHRASES) {
            if (endsWithPhrase(text, phrase)) return { type: 'discard' };
        }
        for (const phrase of END_PHRASES) {
            if (endsWithPhrase(text, phrase)) {
                return { type: 'submit', message: stripTailPhrase(text, phrase) };
            }
        }
        return { type: 'none' };
    }
}
