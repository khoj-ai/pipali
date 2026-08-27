/**
 * Client-side voice audio: capture support detection and the network calls to
 * the app's voice routes. Capture itself lives in voice-capture.ts (AudioWorklet);
 * playback lives in notifications.ts so it can share the AudioContext and queue.
 */

import { apiFetch } from '../api';
import { SUMMARIZE_TEXT_CAP } from './voice-config';
import { PcmBlockBuffer, WavStreamParser } from './voice-pcm';

/** Segmented capture needs getUserMedia + AudioWorklet (Safari/WKWebView 14.1+, Chromium, Firefox). */
export function isVoiceCaptureSupported(): boolean {
    return typeof navigator !== 'undefined'
        && !!navigator.mediaDevices?.getUserMedia
        && typeof AudioContext !== 'undefined'
        && typeof AudioWorkletNode !== 'undefined';
}

export interface VoiceRequestError extends Error {
    status: number;
    code?: string;
}

async function toVoiceError(res: Response): Promise<VoiceRequestError> {
    let message = `Voice request failed (${res.status})`;
    let code: string | undefined;
    try {
        const body = await res.json() as { error?: string; code?: string };
        if (body.error) message = body.error;
        code = body.code;
    } catch { /* non-JSON error body */ }
    const err = new Error(message) as VoiceRequestError;
    err.status = res.status;
    err.code = code;
    return err;
}

function extensionForMime(mime: string): string {
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('wav')) return 'wav';
    return 'webm';
}

/** Transcribe a recorded audio blob to text via the app's voice route. */
export async function transcribeAudio(blob: Blob, opts?: { model?: string; language?: string; prompt?: string }): Promise<string> {
    const form = new FormData();
    form.append('file', blob, `utterance.${extensionForMime(blob.type)}`);
    if (opts?.model) form.append('model', opts.model);
    if (opts?.language) form.append('language', opts.language);
    if (opts?.prompt) form.append('prompt', opts.prompt);

    const res = await apiFetch('/api/voice/transcribe', { method: 'POST', body: form });
    if (!res.ok) throw await toVoiceError(res);
    const data = await res.json() as { text?: string };
    return data.text ?? '';
}

/**
 * Summarize text for speech via the app's voice route: 'response' (default)
 * rephrases a final answer, 'action' describes a pending edit/command.
 */
export async function summarizeForSpeech(text: string, opts?: { kind?: 'response' | 'action'; timeoutMs?: number }): Promise<string> {
    const res = await apiFetch('/api/voice/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Slice instead of tripping the server cap — long responses just lose tail.
        body: JSON.stringify({ text: text.slice(0, SUMMARIZE_TEXT_CAP), ...(opts?.kind ? { kind: opts.kind } : {}) }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 12_000),
    });
    if (!res.ok) throw await toVoiceError(res);
    const data = await res.json() as { summary?: string };
    return data.summary ?? '';
}

export interface SpeechHandle {
    /** Settles once audio is flowing (or synthesis failed) — gate readiness cues on this. */
    ready: Promise<void>;
    /** Decoded audio for playback via speakPcm; buffers so playback can attach any time. */
    stream: PcmBlockBuffer;
    /** Abort synthesis and discard the readout (superseded or dismissed). */
    cancel(): void;
}

/**
 * Start synthesizing speech for text via the app's voice route, decoding the
 * streamed WAV response as it arrives. Synthesis begins immediately; playback
 * attaches whenever the readout is actually wanted. Text may be a promise so
 * a summary can still be enriching while the handle is already cacheable.
 */
export function startSpeech(text: string | Promise<string>, opts?: { voice?: string; model?: string }): SpeechHandle {
    const controller = new AbortController();
    const stream = new PcmBlockBuffer();
    void (async () => {
        try {
            const input = await text;
            const res = await apiFetch('/api/voice/speech', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: input, format: 'wav', ...opts }),
                signal: controller.signal,
            });
            if (!res.ok) throw await toVoiceError(res);
            if (!res.body) throw new Error('Speech response had no body');
            const parser = new WavStreamParser();
            const reader = res.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const samples = parser.push(value);
                if (parser.info) stream.sampleRate = parser.info.sampleRate;
                if (samples.length) stream.push(samples);
            }
            stream.end();
        } catch (error) {
            stream.fail(error);
        }
    })();
    // Acks never observe `ready`; keep an unwatched rejection from surfacing as unhandled.
    stream.first.catch(() => {});
    return { ready: stream.first, stream, cancel: () => controller.abort() };
}
