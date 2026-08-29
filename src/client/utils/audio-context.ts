/**
 * The one AudioContext the app plays and captures through.
 *
 * Each AudioContext costs an output stream and a render thread of its own, and
 * voice mode used to run two: one for speech and cues, and a second the capture
 * graph opened for itself. One is enough for both, and a phone holding the
 * microphone open has the least headroom to spare for the other.
 *
 * The context asks for the `playback` latency category — the deepest device
 * buffer the engine will hand out, which is the headroom that keeps a late
 * render from reaching the speaker as a click. Nothing here wants low latency:
 * speech is scheduled a fifth of a second ahead, and cues are feedback rather
 * than timing.
 */

let shared: AudioContext | null = null;

/** Lazily create (and resume) the shared AudioContext. */
export function ensureAudioContext(): AudioContext | null {
    try {
        if (!shared) shared = new AudioContext({ latencyHint: 'playback' });
        if (shared.state === 'suspended') void shared.resume();
        return shared;
    } catch {
        return null;
    }
}

/** The context if one has been created, without creating one. */
export function currentAudioContext(): AudioContext | null {
    return shared;
}

/** Let go of a context we are not going to play through. */
function discard(ctx: AudioContext | null): void {
    try { void ctx?.close(); } catch { /* already gone */ }
}

/**
 * The rate the output device would be opened at right now. A context reports
 * the rate it was *built* against and keeps it for life, so a throwaway one is
 * the only way to notice that the device underneath has changed.
 */
function probeDeviceRate(): number | null {
    let probe: AudioContext | null = null;
    try {
        probe = new AudioContext({ latencyHint: 'playback' });
        return probe.sampleRate;
    } catch {
        return null;
    } finally {
        discard(probe);
    }
}

/**
 * Point the shared context at the output device that is actually in force, and
 * report what that device is.
 *
 * Opening the microphone can move the whole session onto a different output
 * route — a phone puts voice-communication capture and playback together — and
 * a context built before that switch goes on rendering for a device that is no
 * longer there. Call once the microphone is open, before anything is spoken.
 */
export async function realignAudioContext(): Promise<AudioContext | null> {
    const live = ensureAudioContext();
    if (!live) return null;
    const deviceRate = probeDeviceRate();
    console.info('[voice] output:', {
        contextRate: live.sampleRate,
        deviceRate: deviceRate ?? 'unreported',
        baseLatencyMs: Math.round((live.baseLatency ?? 0) * 1000),
        outputLatencyMs: Math.round((live.outputLatency ?? 0) * 1000),
    });
    if (!deviceRate || deviceRate === live.sampleRate) return live;

    // The route moved. Build against the new device, and keep the old context
    // until the new one is definitely playing — a replacement that cannot
    // start is worse than a context built for the wrong rate.
    let next: AudioContext | null = null;
    try {
        next = new AudioContext({ latencyHint: 'playback' });
        await next.resume();
        if (next.state !== 'running') throw new Error('replacement did not start');
    } catch {
        discard(next);
        return live;
    }
    shared = next;
    console.info(`[voice] output moved from ${live.sampleRate}Hz to ${next.sampleRate}Hz`);
    discard(live);
    return next;
}
