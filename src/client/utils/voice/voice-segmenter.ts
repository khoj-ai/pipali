/**
 * Speech segmentation over PCM frames for the hands-free turn model.
 *
 * A pause closes a *segment*, never the turn — segments stream to STT while the
 * user keeps thinking. The segmenter keeps a pre-roll ring of recent frames so
 * a segment includes audio from just before detected onset (the first word is
 * where the address lives), and applies hysteresis + a minimum voiced duration
 * so keyboard clatter doesn't produce segments.
 *
 * While Pipali is speaking the voiced threshold is raised, so its own residual
 * echo does not open a segment. Closed segments are stamped with whether they
 * caught any of that speech, since the transcript-level self-echo check needs to
 * know and cannot ask afterwards — a segment closes ~900ms after the voice in it
 * stops, by which time playback has usually ended.
 *
 * Pure: frames in, events out. No audio APIs — unit-tested with synthetic PCM.
 * The VAD is pluggable so the energy heuristic can be swapped for a model
 * (e.g. Silero via onnxruntime-web) without touching the state machine.
 */

import { VOICE_TUNABLES } from './voice-config';

export interface VadEngine {
    /** `overSpeech` raises the bar: Pipali is audible, so quiet energy is likely its echo. */
    isVoiced(frame: Float32Array, overSpeech?: boolean): boolean;
}

function rms(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
    return Math.sqrt(sum / (frame.length || 1));
}

export class EnergyVad implements VadEngine {
    constructor(
        private readonly threshold: number = VOICE_TUNABLES.energyThreshold,
        private readonly speakingThreshold: number = VOICE_TUNABLES.speakingEnergyThreshold,
    ) {}

    isVoiced(frame: Float32Array, overSpeech = false): boolean {
        return rms(frame) >= (overSpeech ? this.speakingThreshold : this.threshold);
    }
}

export interface SegmenterConfig {
    sampleRate: number;
    frameSamples: number;
    preRollMs: number;
    /** Voiced frames within the onset window required to open a segment. */
    speechStartFrames: number;
    /** Onset window size — majority voting tolerates consonant dips. */
    speechStartWindow: number;
    silenceEndMs: number;
    minSpeechMs: number;
    maxSegmentMs: number;
}

export type SegmenterEvent =
    | { type: 'speech_start' }
    /**
     * `overlappedPlayback` marks audio captured while Pipali was sounding. A
     * segment closes ~900ms after the voice in it stops, so one that caught the
     * tail of a readout arrives well after playback ended — by then "is Pipali
     * speaking?" reads false, and the echo check would be skipped exactly when
     * it is needed. The flag travels with the audio instead.
     */
    | { type: 'segment'; samples: Float32Array; overlappedPlayback: boolean }
    | { type: 'segment_rejected'; reason: 'too_short' };

export function defaultSegmenterConfig(sampleRate: number): SegmenterConfig {
    return {
        sampleRate,
        frameSamples: Math.round((sampleRate * VOICE_TUNABLES.analysisFrameMs) / 1000),
        preRollMs: VOICE_TUNABLES.preRollMs,
        speechStartFrames: VOICE_TUNABLES.speechStartFrames,
        speechStartWindow: VOICE_TUNABLES.speechStartWindow,
        silenceEndMs: VOICE_TUNABLES.silenceEndMs,
        minSpeechMs: VOICE_TUNABLES.minSpeechMs,
        maxSegmentMs: VOICE_TUNABLES.maxSegmentMs,
    };
}

export class SpeechSegmenter {
    private readonly frameMs: number;
    private readonly maxPreRollFrames: number;
    private readonly silenceEndFrames: number;
    private readonly minSpeechFrames: number;
    private readonly maxSegmentFrames: number;

    private preRoll: Float32Array[] = [];
    private collecting = false;
    private collected: Float32Array[] = [];
    private recentVoiced: boolean[] = [];
    private silenceRun = 0;
    private voicedFrames = 0;
    private speaking = false;
    private framesSinceSpeech = Number.MAX_SAFE_INTEGER;

    constructor(private readonly config: SegmenterConfig, private readonly vad: VadEngine) {
        this.frameMs = (config.frameSamples / config.sampleRate) * 1000;
        this.maxPreRollFrames = Math.max(1, Math.ceil(config.preRollMs / this.frameMs));
        this.silenceEndFrames = Math.max(1, Math.ceil(config.silenceEndMs / this.frameMs));
        this.minSpeechFrames = Math.max(1, Math.ceil(config.minSpeechMs / this.frameMs));
        this.maxSegmentFrames = Math.max(1, Math.ceil(config.maxSegmentMs / this.frameMs));
    }

    /** Told by the caller, which knows when a readout starts and ends. */
    setSpeaking(speaking: boolean): void {
        this.speaking = speaking;
    }

    /** Keeps `frame` rather than copying it, so the caller must not reuse the buffer. */
    pushFrame(frame: Float32Array): SegmenterEvent[] {
        this.framesSinceSpeech = this.speaking ? 0 : this.framesSinceSpeech + 1;
        const voiced = this.vad.isVoiced(frame, this.speaking);

        if (!this.collecting) {
            this.preRoll.push(frame);
            if (this.preRoll.length > this.maxPreRollFrames) this.preRoll.shift();

            // Majority vote over a sliding window, not strictly consecutive
            // frames: the consonant dips in short commands ("send it") would
            // otherwise reset onset and demand unnaturally loud speech.
            this.recentVoiced.push(voiced);
            if (this.recentVoiced.length > this.config.speechStartWindow) this.recentVoiced.shift();
            const voicedInWindow = this.recentVoiced.filter(Boolean).length;
            if (!voiced || voicedInWindow < this.config.speechStartFrames) return [];

            // Onset confirmed — open a segment seeded with the pre-roll
            // (which already contains the onset-window frames).
            this.collecting = true;
            this.collected = this.preRoll;
            this.preRoll = [];
            this.recentVoiced = [];
            this.voicedFrames = voicedInWindow;
            this.silenceRun = 0;
            return [{ type: 'speech_start' }];
        }

        this.collected.push(frame);
        if (voiced) {
            this.voicedFrames++;
            this.silenceRun = 0;
        } else {
            this.silenceRun++;
        }

        if (this.silenceRun >= this.silenceEndFrames || this.collected.length >= this.maxSegmentFrames) {
            return [this.close()];
        }
        return [];
    }

    /** Force-close any open segment (tap-to-end, teardown). */
    flush(): SegmenterEvent[] {
        if (!this.collecting) return [];
        return [this.close()];
    }

    reset(): void {
        this.preRoll = [];
        this.collected = [];
        this.collecting = false;
        this.recentVoiced = [];
        this.silenceRun = 0;
        this.voicedFrames = 0;
    }

    private close(): SegmenterEvent {
        const frames = this.collected;
        const voicedFrames = this.voicedFrames;
        this.collected = [];
        this.collecting = false;
        this.recentVoiced = [];
        this.silenceRun = 0;
        this.voicedFrames = 0;

        if (voicedFrames < this.minSpeechFrames) {
            return { type: 'segment_rejected', reason: 'too_short' };
        }

        const samples = new Float32Array(frames.length * this.config.frameSamples);
        let offset = 0;
        for (const f of frames) {
            samples.set(f, offset);
            offset += f.length;
        }
        // `frames` spans the pre-roll too, so this asks whether Pipali spoke at
        // any point in the audio being handed over — not whether it is speaking
        // now, which by here it usually is not.
        return { type: 'segment', samples, overlappedPlayback: this.framesSinceSpeech <= frames.length };
    }
}
