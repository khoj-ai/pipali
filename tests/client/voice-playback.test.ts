import { afterAll, expect, test } from 'bun:test';
import type { PcmStream } from '../../src/client/utils/notifications';

const originalAudioContext = globalThis.AudioContext;

class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};

    createGain() {
        return {
            connect: () => {},
            gain: {
                cancelScheduledValues: () => {},
                setTargetAtTime: () => {},
            },
        };
    }

    resume() {
        return Promise.resolve();
    }
}

globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;

afterAll(() => {
    globalThis.AudioContext = originalAudioContext;
});

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
