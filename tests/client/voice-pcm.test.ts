import { test, expect, describe } from 'bun:test';
import { encodeWavPcm16, WavStreamParser, PcmBlockBuffer } from '../../src/client/utils/voice/voice-pcm';

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
