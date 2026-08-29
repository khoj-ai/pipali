import { afterAll, expect, test } from 'bun:test';
import type { PcmStream } from '../../src/client/utils/notifications';

const originalAudioContext = globalThis.AudioContext;

/** Every buffer handed to the speaker, in scheduling order. */
interface Scheduled { start: number; duration: number; rate: number }
const scheduled: Scheduled[] = [];
let ctx: FakeAudioContext | null = null;

class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    sampleRate = 48_000;
    destination = {};

    constructor() {
        ctx = this;
    }

    createGain() {
        return {
            connect: () => {},
            gain: {
                cancelScheduledValues: () => {},
                setTargetAtTime: () => {},
            },
        };
    }

    createBuffer(_channels: number, length: number, sampleRate: number) {
        return { length, sampleRate, duration: length / sampleRate, copyToChannel: () => {} };
    }

    createBufferSource() {
        const node = {
            buffer: null as { duration: number; sampleRate: number } | null,
            onended: null,
            connect: () => {},
            stop: () => {},
            start: (when: number) => scheduled.push({
                start: when, duration: node.buffer!.duration, rate: node.buffer!.sampleRate,
            }),
        };
        return node;
    }

    resume() {
        return Promise.resolve();
    }
}

globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;

afterAll(() => {
    globalThis.AudioContext = originalAudioContext;
});

const RATE = 24_000;
/** An HTTP chunk off a phone link carries roughly this much speech. */
const CHUNK_SAMPLES = 700;

/**
 * Play blocks that become available after the given wall-clock delays, then
 * report the silence the speaker would hear between consecutive buffers.
 */
async function playWithArrivals(delaysMs: number[]): Promise<number[]> {
    const { speakPcm, stopSpeaking } = await import('../../src/client/utils/notifications');
    stopSpeaking();
    scheduled.length = 0;
    if (ctx) ctx.currentTime = 1;

    const stream: PcmStream = {
        sampleRate: RATE,
        async *blocks() {
            for (const delay of delaysMs) {
                ctx!.currentTime += delay / 1000;
                yield new Float32Array(CHUNK_SAMPLES);
                await Promise.resolve();
            }
        },
    };
    void speakPcm(stream);
    // Drain the background consumer; it awaits once per block.
    for (let i = 0; i < delaysMs.length * 20 + 100; i++) await Promise.resolve();

    return scheduled.slice(1).map((s, i) => {
        const previous = scheduled[i]!;
        return s.start - (previous.start + previous.duration);
    });
}

/** Deterministic zero-mean jitter around realtime arrival, in ms. */
function jitteredArrivals(count: number, swingMs: number): number[] {
    const blockMs = (CHUNK_SAMPLES / RATE) * 1000;
    return Array.from({ length: count }, (_, i) => blockMs + Math.sin(i * 2.399) * swingMs);
}

test('stopping speech drops readouts already waiting in the playback queue', async () => {
    const { speakPcm, stopSpeaking } = await import('../../src/client/utils/notifications');
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
    let queuedStreamStarted = false;

    const active: PcmStream = {
        sampleRate: 24_000,
        async *blocks() {
            await activeGate;
        },
    };
    const queued: PcmStream = {
        sampleRate: 24_000,
        async *blocks() {
            queuedStreamStarted = true;
        },
    };

    const activePlayback = speakPcm(active);
    await Promise.resolve();
    const queuedPlayback = speakPcm(queued);
    stopSpeaking();
    releaseActive();

    await Promise.all([activePlayback, queuedPlayback]);
    expect(queuedStreamStarted).toBe(false);
});

test('network jitter does not splice silence into a readout', async () => {
    // Blocks arrive around realtime, each a few ms early or late — an ordinary
    // phone link. Playing them as they land would break the speech at every
    // boundary; the schedule's lead is what absorbs the jitter instead.
    const gaps = await playWithArrivals(jitteredArrivals(60, 12));

    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((gap) => gap <= 1e-9)).toBe(true);
});

test('a stall breaks speech once, then playback rebuilds its lead', async () => {
    const arrivals = jitteredArrivals(60, 12);
    arrivals[30] = arrivals[30]! + 500;    // the link drops out mid-readout

    const gaps = await playWithArrivals(arrivals);
    const breaks = gaps.filter((gap) => gap > 1e-9);

    // The missing half-second is audible — it has to be, the audio did not
    // exist yet — but it stays a single pause instead of degrading everything
    // after it into a gap per block.
    expect(breaks.length).toBe(1);
    expect(breaks[0]).toBeGreaterThan(0.3);
});

test('speech is handed to the speaker at the context\'s own rate', async () => {
    // Left at its own 24kHz the browser converts each buffer by interpolating
    // between neighbouring samples, which mirrors every partial of the voice
    // around 12kHz. Converting first is what keeps that resampler out of the
    // path — see the StreamResampler tests for what the mirror sounds like.
    await playWithArrivals(jitteredArrivals(20, 0));

    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((s) => s.rate === ctx!.sampleRate)).toBe(true);
});

test('resampling preserves the length of a readout', async () => {
    // Speech that came out longer or shorter than it went in would drift
    // against the schedule and eventually tear.
    const count = 40;
    await playWithArrivals(jitteredArrivals(count, 0));

    const played = scheduled.reduce((total, s) => total + s.duration, 0);
    expect(played).toBeCloseTo((count * CHUNK_SAMPLES) / RATE, 3);
});
