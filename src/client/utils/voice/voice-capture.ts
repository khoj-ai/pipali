/**
 * Continuous microphone capture for segmented hands-free turns.
 *
 * AudioWorklet taps raw PCM off the mic stream; frames feed the pure
 * SpeechSegmenter, and each closed segment is downsampled to the STT rate and
 * WAV-encoded. AudioWorklet (not MediaRecorder) because segments need pre-roll
 * spliced from a ring buffer and mid-stream MediaRecorder chunks lack container
 * headers; WKWebView supports worklets (Safari 14.1+).
 *
 * Capture keeps running while Pipali speaks (full duplex). The platform's own
 * echo cancellation is what makes that possible — measured on macOS, it drops
 * Pipali's voice at the mic to well under the voiced threshold. `setSpeaking`
 * tells the segmenter when a readout is on so it can raise that threshold for
 * the residual, and mark the segments that caught any of it.
 *
 * Capture shares the app's one AudioContext rather than opening a second, so a
 * phone holding the microphone open is driving a single output stream.
 */

import { VOICE_TUNABLES } from './voice-config';
import { SpeechSegmenter, EnergyVad, defaultSegmenterConfig } from './voice-segmenter';
import { downsample, encodeWavPcm16 } from './voice-pcm';
import { realignAudioContext } from '../audio-context';

// Inlined worklet processor, loaded via Blob URL so no bundler asset plumbing
// is needed. It gathers whole analysis frames before handing them over: this
// runs on the audio thread that also renders speech, and posting every
// 128-sample render quantum meant allocating and crossing threads a few
// hundred times a second there for frames the segmenter cannot use singly.
export const PCM_TAP_WORKLET = `
class PipaliPcmTap extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.size = options.processorOptions.frameSamples;
        this.frame = new Float32Array(this.size);
        this.fill = 0;
    }
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;
        let offset = 0;
        while (offset < channel.length) {
            const take = Math.min(channel.length - offset, this.size - this.fill);
            this.frame.set(channel.subarray(offset, offset + take), this.fill);
            this.fill += take;
            offset += take;
            if (this.fill === this.size) {
                const full = this.frame;
                this.frame = new Float32Array(this.size);
                this.fill = 0;
                this.port.postMessage(full, [full.buffer]);
            }
        }
        return true;
    }
}
registerProcessor('pipali-pcm-tap', PipaliPcmTap);
`;

// A processor name can only be registered once per context, and the context
// outlives any one session.
const workletRegistered = new WeakSet<BaseAudioContext>();

export interface CapturedSegment {
    /** WAV-encoded audio at the STT sample rate. */
    wav: Blob;
    seq: number;
    /**
     * Audio that caught Pipali's own voice, which stays true after playback
     * has ended — see SegmenterEvent.
     */
    overlappedPlayback: boolean;
    /**
     * Clip length, pre-roll and trailing silence included — the ceiling on how
     * much speech the transcript can honestly claim was in it.
     */
    durationMs: number;
}

export interface SegmentedCaptureHandlers {
    /** A speech segment closed. */
    onSegment: (segment: CapturedSegment) => void;
    onSpeechStart?: () => void;
    /** Onset was a blip — nothing to transcribe, so anything onset triggered can unwind. */
    onSpeechRejected?: () => void;
}

export class SegmentedCapture {
    private stream?: MediaStream;
    private ctx?: AudioContext;
    private source?: MediaStreamAudioSourceNode;
    private node?: AudioWorkletNode;
    private sink?: GainNode;
    private segmenter?: SpeechSegmenter;
    private seq = 0;
    private stopped = false;

    constructor(private readonly handlers: SegmentedCaptureHandlers) {}

    async start(): Promise<void> {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
        });
        // The constraint is advisory, and full duplex leans on it being honoured
        // — so log what the engine actually applied, not what we asked for.
        const settings = this.stream.getAudioTracks()[0]?.getSettings();
        console.info('[voice] capture:', {
            echoCancellation: settings?.echoCancellation ?? 'unreported',
            noiseSuppression: settings?.noiseSuppression ?? 'unreported',
        });
        // Only now that the microphone is open does the output route settle, so
        // this is where the shared context is squared with the actual device.
        const ctx = await realignAudioContext();
        if (!ctx) throw new Error('Audio output unavailable');
        this.ctx = ctx;
        if (ctx.state === 'suspended') await ctx.resume();

        if (!workletRegistered.has(ctx)) {
            const workletUrl = URL.createObjectURL(new Blob([PCM_TAP_WORKLET], { type: 'application/javascript' }));
            try {
                await ctx.audioWorklet.addModule(workletUrl);
                workletRegistered.add(ctx);
            } finally {
                URL.revokeObjectURL(workletUrl);
            }
        }

        const config = defaultSegmenterConfig(ctx.sampleRate);
        this.segmenter = new SpeechSegmenter(config, new EnergyVad());

        this.source = ctx.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(ctx, 'pipali-pcm-tap', {
            processorOptions: { frameSamples: config.frameSamples },
        });
        this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.ingest(e.data);
        this.source.connect(this.node);
        // Some engines only run worklets connected toward the destination;
        // a zero-gain sink keeps the graph alive without mic→speaker feedback.
        this.sink = ctx.createGain();
        this.sink.gain.value = 0;
        this.node.connect(this.sink);
        this.sink.connect(ctx.destination);
    }

    /** A readout is on: raise the voiced bar, and mark segments that catch it. */
    setSpeaking(speaking: boolean): void {
        this.segmenter?.setSpeaking(speaking);
    }

    /** Force-close any open segment (tap-to-end). */
    flush(): void {
        if (!this.segmenter) return;
        for (const event of this.segmenter.flush()) this.handleEvent(event);
    }

    stop(): void {
        this.stopped = true;
        if (this.node) this.node.port.onmessage = null;
        try { this.source?.disconnect(); } catch { /* already disconnected */ }
        try { this.node?.disconnect(); } catch { /* already disconnected */ }
        try { this.sink?.disconnect(); } catch { /* already disconnected */ }
        this.stream?.getTracks().forEach((t) => t.stop());
        // The context is shared with playback and outlives the session.
        this.stream = undefined;
        this.ctx = undefined;
        this.segmenter = undefined;
    }

    /** One whole analysis frame, gathered by the worklet. */
    private ingest(frame: Float32Array): void {
        if (this.stopped || !this.segmenter) return;
        for (const event of this.segmenter.pushFrame(frame)) this.handleEvent(event);
    }

    private handleEvent(event: ReturnType<SpeechSegmenter['pushFrame']>[number]): void {
        if (event.type === 'speech_start') {
            this.handlers.onSpeechStart?.();
        } else if (event.type === 'segment') {
            const rate = this.ctx?.sampleRate ?? VOICE_TUNABLES.sttSampleRate;
            const outRate = Math.min(rate, VOICE_TUNABLES.sttSampleRate);
            const ds = downsample(event.samples, rate, outRate);
            const wav = encodeWavPcm16(ds, outRate);
            this.handlers.onSegment({
                wav: new Blob([wav], { type: 'audio/wav' }),
                seq: this.seq++,
                overlappedPlayback: event.overlappedPlayback,
                durationMs: (ds.length / outRate) * 1000,
            });
        } else {
            this.handlers.onSpeechRejected?.();   // blip: no audio to transcribe
        }
    }
}
