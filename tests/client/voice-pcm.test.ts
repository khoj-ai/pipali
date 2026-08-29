import { test, expect, describe } from 'bun:test';
import { encodeWavPcm16, WavStreamParser, PcmBlockBuffer, StreamResampler } from '../../src/client/utils/voice/voice-pcm';

describe('WavStreamParser', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25, -0.25, 0.125]);

    /** Feed bytes in fixed-size slices to exercise arbitrary chunk boundaries. */
    function parseInChunks(parser: WavStreamParser, bytes: Uint8Array, chunkSize: number): number[] {
        const out: number[] = [];
        for (let i = 0; i < bytes.length; i += chunkSize) {
            out.push(...parser.push(bytes.subarray(i, i + chunkSize)));
        }
        return out;
    }

    test('round-trips this module\'s own WAV encoding, split at awkward boundaries', () => {
        const wav = encodeWavPcm16(samples, 24000);
        // 7 bytes divides neither the 44-byte header nor the 2-byte frames, so
        // every carry path runs: partial header, split samples, odd remainders.
        const parser = new WavStreamParser();
        const decoded = parseInChunks(parser, wav, 7);

        expect(parser.info).toEqual({ sampleRate: 24000, channels: 1 });
        expect(decoded).toHaveLength(samples.length);
        for (let i = 0; i < samples.length; i++) {
            expect(decoded[i]!).toBeCloseTo(samples[i]!, 3); // 16-bit quantization tolerance
        }
    });

    test('decodes past the header\'s declared data size (progressive WAV)', () => {
        // A streamed WAV's header only knows the first chunk's length; bytes
        // beyond it are still samples and must not be dropped.
        const declared = encodeWavPcm16(new Float32Array([0.5]), 24000);
        const extra = new Uint8Array(new Int16Array([0x4000, -0x4000]).buffer);
        const parser = new WavStreamParser();
        const decoded = [...parser.push(declared), ...parser.push(extra)];
        expect(decoded).toHaveLength(3);
        expect(decoded[1]!).toBeCloseTo(0.5, 3);
        expect(decoded[2]!).toBeCloseTo(-0.5, 3);
    });

    test('averages stereo frames down to mono', () => {
        const wav = encodeWavPcm16(new Float32Array(0), 24000);
        wav[22] = 2; // channels
        const stereo = new Uint8Array(new Int16Array([0x2000, 0x6000, -0x4000, 0x4000]).buffer);
        const parser = new WavStreamParser();
        parser.push(wav);
        const decoded = parser.push(stereo);
        expect(decoded).toHaveLength(2);
        expect(decoded[0]!).toBeCloseTo(0.5, 3);  // (0.25 + 0.75) / 2
        expect(decoded[1]!).toBeCloseTo(0, 3);    // (-0.5 + 0.5) / 2
    });

    test('rejects a non-WAV stream instead of playing it as noise', () => {
        const parser = new WavStreamParser();
        expect(() => parser.push(new TextEncoder().encode('{"error":"nope"} padding'))).toThrow('Not a WAV stream');
    });
});

describe('PcmBlockBuffer', () => {
    test('first settles when audio starts flowing', async () => {
        const buffer = new PcmBlockBuffer();
        buffer.push(new Float32Array([1]));
        await expect(buffer.first).resolves.toBeUndefined();
    });

    test('yields blocks buffered before playback, then live ones, then ends', async () => {
        const buffer = new PcmBlockBuffer();
        buffer.push(new Float32Array([1]));

        const seen: number[] = [];
        const playback = (async () => {
            for await (const block of buffer.blocks()) seen.push(block[0]!);
        })();

        buffer.push(new Float32Array([2]));
        buffer.end();
        await playback;
        expect(seen).toEqual([1, 2]);
    });

    test('failure rejects first and surfaces through iteration', async () => {
        const buffer = new PcmBlockBuffer();
        const boom = new Error('synthesis failed');
        buffer.fail(boom);
        await expect(buffer.first).rejects.toBe(boom);
        await expect((async () => {
            for await (const _ of buffer.blocks()) { /* never */ }
        })()).rejects.toBe(boom);
    });

    test('an empty stream resolves first and ends playback immediately', async () => {
        const buffer = new PcmBlockBuffer();
        buffer.end();
        await expect(buffer.first).resolves.toBeUndefined();
        const seen: unknown[] = [];
        for await (const block of buffer.blocks()) seen.push(block);
        expect(seen).toEqual([]);
    });
});

describe('StreamResampler', () => {
    /** A tone at `freq`, sampled at `rate`. */
    function tone(freq: number, rate: number, seconds: number): Float32Array {
        const out = new Float32Array(Math.round(rate * seconds));
        for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / rate);
        return out;
    }

    /** Level at `freq` in dB relative to a full-amplitude tone, Hann-windowed. */
    function levelAt(samples: Float32Array, rate: number, freq: number): number {
        const from = Math.round(rate * 0.1);
        const n = Math.round(rate * 0.5);
        let re = 0, im = 0;
        for (let i = 0; i < n; i++) {
            const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
            const angle = -2 * Math.PI * freq * i / rate;
            re += (samples[from + i] ?? 0) * window * Math.cos(angle);
            im += (samples[from + i] ?? 0) * window * Math.sin(angle);
        }
        return 20 * Math.log10(Math.hypot(re, im) / n / (0.5 / 4) + 1e-30);
    }

    function resampleAll(from: number, to: number, input: Float32Array, blockSize?: number): Float32Array {
        const resampler = new StreamResampler(from, to);
        const out: number[] = [];
        const step = blockSize ?? input.length;
        for (let at = 0; at < input.length; at += step) out.push(...resampler.push(input.subarray(at, at + step)));
        out.push(...resampler.flush());
        return Float32Array.from(out);
    }

    test('upsampling leaves no mirror image of the signal to be heard', () => {
        // A browser asked to play a 24kHz buffer in a 48kHz context interpolates
        // between neighbouring samples, which mirrors every partial around the
        // input's Nyquist. For 7.31kHz that lands a copy at 16.69kHz only ~13dB
        // under the voice — the hiss and tonal artifacts this resampler exists
        // to avoid. Band-limited, the same image is inaudible.
        const played = resampleAll(24_000, 48_000, tone(7310, 24_000, 1));

        expect(levelAt(played, 48_000, 7310)).toBeGreaterThan(-1);
        expect(levelAt(played, 48_000, 24_000 - 7310)).toBeLessThan(-60);
    });

    test('downsampling filters out what the output rate cannot carry', () => {
        // A device on a narrowband route hands back a context below the speech's
        // own rate. Interpolating there folds everything above the new Nyquist
        // back into the middle of the speech band instead of dropping it.
        const played = resampleAll(24_000, 16_000, tone(9600, 24_000, 1));

        expect(levelAt(played, 16_000, 16_000 - 9600)).toBeLessThan(-60);
    });

    test('a stream resampled in blocks is identical to one resampled whole', () => {
        // Blocks arrive one network chunk at a time. Converting each alone would
        // seam at every boundary; the resampler carries its history across them.
        const input = tone(3000, 24_000, 0.5);
        const whole = resampleAll(24_000, 48_000, input);
        const blocked = resampleAll(24_000, 48_000, input, 700);

        expect(blocked.length).toBe(whole.length);
        for (let i = 0; i < whole.length; i++) expect(blocked[i]!).toBeCloseTo(whole[i]!, 6);
    });

    test('output length tracks the rate ratio, so playback does not drift', () => {
        for (const rate of [48_000, 44_100, 16_000]) {
            const played = resampleAll(24_000, rate, tone(1000, 24_000, 1));
            // The flush tail rounds up by at most one sample.
            expect(Math.abs(played.length - rate)).toBeLessThanOrEqual(1);
        }
    });
});
