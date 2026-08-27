/**
 * Conversation Event Bus
 *
 * In-memory pub/sub keyed by conversationId. Runs publish events to the bus;
 * WebSocket connections subscribe. Runs complete independently of any observer.
 */

import type {
    ServerMessage,
    QueuedMessage,
    PendingConfirmation,
    StopReason,
    TextDeltaMessage,
    ReasoningDeltaMessage,
    ToolCallProgressMessage,
} from '../routes/ws/message-types';
import type { ConfirmationPreferences } from '../processor/confirmation';
import type { ATIFStep } from '../processor/conversation/atif/atif.types';
import type { User } from '../db/schema';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'event-bus' });

// Re-export ServerMessage as the event type
export type ConversationEvent = ServerMessage;

export interface RunHandle {
    runId: string;
    clientMessageId: string;
    conversationId: string;
    abortController: AbortController;
    stopMode: 'none' | 'soft' | 'hard';
    stopReason?: StopReason;
    queuedMessages: QueuedMessage[];
    pendingConfirmations: Map<string, PendingConfirmation>;
    /**
     * Steps delivered to this conversation mid-run (e.g. a delegated task finishing).
     * Already persisted; queued here so the running loop can pick them up.
     */
    injectedSteps: ATIFStep[];
}

export function createRunHandle(runId: string, clientMessageId: string, conversationId: string): RunHandle {
    return {
        runId,
        clientMessageId,
        conversationId,
        abortController: new AbortController(),
        stopMode: 'none',
        stopReason: undefined,
        queuedMessages: [],
        pendingConfirmations: new Map(),
        injectedSteps: [],
    };
}

type Subscriber = (event: ConversationEvent) => void;

// Replay needs to comfortably cover a full run's worth of events.
// Each tool step typically produces 2 events (step_start + step_end), plus lifecycle events.
const MAX_REPLAY_EVENTS = 250;

// Streamed text arrives one frame per token; most of each frame is envelope overhead.
// Coalescing caps delta frames at one per interval (~20/s).
// So a fast ~200 tok/s stream has ~10x fewer frames, overhead. Slower ones floor at ~20/s, 1x.
// The client re-paces rendering, so window stays below perceptible latency.
const DELTA_COALESCE_MS = 50;

/** Streamed text channels, buffered separately so their content never interleaves. */
type DeltaEvent = TextDeltaMessage | ReasoningDeltaMessage;

export class ConversationEventBus {
    readonly conversationId: string;
    private subscribers = new Set<Subscriber>();
    private recentEvents: ConversationEvent[] = [];
    private pendingDeltas = new Map<DeltaEvent['type'], DeltaEvent>();
    private pendingToolProgress = new Map<string, ToolCallProgressMessage>();
    private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
    activeRun: RunHandle | null = null;

    /** Context carried across queued runs within the same bus */
    user: typeof User.$inferSelect | null = null;
    confirmationPreferences: ConfirmationPreferences | null = null;
    chatModelId?: number;

    constructor(conversationId: string) {
        this.conversationId = conversationId;
    }

    subscribe(fn: Subscriber): () => void {
        this.subscribers.add(fn);
        return () => {
            this.subscribers.delete(fn);
            this.maybeCleanup();
        };
    }

    /**
     * Subscribe and return a replay snapshot captured in the same synchronous tick.
     * Useful for observe flows that want to send replay first, then live events.
     */
    subscribeWithReplay(fn: Subscriber): { unsubscribe: () => void; replay: ConversationEvent[] } {
        const replay = this.getReplayEvents();
        const unsubscribe = this.subscribe(fn);
        return { unsubscribe, replay };
    }

    publish(event: ConversationEvent): void {
        // Buffer streamed text and emit it coalesced (see flushPending).
        if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
            this.bufferDelta(event);
            // Short-circuit. Don't add streamed events to recentEvents to:
            // 1. Not evict actual replay events from bounded buffer
            // 2. Avoid duplicate streamed content after localStorage hydration on replay
            return;
        }

        // Tool call progress is cumulative, so only the newest frame per call
        // matters. Keep the latest instead of appending.
        if (event.type === 'tool_call_progress') {
            this.pendingToolProgress.set(event.data.callId, event);
            this.scheduleFlush();
            return;
        }

        // Any other event flushes pending deltas first, so streamed text never
        // arrives after the step or lifecycle event that supersedes it.
        this.flushPending();

        // Reset replay buffer on run_started
        if (event.type === 'run_started') {
            this.recentEvents = [];
        }

        this.recentEvents.push(event);
        if (this.recentEvents.length > MAX_REPLAY_EVENTS) {
            this.recentEvents.shift();
        }

        this.deliver(event);
    }

    private deliver(event: ConversationEvent): void {
        for (const fn of this.subscribers) {
            try {
                fn(event);
            } catch (err) {
                log.error({ err, conversationId: this.conversationId }, 'Subscriber error');
            }
        }
    }

    private bufferDelta(event: DeltaEvent): void {
        const pending = this.pendingDeltas.get(event.type);
        // A run change shouldn't interleave with live deltas, but flush
        // defensively so buffered text is never misattributed to a new run.
        if (pending && pending.runId !== event.runId) {
            this.flushPending();
        }

        const current = this.pendingDeltas.get(event.type);
        if (current) {
            current.data = { delta: current.data.delta + event.data.delta };
        } else {
            this.pendingDeltas.set(event.type, { ...event, data: { ...event.data } });
        }

        this.scheduleFlush();
    }

    /** Fixed-interval flush, not a sliding debounce: continuous streaming still
     *  flushes every DELTA_COALESCE_MS, bounding added latency. */
    private scheduleFlush(): void {
        if (!this.deltaFlushTimer) {
            this.deltaFlushTimer = setTimeout(() => this.flushPending(), DELTA_COALESCE_MS);
        }
    }

    private flushPending(): void {
        if (this.deltaFlushTimer) {
            clearTimeout(this.deltaFlushTimer);
            this.deltaFlushTimer = null;
        }

        const deltas = [...this.pendingDeltas.values()];
        this.pendingDeltas.clear();
        for (const event of deltas) this.deliver(event);

        const progress = [...this.pendingToolProgress.values()];
        this.pendingToolProgress.clear();
        for (const event of progress) this.deliver(event);
    }

    hasSubscribers(): boolean {
        return this.subscribers.size > 0;
    }

    getReplayEvents(): ConversationEvent[] {
        // Replay exists to let late observers catch up on an in-flight run.
        // If there's no active run, clients should rely on persisted history instead.
        // Replaying old run events after completion can cause duplicate UI updates.
        if (!this.activeRun) return [];

        // Don't replay confirmations that are no longer actionable.
        // If a confirmation was already responded to, it will have been removed
        // from the active run's pendingConfirmations map. Replaying it would
        // cause the UI to re-show an already-acknowledged dialog/toast after reload.
        const pending = this.activeRun.pendingConfirmations;

        return this.recentEvents.filter(e => {
            // defensive, streamed events are excluded from the replay buffer in publish()
            if (e.type === 'text_delta' || e.type === 'reasoning_delta' || e.type === 'tool_call_progress') return false;
            if (e.type !== 'confirmation_request') return true;
            const requestId = (e as any)?.data?.requestId;
            return typeof requestId === 'string' && pending.has(requestId);
        });
    }

    private maybeCleanup(): void {
        if (!this.activeRun && this.subscribers.size === 0) {
            removeBus(this.conversationId);
        }
    }

    /** Called when a run finishes to potentially clean up the bus */
    onRunFinished(): void {
        // Terminal events already flush, but guard against a dangling timer.
        this.flushPending();
        this.activeRun = null;
        this.maybeCleanup();
    }
}

// Global registry
const buses = new Map<string, ConversationEventBus>();

export function getOrCreateBus(conversationId: string): ConversationEventBus {
    let bus = buses.get(conversationId);
    if (!bus) {
        bus = new ConversationEventBus(conversationId);
        buses.set(conversationId, bus);
    }
    return bus;
}

export function getBus(conversationId: string): ConversationEventBus | undefined {
    return buses.get(conversationId);
}

export function removeBus(conversationId: string): void {
    buses.delete(conversationId);
}

/** For testing: clear all buses */
export function clearAllBuses(): void {
    buses.clear();
}
