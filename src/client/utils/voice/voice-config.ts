/**
 * Tunable constants and spoken-command phrase sets for the hands-free voice
 * pipeline, grouped here per the voice spec so dogfooding adjustments touch
 * one module. Spoken command phrases are English-only for now; keeping the
 * sets here is what makes later localization a data change, not a code change.
 */

export const VOICE_TUNABLES = {
    /** Audio kept before detected speech onset so the first word isn't clipped. */
    preRollMs: 300,
    /** VAD analysis frame length. */
    analysisFrameMs: 30,
    /** RMS threshold (on [-1,1] float samples) above which a frame counts as voiced. */
    energyThreshold: 0.015,
    /** Voiced frames within the onset window required to open a segment. */
    speechStartFrames: 3,
    /**
     * Onset window size (frames). Majority voting (3 of 4) instead of strictly
     * consecutive frames, so the consonant dips in short commands ("send it",
     * "Pipali") don't keep resetting onset at normal speaking volume.
     */
    speechStartWindow: 4,
    /** Trailing silence that closes a segment — a pause, never the turn. */
    silenceEndMs: 900,
    /** Segments with less voiced audio than this are rejected as blips. */
    minSpeechMs: 200,
    /** Safety cap: force-close a segment that runs this long. */
    maxSegmentMs: 30_000,
    /** Sample rate segments are downsampled to before WAV-encoding for STT. */
    sttSampleRate: 16_000,
    // --- Full duplex: the mic stays open while Pipali speaks ---
    /**
     * Voiced threshold while Pipali is audible. The platform's own echo
     * cancellation does the real work here — measured on macOS, it drops
     * Pipali's voice at the mic to ~0.4% of what was played, far under the plain
     * threshold. This is the modest second line for whatever residual gets
     * through, chosen to sit above that and below ordinary speech (~0.05-0.15),
     * so talking over a readout still just works.
     */
    speakingEnergyThreshold: 0.04,
    /** Gain Pipali's speech ducks to while a suspected barge-in is transcribed. */
    duckGain: 0.15,
    /**
     * How far ahead of the speaker TTS playback schedules. Audio arrives over
     * the network a chunk at a time, so this lead is the jitter budget: late
     * arrivals are absorbed by it instead of landing as a silence gap mid-word.
     * Spent lead is only rebuilt after a real underrun, so the cost is paid once
     * per readout — inaudible next to synthesis latency.
     */
    speechLeadMs: 200,
    /** Lead below which the buffer counts as spent and playback re-leads. */
    speechMinLeadMs: 20,
    /**
     * Minimum audio per scheduled buffer. A phone's HTTP chunks carry ~30ms of
     * speech each; coalescing them means fewer buffer boundaries, and each
     * boundary is a chance to glitch.
     */
    speechBlockMs: 100,
    /** Share of an utterance's word pairs Pipali must be saying for it to read as echo. */
    selfEchoBigramRatio: 0.6,
    /** How long after Pipali finishes speaking that bare speech counts as the reply. */
    replyInvitationMs: 10_000,
    /** Session ends (dormant) after this long without addressed speech. */
    idleTimeoutMs: 900_000,
    /** Minimum gap between work heartbeat pulses (steps can fire in bursts). */
    workPulseMinIntervalMs: 1_000,
    /**
     * Words per second above which a transcript cannot be speech that was in
     * the clip. Fast human delivery peaks near 5 (~300 wpm), and every segment
     * carries pre-roll plus trailing silence, so a real one measures well under
     * this. Only text the model invented over noise reaches it.
     */
    maxWordsPerSecond: 8,
} as const;

/**
 * Voice mode: off, or one of two speaking etiquettes. `ask_first` chimes and
 * waits for a go-ahead before reading a summary; `speak_freely` reads it as
 * soon as it's ready. Listening behavior is identical in both.
 */
export type VoiceMode = 'off' | 'ask_first' | 'speak_freely';

/**
 * Where a live voice session is in its cycle. `dormant` is the mic off after an
 * idle timeout; `announced` is Pipali holding something back until the user
 * gives a go-ahead. Drives both the mic button and the composer's coaching.
 */
export type VoiceStatus = 'idle' | 'dormant' | 'announced' | 'speaking' | 'listening' | 'transcribing';

/** Whole-utterance phrases that switch Pipali to speaking without a go-ahead. */
export const SPEAK_FREELY_PHRASES = ['speak freely', 'talk freely'];

/** Whole-utterance phrases that switch Pipali back to chiming for a go-ahead. */
export const ASK_FIRST_PHRASES = ['ask first', 'ask before speaking', 'ask to speak'];

/** Tail-position phrases that submit the current turn. */
export const END_PHRASES = ['over to you', 'send it'];

/** Tail-position phrases that clear the transcript but keep listening (rephrase). */
export const DISCARD_PHRASES = ['scratch that', 'clear that'];

/** Tail-position phrases that abandon the turn and stop listening. */
export const CANCEL_PHRASES = ['stop listening', 'cancel that'];

/**
 * Whole-utterance phrases that stop what Pipali is doing — the run in flight,
 * or a readout the user has heard enough of. Distinct from CANCEL_PHRASES
 * (which end the user's own turn) and from stopping the voice session.
 */
export const STOP_WORK_PHRASES = [
    'stop', 'stop that', 'stop it', 'stop working', 'hold on', 'wait', 'hang on',
    'abort', 'cancel', 'cancel that', 'never mind', 'nevermind', 'thats enough', 'enough',
];

/** Max text length accepted by /api/voice/summarize (keep in sync with the server schema). */
export const SUMMARIZE_TEXT_CAP = 50_000;

/** The addressing word that marks open-context speech as meant for Pipali. */
export const ADDRESS_NAME = 'pipali';

/** Lead-in words allowed before the addressing word ("hey Pipali", "ok Pipali"). */
export const ADDRESS_LEAD_INS = ['hey', 'ok', 'okay', 'hi'];

/**
 * STT prompt to prime the decoder with context, proper nouns and command phrases
 * to make them transcribe reliably for the given context.
 */
export const STT_BIAS_PROMPT =
    `A voice message snippet by the user to Pipali, an AI co-worker on their computer. Key Phrases: Pipali, Hey Pipali, ${[...END_PHRASES, ...DISCARD_PHRASES, ...CANCEL_PHRASES, ...STOP_WORK_PHRASES, ...SPEAK_FREELY_PHRASES, ...ASK_FIRST_PHRASES].join(', ')}, go ahead.`;
