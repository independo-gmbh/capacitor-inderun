import type { PluginListenerHandle } from "@capacitor/core";
import {
  validateStreamRunHandle,
  type StreamEvent,
  type StreamRunHandle,
  type TaskRequest
} from "@independo/inderun-contracts";
import type {
  IndeRunCapacitorPlugin,
  StreamErrorNotification,
  StreamEventNotification,
  StreamRun
} from "./definitions.js";
import { createBridgeError, normalizePluginError } from "./errors.js";

/**
 * Listener event names. These are **public contract**: an app may attach its own
 * listener, and native code emits exactly these. Renaming one is a breaking change.
 */
export const STREAM_EVENT_NAME = "indeRunStreamEvent";
export const STREAM_ERROR_NAME = "indeRunStreamError";

/**
 * How long to wait, after the terminal event has arrived, for a still-missing
 * earlier event before declaring the run's event sequence irrecoverable.
 *
 * Deliberately a module constant rather than a public option: any value here is a
 * behavioural policy, and behaviour belongs in the engines, not in the bridge.
 */
const REORDER_GRACE_MS = 250;

function createStreamId(): string {
  const globalCrypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof globalCrypto?.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  return `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Reassembles one run's canonical event sequence on the JS side of the bridge.
 *
 * The bridge hop is not order-preserving, which is why `StreamEvent.sequence` is
 * the contract's ordering authority rather than arrival order. This sink buffers
 * out-of-order arrivals and yields strictly by `sequence`, so a consumer sees
 * exactly what the engine's Event Gate admitted, in the order it admitted it.
 *
 * It owns no run semantics: it never synthesizes a terminal event, never retries,
 * never decides an outcome. A gap that never closes becomes a transport error, not
 * an invented ending. Everything about *what* a run does stays in the engines.
 */
class StreamSink {
  private nextSequence = 0;
  private readonly pending = new Map<number, StreamEvent>();
  private readonly ready: StreamEvent[] = [];
  private terminalSequence: number | null = null;
  private runId: string | null = null;
  private failure: unknown = null;
  private done = false;
  private wake: (() => void) | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  bindRunId(runId: string): void {
    this.runId = runId;
  }

  /**
   * True once the run has ended — the terminal event has been admitted, or the
   * transport has failed — regardless of whether the consumer has drained it yet.
   */
  isFinished(): boolean {
    return this.done || this.failure !== null;
  }

  accept(event: StreamEvent): void {
    if (this.isFinished()) {
      return;
    }
    // Defence in depth on top of streamId routing: an event for another run is
    // never this run's business.
    if (this.runId !== null && event.runId !== this.runId) {
      return;
    }
    // Already delivered (a duplicate), or arriving after the terminal that closed
    // the run. The Event Gate guarantees the terminal is the highest sequence.
    if (event.sequence < this.nextSequence) {
      return;
    }
    if (this.terminalSequence !== null && event.sequence > this.terminalSequence) {
      return;
    }

    this.pending.set(event.sequence, event);
    if (event.type === "terminal") {
      this.terminalSequence = event.sequence;
    }
    this.drain();
  }

  fail(error: unknown): void {
    if (this.isFinished()) {
      return;
    }
    this.clearGrace();
    this.failure = error;
    this.signal();
  }

  async *iterate(): AsyncGenerator<StreamEvent> {
    for (;;) {
      while (this.ready.length > 0) {
        yield this.ready.shift() as StreamEvent;
      }
      if (this.failure !== null) {
        throw this.failure;
      }
      if (this.done) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  dispose(): void {
    this.clearGrace();
  }

  private drain(): void {
    let moved = false;
    for (;;) {
      const next = this.pending.get(this.nextSequence);
      if (next === undefined) {
        break;
      }
      this.pending.delete(this.nextSequence);
      this.ready.push(next);
      this.nextSequence += 1;
      moved = true;
    }

    if (this.terminalSequence !== null) {
      if (this.nextSequence > this.terminalSequence) {
        // The whole 0..terminal range has been handed over, in order.
        this.clearGrace();
        this.done = true;
      } else {
        this.startGrace();
      }
    }

    if (moved || this.done) {
      this.signal();
    }
  }

  private startGrace(): void {
    if (this.graceTimer !== null) {
      return;
    }
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.onGraceExpired();
    }, REORDER_GRACE_MS);
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /**
   * The terminal arrived but an earlier event never did.
   *
   * Hand over the content that did arrive, in order, then fail. The terminal itself
   * is deliberately withheld: delivering it would assert an ending — a `finalText`,
   * a clean `completed` — that the consumer's own event sequence does not support.
   * A transport that lost events reports that, rather than papering over it.
   */
  private onGraceExpired(): void {
    if (this.isFinished()) {
      return;
    }

    const terminalSequence = this.terminalSequence as number;
    let lost = 0;
    for (let sequence = this.nextSequence; sequence <= terminalSequence; sequence += 1) {
      if (!this.pending.has(sequence)) {
        lost += 1;
      }
    }

    for (const [sequence, event] of [...this.pending.entries()].sort(([a], [b]) => a - b)) {
      if (sequence !== terminalSequence) {
        this.ready.push(event);
      }
    }
    this.pending.clear();

    this.failure = createBridgeError(
      `Capacitor bridge lost ${lost} stream event(s) for run ${this.runId ?? "<unknown>"}.`,
      this.runId ?? undefined
    );
    this.signal();
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/**
 * Owns the two plugin listeners and fans notifications out to the sink for each
 * live run.
 *
 * One registration serves every concurrent run: listeners are attached on the
 * first bind and removed once the last run releases, so a consumer that streams
 * repeatedly does not accumulate listeners.
 */
class StreamDispatcher {
  private readonly sinks = new Map<string, StreamSink>();
  private handles: PluginListenerHandle[] | null = null;
  private registering: Promise<void> | null = null;

  async bind(plugin: IndeRunCapacitorPlugin, streamId: string, sink: StreamSink): Promise<void> {
    this.sinks.set(streamId, sink);
    try {
      await this.ensureListeners(plugin);
    } catch (error) {
      this.sinks.delete(streamId);
      throw error;
    }
  }

  release(streamId: string): void {
    const sink = this.sinks.get(streamId);
    if (sink === undefined) {
      return;
    }
    sink.dispose();
    this.sinks.delete(streamId);
    if (this.sinks.size === 0) {
      void this.removeListeners();
    }
  }

  private ensureListeners(plugin: IndeRunCapacitorPlugin): Promise<void> {
    this.registering ??= (async () => {
      const [events, errors] = await Promise.all([
        plugin.addListener(STREAM_EVENT_NAME, this.handleEvent),
        plugin.addListener(STREAM_ERROR_NAME, this.handleError)
      ]);
      this.handles = [events, errors];
    })().catch((error: unknown) => {
      this.registering = null;
      throw error;
    });
    return this.registering;
  }

  private async removeListeners(): Promise<void> {
    const handles = this.handles;
    this.handles = null;
    this.registering = null;
    if (handles === null) {
      return;
    }
    await Promise.all(handles.map((handle) => handle.remove()));
  }

  // Arrow properties: they are handed to addListener and must keep their binding.
  private readonly handleEvent = (notification: StreamEventNotification): void => {
    // An unknown streamId is a retained notification replayed for a run that has
    // already finished. Dropping it is correct, not an error.
    this.sinks.get(notification.streamId)?.accept(notification.event);
  };

  private readonly handleError = (notification: StreamErrorNotification): void => {
    this.sinks.get(notification.streamId)?.fail(notification.error);
  };
}

const dispatcher = new StreamDispatcher();

/**
 * Starts a Mode 2 run over the bridge and reassembles it into the same `StreamRun`
 * shape `@independo/inderun-web` returns directly.
 *
 * The listeners are registered *before* `startStream` is called, so no event can be
 * emitted for a run whose sink does not exist yet.
 */
export async function startCapacitorStream(
  plugin: IndeRunCapacitorPlugin,
  request: TaskRequest
): Promise<StreamRun> {
  const streamId = createStreamId();
  const sink = new StreamSink();

  await dispatcher.bind(plugin, streamId, sink);

  let handle: StreamRunHandle;
  try {
    handle = await plugin.startStream({ streamId, request });
  } catch (error) {
    dispatcher.release(streamId);
    throw normalizePluginError(error);
  }

  if (!validateStreamRunHandle(handle)) {
    dispatcher.release(streamId);
    throw createBridgeError(
      "Capacitor bridge received a malformed StreamRunHandle from the native plugin."
    );
  }
  sink.bindRunId(handle.runId);

  let cancelled = false;

  const requestCancel = (reason?: string): void => {
    // Cancelling a run that has already ended is a no-op by contract, and is
    // answered locally so the bridge is not crossed for nothing.
    if (cancelled || sink.isFinished()) {
      return;
    }
    cancelled = true;
    void plugin
      .cancelStream({ streamId, ...(reason !== undefined ? { reason } : {}) })
      .catch((error: unknown) => sink.fail(normalizePluginError(error)));
  };

  const generator = (async function* consume(): AsyncGenerator<StreamEvent> {
    try {
      yield* sink.iterate();
    } finally {
      // Covers the consumer abandoning the loop with `break`: tell native to stop
      // producing, and let go of the listeners.
      requestCancel();
      dispatcher.release(streamId);
    }
  })();

  return {
    handle,
    events: {
      // Single-use, matching the engines: the run is driven once, not restarted per
      // consumer, so a second iteration observes completion rather than a replay.
      [Symbol.asyncIterator]: () => generator
    },
    cancel: requestCancel
  };
}
