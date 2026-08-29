import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ensureAudioContext, currentAudioContext, realignAudioContext } from '../../src/client/utils/audio-context';
import { PCM_TAP_WORKLET, SegmentedCapture } from '../../src/client/utils/voice/voice-capture';
import { VOICE_TUNABLES } from '../../src/client/utils/voice/voice-config';

// ---------------------------------------------------------------------------
// The shared AudioContext both playback and capture run on
// ---------------------------------------------------------------------------

/** What the next `new AudioContext()` should behave like. */
let deviceRate = 48_000;
let resumeFails = false;
let modulesAdded = 0;
let workletOptions: { processorOptions?: { frameSamples?: number } } | undefined;

class FakeAudioContext {
    readonly sampleRate: number;
    readonly options: AudioContextOptions | undefined;
    state = 'suspended';
    baseLatency = 0.02;
    outputLatency = 0.04;
    closed = false;
    destination = {};
    audioWorklet = { addModule: async () => { modulesAdded++; } };

    constructor(options?: AudioContextOptions) {
        this.options = options;
        this.sampleRate = deviceRate;
    }

    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
    resume() {
        if (resumeFails) return Promise.reject(new Error('not allowed'));
        this.state = 'running';
        return Promise.resolve();
    }
    close() { this.closed = true; return Promise.resolve(); }
}

class FakeWorkletNode {
    port: { onmessage: unknown; postMessage: () => void } = { onmessage: null, postMessage: () => {} };
    constructor(_ctx: unknown, _name: string, options?: typeof workletOptions) { workletOptions = options; }
    connect() {}
    disconnect() {}
}

const originals = {
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    mediaDevices: globalThis.navigator?.mediaDevices,
    createObjectURL: globalThis.URL.createObjectURL,
    revokeObjectURL: globalThis.URL.revokeObjectURL,
};

beforeAll(async () => {
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeWorkletNode as unknown as typeof AudioWorkletNode;
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia: async () => ({
                getAudioTracks: () => [{ getSettings: () => ({}) }],
                getTracks: () => [{ stop: () => {} }],
            }),
        },
    });
    globalThis.URL.createObjectURL = () => 'blob:tap';
    globalThis.URL.revokeObjectURL = () => {};
    // Take over whatever context another suite left behind: the module only
    // rebuilds when the device moves, so move it.
    deviceRate = 32_000;
    await realignAudioContext();
    deviceRate = 48_000;
    await realignAudioContext();
});

afterAll(() => {
    globalThis.AudioContext = originals.AudioContext;
    globalThis.AudioWorkletNode = originals.AudioWorkletNode;
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: originals.mediaDevices });
    globalThis.URL.createObjectURL = originals.createObjectURL;
    globalThis.URL.revokeObjectURL = originals.revokeObjectURL;
});

const live = () => currentAudioContext() as unknown as FakeAudioContext;

test('the shared context asks for the deepest device buffer', () => {
    const ctx = live();
    expect(ctx.options?.latencyHint).toBe('playback');
    expect(ctx.state).toBe('running');
    expect(ensureAudioContext()).toBe(ctx as unknown as AudioContext);
});

test('realigning against an unchanged device keeps the context', async () => {
    const before = currentAudioContext();
    expect(await realignAudioContext()).toBe(before);
});

test('a device that has moved gets a context built against it', async () => {
    const stale = live();
    deviceRate = 16_000;
    const fresh = await realignAudioContext() as unknown as FakeAudioContext;
    expect(fresh).not.toBe(stale);
    expect(fresh.sampleRate).toBe(16_000);
    expect(fresh.state).toBe('running');
    expect(stale.closed).toBe(true);
});

test('a replacement that will not start leaves the working context in place', async () => {
    const working = currentAudioContext();
    deviceRate = 44_100;
    resumeFails = true;
    expect(await realignAudioContext()).toBe(working);
    expect((working as unknown as FakeAudioContext).closed).toBe(false);
    resumeFails = false;
});

// ---------------------------------------------------------------------------
// The microphone tap, run the way the audio thread runs it
// ---------------------------------------------------------------------------

interface TapProcessor { process(inputs: Float32Array[][]): boolean }

/** Evaluate the real worklet source against a stub of the worklet global scope. */
function loadTap(frameSamples: number): { tap: TapProcessor; posted: Float32Array[] } {
    const posted: Float32Array[] = [];
    const port = { postMessage: (frame: Float32Array) => { posted.push(frame); } };
    class StubProcessor { port = port }
    let Registered: new (options: { processorOptions: { frameSamples: number } }) => TapProcessor;
    const register = (_name: string, ctor: typeof Registered) => { Registered = ctor; };
    new Function('AudioWorkletProcessor', 'registerProcessor', PCM_TAP_WORKLET)(StubProcessor, register);
    return { tap: new Registered!({ processorOptions: { frameSamples } }), posted };
}

const QUANTUM = 128;

test('the tap hands over whole analysis frames, not render quanta', () => {
    const frameSamples = Math.round((48_000 * VOICE_TUNABLES.analysisFrameMs) / 1000);
    const { tap, posted } = loadTap(frameSamples);

    // A second of audio, distinct per sample so any loss or reordering shows.
    const source = new Float32Array(48_000);
    for (let i = 0; i < source.length; i++) source[i] = i / source.length;
    const quanta = Math.floor(source.length / QUANTUM);
    for (let at = 0; at + QUANTUM <= source.length; at += QUANTUM) {
        tap.process([[source.subarray(at, at + QUANTUM)]]);
    }

    expect(posted.length).toBe(Math.floor((quanta * QUANTUM) / frameSamples));
    // 33 hand-overs a second where a per-quantum tap made 375, on the same
    // thread that renders speech. Held as a ratio so the bound survives a
    // change of frame length.
    expect(quanta / posted.length).toBeGreaterThan(10);

    for (const frame of posted) expect(frame.length).toBe(frameSamples);
    const flat = new Float32Array(posted.length * frameSamples);
    posted.forEach((frame, i) => flat.set(frame, i * frameSamples));
    expect(Array.from(flat)).toEqual(Array.from(source.subarray(0, flat.length)));
});

test('the tap keeps frames whole across quanta that straddle them', () => {
    // 100 samples never divides a 128-sample quantum evenly.
    const { tap, posted } = loadTap(100);
    const source = new Float32Array(QUANTUM * 8);
    for (let i = 0; i < source.length; i++) source[i] = i + 1;
    for (let at = 0; at < source.length; at += QUANTUM) tap.process([[source.subarray(at, at + QUANTUM)]]);

    expect(posted.length).toBe(Math.floor(source.length / 100));
    const flat = new Float32Array(posted.length * 100);
    posted.forEach((frame, i) => flat.set(frame, i * 100));
    expect(Array.from(flat)).toEqual(Array.from(source.subarray(0, flat.length)));
});

test('the tap waits for an input to be connected', () => {
    const { tap, posted } = loadTap(QUANTUM);
    expect(tap.process([[]])).toBe(true);
    expect(posted).toHaveLength(0);
    tap.process([[new Float32Array(QUANTUM)]]);
    expect(posted).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// A capture session's use of the context
// ---------------------------------------------------------------------------

test('capture runs on the shared context and leaves it open for playback', async () => {
    deviceRate = 48_000;
    const capture = new SegmentedCapture({ onSegment: () => {} });
    await capture.start();

    const shared = live();
    expect(workletOptions?.processorOptions?.frameSamples)
        .toBe(Math.round((shared.sampleRate * VOICE_TUNABLES.analysisFrameMs) / 1000));

    const registeredOnce = modulesAdded;
    capture.stop();
    expect(shared.closed).toBe(false);

    // A second session reuses the context, on which a processor name may only
    // be registered once.
    const again = new SegmentedCapture({ onSegment: () => {} });
    await again.start();
    expect(currentAudioContext()).toBe(shared as unknown as AudioContext);
    expect(modulesAdded).toBe(registeredOnce);
    again.stop();
});
