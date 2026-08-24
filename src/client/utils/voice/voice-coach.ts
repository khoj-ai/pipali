/**
 * Picks the spoken command worth teaching at this moment of a voice session.
 *
 * The chat input placeholder is the one always-visible line of text in the
 * composer, so it — not a hover tooltip — is where coaching belongs. What makes
 * a hint correct is the addressing rule: in open context only speech starting
 * with "Pipali" is heard, while inside an open turn raw speech is the message
 * and tail phrases end it. So the same intent needs different words per state,
 * which is exactly what one static tooltip cannot express.
 *
 * Pure module — no DOM, no I/O — returning an i18n key under `voice.coach`.
 */

import type { VoiceMode, VoiceStatus } from './voice-config';

export interface VoiceCoachContext {
    mode: VoiceMode;
    status: VoiceStatus;
    /**
     * What the composer is waiting on the user for. `question` is an `ask_user`
     * operation, where a spoken reply is the answer rather than an approve or
     * decline, so "say yes or no" would be wrong advice.
     */
    pending: 'confirmation' | 'question' | null;
    /** A run is in flight, so calling it off is the useful next command. */
    isProcessing: boolean;
}

export type VoiceCoachKey = `voice.coach.${'idle' | 'idleWorking' | 'dormant'
    | 'goAheadPending' | 'goAheadResult'
    | 'speaking' | 'listening' | 'listeningDecision' | 'listeningQuestion'}`;

/**
 * The i18n key for the hint to coach with, or null when voice is off and the
 * composer should fall back to its typed-input placeholders.
 *
 * States with no command of their own fall through to the standing hint rather
 * than narrating themselves: the placeholder is for what the user can say, and
 * status they can already see belongs on the mic button.
 */
export function voiceCoachKey({ mode, status, pending, isProcessing }: VoiceCoachContext): VoiceCoachKey | null {
    if (mode === 'off') return null;

    switch (status) {
        case 'dormant':
            return 'voice.coach.dormant';
        case 'speaking':
            // Barge-in accepts bare speech, so the address word is not required.
            return 'voice.coach.speaking';
        case 'announced':
            // A go-ahead is only the user's move in ask_first. speak_freely reads
            // out on its own once the cue lands, and this status is only shown
            // when nothing blocks that, so there is nothing to prompt for.
            // Nothing pending in the composer makes the announcement a finished
            // result rather than something owed an answer.
            if (mode === 'ask_first') return pending ? 'voice.coach.goAheadPending' : 'voice.coach.goAheadResult';
            break;
        case 'listening':
            // A turn is open: raw speech is the message, tail phrases close it,
            // and a decision is a bare "yes"/"no" with no address word.
            if (pending === 'question') return 'voice.coach.listeningQuestion';
            if (pending === 'confirmation') return 'voice.coach.listeningDecision';
            return 'voice.coach.listening';
        case 'idle':
        case 'transcribing':
            // Idle is open context. It may hold an already-heard confirmation,
            // where the standing "Pipali…" hint correctly opens a reply turn.
            // Transcribing is already past the point any tail phrase applies.
            break;
    }

    return isProcessing ? 'voice.coach.idleWorking' : 'voice.coach.idle';
}
