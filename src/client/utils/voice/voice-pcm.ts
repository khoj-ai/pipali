/**
 * PCM helpers for both voice directions: downsampling and WAV-encoding
 * captured audio for STT, and incrementally decoding streamed WAV audio from
 * TTS for playback. Pure functions and classes — no audio APIs.
 */

/** Averaging decimator: good enough for speech, no ringing, O(n). */
export function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return samples;
    if (fromRate < toRate) throw new Error('downsample cannot upsample');
    const ratio = fromRate / toRate;
    const outLength = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
        let sum = 0;
        for (let j = start; j < end; j++) sum += samples[j]!;
        out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
    const dataLength = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeAscii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeAscii(36, 'data');
    view.setUint32(40, dataLength, true);

    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]!));
        view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }

    return new Uint8Array(buffer);
}

export interface WavStreamInfo {
    sampleRate: number;
    channels: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (!a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

/**
 * Incremental decoder for a progressively streamed 16-bit PCM WAV. Feed byte
 * chunks split at arbitrary boundaries; complete frames come back as mono
 * Float32 samples (multi-channel input is averaged down). The header's
 * declared RIFF/data sizes are ignored — a streamed WAV cannot know its final
 * length — so every byte after the data offset decodes as samples.
 */
export class WavStreamParser {
    info: WavStreamInfo | null = null;
    private pending: Uint8Array = new Uint8Array(0);

    /** Feed raw bytes; returns the newly completed samples (possibly empty). */
    push(bytes: Uint8Array): Float32Array<ArrayBuffer> {
        this.pending = concatBytes(this.pending, bytes);
        if (!this.info && !this.tryParseHeader()) return new Float32Array(0);
        return this.drainSamples();
    }

    private tryParseHeader(): boolean {
        const bytes = this.pending;
        if (bytes.length < 12) return false;
        if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
            throw new Error('Not a WAV stream');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let fmt: WavStreamInfo | null = null;
        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const id = ascii(bytes, offset, 4);
            const size = view.getUint32(offset + 4, true);
            if (id === 'data') {
                if (!fmt) throw new Error('WAV data chunk arrived before fmt');
                this.info = fmt;
                this.pending = bytes.slice(offset + 8);
                return true;
            }
            if (offset + 8 + size > bytes.length) return false; // sub-chunk still incomplete
            if (id === 'fmt ') {
                const format = view.getUint16(offset + 8, true);
                const bits = view.getUint16(offset + 22, true);
                if (format !== 1 || bits !== 16) {
                    throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit)`);
                }
                fmt = {
                    channels: view.getUint16(offset + 10, true),
                    sampleRate: view.getUint32(offset + 12, true),
                };
            }
            offset += 8 + size;
        }
        return false;
    }

    private drainSamples(): Float32Array<ArrayBuffer> {
        const { channels } = this.info!;
        const bytesPerFrame = 2 * channels;
        const frames = Math.floor(this.pending.length / bytesPerFrame);
        if (!frames) return new Float32Array(0);
        const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength);
        const out = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame++) {
            let sum = 0;
            for (let ch = 0; ch < channels; ch++) sum += view.getInt16(frame * bytesPerFrame + ch * 2, true);
            out[frame] = sum / channels / 0x8000;
        }
        this.pending = this.pending.slice(frames * bytesPerFrame);
        return out;
    }
}

/**
 * Bridges a producer pushing decoded sample blocks to a playback consumer:
 * blocks accumulate until read, iteration ends after end() and rethrows the
 * error given to fail(). `first` settles when audio starts flowing (or the
 * stream settles empty/failed), letting callers gate "readout ready" cues.
 * Blocks are retained so playback can attach long after buffering began;
 * only one iterator may be live at a time.
 */
export class PcmBlockBuffer {
    sampleRate = 0;
    readonly first: Promise<void>;
    private received: Float32Array<ArrayBuffer>[] = [];
    private done = false;
    private failure: unknown = null;
    private wake: (() => void) | null = null;
    private settleFirst!: { resolve: () => void; reject: (error: unknown) => void };

    constructor() {
        this.first = new Promise<void>((resolve, reject) => {
            this.settleFirst = { resolve, reject };
        });
    }

    push(block: Float32Array<ArrayBuffer>): void {
        if (this.done) return;
        this.received.push(block);
        this.settleFirst.resolve();
        this.wake?.();
    }

    end(): void {
        if (this.done) return;
        this.done = true;
        this.settleFirst.resolve();
        this.wake?.();
    }

    fail(error: unknown): void {
        if (this.done) return;
        this.done = true;
        this.failure = error;
        this.settleFirst.reject(error);
        this.wake?.();
    }

    async *blocks(): AsyncGenerator<Float32Array<ArrayBuffer>> {
        for (let i = 0; ; ) {
            if (i < this.received.length) {
                yield this.received[i++]!;
                continue;
            }
            if (this.failure) throw this.failure;
            if (this.done) return;
            await new Promise<void>((resolve) => { this.wake = resolve; });
            this.wake = null;
        }
    }
}
