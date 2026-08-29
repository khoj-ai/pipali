/**
 * Notification utilities for Pipali.
 * In Tauri desktop app, sends native macOS notifications via Rust command with click handling.
 * In browser, uses Web Notification API.
 */

import { isTauri } from './tauri';
import type { ConfirmationRequest } from '../../server/processor/confirmation/confirmation.types';
import i18n from '../i18n';
import { VOICE_EARCONS, TRANSCRIPT_TICK, clampTickCount, tickBurstDurationMs, type EarconNote, type VoiceCueProfile } from './voice/voice-earcons';
import { VOICE_TUNABLES } from './voice/voice-config';
import { StreamResampler } from './voice/voice-pcm';

let notificationPermissionGranted: boolean | null = null;

// Shared AudioContext for notification sounds (created lazily)
let audioCtx: AudioContext | null = null;

// Speech sits behind its own gain so a suspected barge-in can duck it without
// touching the cue vocabulary, which stays at full level.
let speechGain: GainNode | null = null;

/**
 * Play a short two-tone chime for notifications using the Web Audio API.
 * No audio file required — synthesizes a brief ping sound.
 */
function playNotificationSound(): void {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        const now = ctx.currentTime;

        // First tone — higher pitch
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.value = 830;
        gain1.gain.setValueAtTime(0.3, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc1.connect(gain1).connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.15);

        // Second tone — slightly higher, delayed
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.value = 1050;
        gain2.gain.setValueAtTime(0.3, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc2.connect(gain2).connect(ctx.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.3);
    } catch {
        // Audio not available — silently ignore
    }
}

// ============================================================================
// Voice companion audio: distinct attention cues + a TTS playback queue
// ============================================================================

/** Lazily create (and resume) the shared AudioContext. */
function ensureAudioContext(): AudioContext | null {
    try {
        if (!audioCtx) audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') void audioCtx.resume();
        return audioCtx;
    } catch {
        return null;
    }
}

function ensureSpeechGain(ctx: AudioContext): GainNode {
    if (!speechGain) {
        speechGain = ctx.createGain();
        speechGain.connect(ctx.destination);
    }
    return speechGain;
}

/**
 * Duck Pipali's speech the moment someone starts talking over it, before the
 * words have been transcribed. Quieting down is the recoverable move: it costs
 * nothing if the sound turns out to be Pipali's own echo, and it makes the
 * response to a real interruption immediate instead of a transcription away.
 */
export function duckSpeech(ducked: boolean): void {
    if (!audioCtx || !speechGain) return;
    const target = ducked ? VOICE_TUNABLES.duckGain : 1;
    speechGain.gain.cancelScheduledValues(audioCtx.currentTime);
    speechGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.02);
}

// Earcon vocabulary (pure data + duration math) lives in voice-earcons.ts so
// it's testable without an AudioContext; this module owns the players.
export { voiceCueDurationMs, type VoiceCueProfile } from './voice/voice-earcons';

function scheduleNote(ctx: AudioContext, base: number, note: EarconNote): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = note.freq;
    gain.gain.setValueAtTime(note.gain, base + note.at);
    gain.gain.exponentialRampToValueAtTime(0.001, base + note.at + note.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(base + note.at);
    osc.stop(base + note.at + note.dur);
}

/** Play a voice earcon (does not speak). */
export function playVoiceCue(profile: VoiceCueProfile): void {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        const now = ctx.currentTime;
        for (const note of VOICE_EARCONS[profile]) scheduleNote(ctx, now, note);
    } catch {
        // ignore
    }
}

/**
 * Typewriter burst: one soft tick per transcribed word (capped), alternating
 * between two pitches — eyes-free verification that words are landing.
 * Returns the burst duration in ms so callers can suppress capture around it.
 */
export function playTranscriptTicks(wordCount: number): number {
    const ctx = ensureAudioContext();
    if (!ctx) return 0;
    try {
        const now = ctx.currentTime;
        const ticks = clampTickCount(wordCount);
        for (let i = 0; i < ticks; i++) {
            scheduleNote(ctx, now, {
                freq: TRANSCRIPT_TICK.freqs[i % 2]!,
                at: i * TRANSCRIPT_TICK.spacing,
                dur: TRANSCRIPT_TICK.dur,
                gain: TRANSCRIPT_TICK.gain,
            });
        }
    } catch {
        // ignore
    }
    return tickBurstDurationMs(wordCount);
}

// Serialized TTS playback so a completion summary never overlaps a confirmation readback.
let speechChain: Promise<void> = Promise.resolve();
// Halts the readout currently scheduling PCM blocks (barge-in).
let stopActiveSpeech: (() => void) | null = null;
// Invalidates callbacks already chained behind the active readout. Resetting
// speechChain alone cannot detach callbacks from its previous value.
let speechGeneration = 0;

/** A pull source of decoded speech samples; sampleRate is 0 until the stream's header has parsed. */
export interface PcmStream {
    readonly sampleRate: number;
    blocks(): AsyncIterable<Float32Array<ArrayBuffer>>;
}

/**
 * Play a decoded PCM stream gaplessly: blocks are resampled to the context's
 * own rate, coalesced, and scheduled behind one another on a running clock
 * kept a lead ahead of the speaker, so playback starts early while later
 * blocks are still arriving and ordinary arrival jitter is absorbed by the
 * lead. Only a real underrun — the schedule falling back to the speaker —
 * leaves a silence and re-leads after it.
 */
async function playPcmStream(ctx: AudioContext, stream: PcmStream): Promise<void> {
    const gain = ensureSpeechGain(ctx);
    const active = new Set<AudioBufferSourceNode>();
    let stopped = false;
    let streamEnded = false;
    let nextStart = 0;
    let settle!: () => void;
    const donePlaying = new Promise<void>((resolve) => { settle = resolve; });
    const maybeSettle = () => {
        if (stopped || (streamEnded && active.size === 0)) settle();
    };
    const stop = () => {
        stopped = true;
        for (const source of active) {
            try { source.stop(); } catch { /* already stopped */ }
        }
        active.clear();
        maybeSettle();
    };
    stopActiveSpeech = stop;
    // Consume in the background: a stop must release this readout immediately,
    // even while the loop is suspended waiting on a stalled producer.
    void (async () => {
        let queued: Float32Array[] = [];
        let queuedSamples = 0;
        // Built on the first block, once the stream's header has given a rate.
        let resampler: StreamResampler | null = null;
        const toContextRate = (block: Float32Array): Float32Array => {
            if (stream.sampleRate === ctx.sampleRate) return block;
            if (!resampler) {
                if (ctx.sampleRate < stream.sampleRate) {
                    // The speech is wider than the output can carry, so the top
                    // of it is being filtered away. Worth knowing about: it
                    // means the device put us on a narrowband route.
                    console.warn(`[voice] output runs at ${ctx.sampleRate}Hz, below the ${stream.sampleRate}Hz speech`);
                }
                resampler = new StreamResampler(stream.sampleRate, ctx.sampleRate);
            }
            return resampler.push(block);
        };
        /** The resampler's tail, once no more input is coming. */
        const drainContextRate = (): Float32Array => resampler?.flush() ?? new Float32Array(0);
        const enqueue = (block: Float32Array) => {
            if (!block.length) return;
            queued.push(block);
            queuedSamples += block.length;
        };
        const schedule = () => {
            if (!queuedSamples) return;
            const samples = new Float32Array(queuedSamples);
            let at = 0;
            for (const part of queued) { samples.set(part, at); at += part.length; }
            queued = [];
            queuedSamples = 0;

            const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
            buffer.copyToChannel(samples, 0);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            if (nextStart - ctx.currentTime < VOICE_TUNABLES.speechMinLeadMs / 1000) {
                nextStart = ctx.currentTime + VOICE_TUNABLES.speechLeadMs / 1000;
            }
            source.start(nextStart);
            nextStart += buffer.duration;
            active.add(source);
            source.onended = () => { active.delete(source); maybeSettle(); };
        };
        try {
            for await (const block of stream.blocks()) {
                if (stopped) break;
                if (!block.length || !stream.sampleRate) continue;
                enqueue(toContextRate(block));
                if (queuedSamples >= (VOICE_TUNABLES.speechBlockMs / 1000) * ctx.sampleRate) schedule();
            }
        } catch {
            // Synthesis failed mid-stream — play whatever did arrive.
        }
        if (!stopped) {
            enqueue(drainContextRate());
            schedule();
        }
        streamEnded = true;
        maybeSettle();
    })();
    await donePlaying;
    if (stopActiveSpeech === stop) stopActiveSpeech = null;
}

/** Queue a TTS stream for playback; resolves when it finishes. Never overlaps prior speech. */
export function speakPcm(stream: PcmStream): Promise<void> {
    const ctx = ensureAudioContext();
    if (!ctx) return Promise.resolve();
    const generation = speechGeneration;
    const play = speechChain.catch(() => {}).then(() => {
        if (generation !== speechGeneration) return;
        return playPcmStream(ctx, stream);
    });
    speechChain = play.catch(() => {});
    return play;
}

/** Stop current playback and clear the queue (barge-in). */
export function stopSpeaking(): void {
    speechGeneration++;
    stopActiveSpeech?.();
    stopActiveSpeech = null;
    speechChain = Promise.resolve();
    duckSpeech(false);
}

/** Resume the AudioContext and play a brief tick — call from a user gesture to satisfy autoplay policy. */
export async function warmAudioContext(): Promise<void> {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        if (ctx.state === 'suspended') await ctx.resume();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 660;
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.08);
    } catch {
        // ignore
    }
}

// Track active web notifications for cleanup
const activeWebNotifications: Map<string, Notification> = new Map();

// Callback for when a notification is clicked (used for navigation)
type NotificationClickHandler = (conversationId: string) => void;
let notificationClickHandler: NotificationClickHandler | null = null;

/**
 * Register a handler for notification clicks.
 * The handler receives the conversation ID associated with the notification.
 */
export function setNotificationClickHandler(handler: NotificationClickHandler | null): void {
    notificationClickHandler = handler;
}

/**
 * Send a web notification using the Web Notification API.
 * @param tag - Unique identifier for the notification (prevents duplicates with same tag)
 * @param title - Notification title
 * @param body - Notification body text
 * @param conversationId - Optional conversation ID for navigation on click
 * @returns The created Notification or null if failed
 */
function sendWebNotification(tag: string, title: string, body: string, conversationId?: string): Notification | null {
    if (!('Notification' in window) || !notificationPermissionGranted) {
        return null;
    }

    try {
        const notification = new Notification(title, {
            body,
            icon: '/icons/pipali_128.png',
            tag,
            requireInteraction: true,
        });

        notification.onclick = async () => {
            await focusAppWindow();
            notification.close();
            activeWebNotifications.delete(tag);
            // Navigate to the conversation if handler is registered
            if (conversationId && notificationClickHandler) {
                notificationClickHandler(conversationId);
            }
        };

        notification.onclose = () => {
            activeWebNotifications.delete(tag);
        };

        activeWebNotifications.set(tag, notification);
        return notification;
    } catch (err) {
        console.warn('[notifications] Failed to create web notification:', err);
        return null;
    }
}

/**
 * Check if the app tab/window is currently visible to the user.
 */
export function isWindowFocused(): boolean {
    // Check both visibility state and focus
    // When window is hidden to tray, visibilityState should be 'hidden'
    const isVisible = document.visibilityState === 'visible';
    const hasFocus = document.hasFocus();
    return isVisible && hasFocus;
}

/**
 * Send a native notification via the Rust backend.
 * Click handling is done via the `notification-clicked` Tauri event.
 */
async function sendTauriNotification(title: string, body: string, conversationId?: string): Promise<void> {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('send_notification', {
            options: { title, body, conversationId: conversationId ?? null },
        });
    } catch (err) {
        console.warn('[notifications] Failed to send native notification:', err);
    }
}

/**
 * Initialize notification permissions.
 * Call this once when the app starts.
 */
export async function initNotifications(): Promise<boolean> {
    // Tauri desktop app — Rust handles native notifications via UNUserNotificationCenter.
    // Permission is requested on the Rust side during app init.
    if (isTauri()) {
        notificationPermissionGranted = true;
        return true;
    }

    // Web path - use Web Notification API
    if (!('Notification' in window)) {
        console.warn('[notifications] Web Notification API not supported');
        notificationPermissionGranted = false;
        return false;
    }

    if (Notification.permission === 'granted') {
        notificationPermissionGranted = true;
        return true;
    }

    if (Notification.permission === 'denied') {
        notificationPermissionGranted = false;
        return false;
    }

    try {
        const result = await Notification.requestPermission();
        notificationPermissionGranted = result === 'granted';
        return notificationPermissionGranted;
    } catch (err) {
        console.warn('[notifications] Failed to request web notification permission:', err);
        notificationPermissionGranted = false;
        return false;
    }
}

/**
 * Send a notification for a confirmation request.
 * Only sends if window is not focused.
 *
 * @param request - The confirmation request
 * @param conversationTitle - Optional title for context in the notification
 * @param conversationId - The conversation ID to navigate to when notification is clicked
 */
export async function notifyConfirmationRequest(
    request: ConfirmationRequest,
    conversationTitle?: string,
    conversationId?: string
): Promise<void> {
    // Always play sound for confirmation requests — user may not be looking at screen
    playNotificationSound();

    // Don't send visual notification if window is focused - user can see the toast
    if (isWindowFocused()) {
        return;
    }

    // Check permissions (lazy init)
    if (notificationPermissionGranted === null) {
        await initNotifications();
    }
    if (!notificationPermissionGranted) return;

    // Build notification content
    const title = request.operation === 'ask_user'
        ? i18n.t('notifications.questionFromPipali')
        : i18n.t('notifications.actionRequired');

    const body = conversationTitle
        ? `${conversationTitle}: ${request.title}`
        : request.title;

    if (isTauri()) {
        await sendTauriNotification(title, body, conversationId);
        return;
    }

    const tag = `confirmation-${request.requestId}`;
    sendWebNotification(tag, title, body, conversationId);
}

/**
 * Send a notification when a task completes.
 * Uses native OS notifications in Tauri, or Web Notification API in browser.
 * Only sends if window is not focused.
 *
 * @param userRequest - The original user request/query
 * @param responseSnippet - A snippet of the agent's response
 * @param conversationId - The conversation ID to navigate to when notification is clicked
 */
export async function notifyTaskComplete(
    userRequest?: string,
    responseSnippet?: string,
    conversationId?: string
): Promise<void> {
    if (isWindowFocused()) return;

    playNotificationSound();

    // Check permissions (lazy init)
    if (notificationPermissionGranted === null) {
        await initNotifications();
    }
    if (!notificationPermissionGranted) return;

    // Build notification content
    const title = userRequest
        ? truncate(userRequest, 50)
        : i18n.t('notifications.taskComplete');

    const body = responseSnippet
        ? truncate(responseSnippet, 100)
        : i18n.t('notifications.taskFinished');

    if (isTauri()) {
        await sendTauriNotification(title, body, conversationId);
        return;
    }

    const tag = `task-complete-${Date.now()}`;
    sendWebNotification(tag, title, body, conversationId);
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
function truncate(text: string, maxLength: number): string {
    // Normalize whitespace (collapse newlines and multiple spaces)
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return normalized.slice(0, maxLength - 1) + '…';
}

/**
 * Focus the app window.
 * In Tauri, uses the focus_window command to properly show window and add to dock.
 * In browser, uses window.focus().
 */
export async function focusAppWindow(): Promise<void> {
    if (isTauri()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('focus_window');
        } catch (err) {
            console.warn('[notifications] Failed to focus Tauri window:', err);
        }
        return;
    }

    window.focus();
}

/**
 * Setup listener for the `notification-clicked` Tauri event.
 * When the Rust backend detects a notification click, it emits this event
 * with the conversation ID, and we navigate to that conversation.
 */
export function setupNotificationClickListener(): void {
    if (!isTauri()) return;

    import('@tauri-apps/api/event').then(({ listen }) => {
        listen<string>('notification-clicked', (event) => {
            const convId = event.payload;
            if (convId && notificationClickHandler) {
                notificationClickHandler(convId);
            }
        });
    });
}
