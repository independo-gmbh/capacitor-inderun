import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamRunHandle, TaskRequest } from "@independo/inderun-contracts";
import { validateStreamEvent } from "@independo/inderun-contracts";
import type { IndeRunCapacitorPlugin, StreamRun } from "./definitions.js";

const REQUEST: TaskRequest = {
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Hello"
};

function handleFor(runId: string): StreamRunHandle {
  return { schemaVersion: "1.0", runId, startedAt: 1_700_000_000_000 };
}

function delta(sequence: number, runId = "run_1"): StreamEvent {
  return {
    schemaVersion: "1.0",
    runId,
    sequence,
    timestamp: 1_700_000_000_000 + sequence,
    type: "content_delta",
    payload: { text: `d${sequence}` }
  };
}

function terminal(
  sequence: number,
  outcome: "completed" | "error" | "cancelled" = "completed",
  runId = "run_1"
): StreamEvent {
  const payload: Record<string, unknown> = { schemaVersion: "1.0", runId, outcome };
  if (outcome === "completed") {
    payload["finalText"] = "done";
    payload["finishReason"] = "stop";
  } else if (outcome === "cancelled") {
    payload["partialText"] = "part";
  } else {
    payload["partialText"] = "part";
    payload["error"] = {
      schemaVersion: "1.0",
      errorClass: "RateLimited",
      message: "Too many requests."
    };
  }

  return {
    schemaVersion: "1.0",
    runId,
    sequence,
    timestamp: 1_700_000_000_000 + sequence,
    type: "terminal",
    payload
  };
}

interface FakePlugin {
  plugin: IndeRunCapacitorPlugin;
  startStream: ReturnType<typeof vi.fn>;
  cancelStream: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  removes: ReturnType<typeof vi.fn>[];
  emitEvent(streamId: string, event: StreamEvent): void;
  emitError(streamId: string, error: unknown): void;
  lastStreamId(): string;
}

function createFakePlugin(handle: StreamRunHandle = handleFor("run_1")): FakePlugin {
  const listeners: { name: string; callback: (notification: unknown) => void }[] = [];
  const removes: ReturnType<typeof vi.fn>[] = [];

  const startStream = vi.fn().mockResolvedValue(handle);
  const cancelStream = vi.fn().mockResolvedValue(undefined);
  const addListener = vi.fn(async (name: string, callback: (notification: unknown) => void) => {
    listeners.push({ name, callback });
    const remove = vi.fn().mockResolvedValue(undefined);
    removes.push(remove);
    return { remove };
  });

  const plugin = {
    configure: vi.fn(),
    run: vi.fn(),
    startStream,
    cancelStream,
    addListener,
    removeAllListeners: vi.fn()
  } as unknown as IndeRunCapacitorPlugin;

  function dispatch(name: string, notification: unknown): void {
    for (const listener of listeners) {
      if (listener.name === name) {
        listener.callback(notification);
      }
    }
  }

  return {
    plugin,
    startStream,
    cancelStream,
    addListener,
    removes,
    emitEvent: (streamId, event) => dispatch("indeRunStreamEvent", { streamId, event }),
    emitError: (streamId, error) => dispatch("indeRunStreamError", { streamId, error }),
    lastStreamId: () =>
      (startStream.mock.calls[startStream.mock.calls.length - 1][0] as { streamId: string })
        .streamId
  };
}

async function collect(run: StreamRun): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
  }
  return events;
}

/**
 * The dispatcher is module state (one listener registration shared by every run),
 * so each test gets a freshly imported module rather than inheriting the previous
 * test's bindings.
 */
async function freshStart(): Promise<typeof import("./streaming.js").startCapacitorStream> {
  vi.resetModules();
  const module = await import("./streaming.js");
  return module.startCapacitorStream;
}

describe("startCapacitorStream", () => {
  let startCapacitorStream: Awaited<ReturnType<typeof freshStart>>;

  beforeEach(async () => {
    startCapacitorStream = await freshStart();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers its listeners before starting the run", async () => {
    const fake = createFakePlugin();
    fake.startStream.mockImplementation(async () => {
      // By the time native is asked to start, both sinks must already be bound —
      // otherwise an event emitted immediately would have nowhere to land.
      expect(fake.addListener).toHaveBeenCalledTimes(2);
      return handleFor("run_1");
    });

    const run = await startCapacitorStream(fake.plugin, REQUEST);
    fake.emitEvent(fake.lastStreamId(), terminal(0));
    await collect(run);

    expect(fake.addListener.mock.calls.map((call) => call[0])).toEqual([
      "indeRunStreamEvent",
      "indeRunStreamError"
    ]);
  });

  it("yields events in sequence order and completes on the terminal event", async () => {
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const collected = collect(run);
    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, delta(1));
    fake.emitEvent(streamId, terminal(2));

    const events = await collected;
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(events.every((event) => event.runId === run.handle.runId)).toBe(true);
    expect(events.every((event) => validateStreamEvent(event))).toBe(true);
  });

  it("reorders out-of-order delivery by sequence, not arrival", async () => {
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const collected = collect(run);
    fake.emitEvent(streamId, delta(2));
    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, delta(1));
    fake.emitEvent(streamId, terminal(3));

    const events = await collected;
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("drops events that arrive after the terminal", async () => {
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const collected = collect(run);
    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, terminal(1));
    fake.emitEvent(streamId, delta(2));

    const events = await collected;
    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
  });

  it("drops duplicate deliveries of an already-yielded sequence", async () => {
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const collected = collect(run);
    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, terminal(1));

    const events = await collected;
    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
  });

  it("passes an unrecognized event type through without terminating the run", async () => {
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const future: StreamEvent = {
      schemaVersion: "1.0",
      runId: "run_1",
      sequence: 1,
      timestamp: 1_700_000_000_001,
      type: "some_future_type",
      payload: { somethingNew: true }
    };

    const collected = collect(run);
    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, future);
    fake.emitEvent(streamId, terminal(2));

    const events = await collected;
    expect(events.map((event) => event.type)).toEqual([
      "content_delta",
      "some_future_type",
      "terminal"
    ]);
  });

  it("delivers a terminal error outcome as an event rather than rejecting", async () => {
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const collected = collect(run);
    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, terminal(1, "error"));

    const events = await collected;
    const last = events[events.length - 1];
    expect(last.type).toBe("terminal");
    expect((last.payload as { outcome: string }).outcome).toBe("error");
  });

  it("throws the normalized error when the bridge reports a transport failure", async () => {
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const collected = collect(run);
    fake.emitEvent(streamId, delta(0));
    fake.emitError(streamId, {
      schemaVersion: "1.0",
      errorClass: "Internal",
      message: "Native pump failed."
    });

    await expect(collected).rejects.toMatchObject({
      errorClass: "Internal",
      message: "Native pump failed."
    });
  });

  it("fails with an Internal error when a sequence gap never closes", async () => {
    vi.useFakeTimers();
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const seen: StreamEvent[] = [];
    const collected = (async () => {
      for await (const event of run.events) {
        seen.push(event);
      }
    })();
    // Attach the rejection handler before the grace timer fires, or the rejection
    // is briefly unhandled and Vitest reports it as an unhandled error.
    const rejects = expect(collected).rejects.toMatchObject({
      errorClass: "Internal",
      message: "Capacitor bridge lost 1 stream event(s) for run run_1.",
      runId: "run_1"
    });

    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, terminal(2));
    await vi.advanceTimersByTimeAsync(250);

    await rejects;
    // The terminal is withheld: it would assert an ending the sequence cannot support.
    expect(seen.map((event) => event.sequence)).toEqual([0]);
  });

  it("recovers when the missing event arrives within the grace window", async () => {
    vi.useFakeTimers();
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const collected = collect(run);
    fake.emitEvent(streamId, delta(0));
    fake.emitEvent(streamId, terminal(2));
    await vi.advanceTimersByTimeAsync(100);
    fake.emitEvent(streamId, delta(1));
    await vi.advanceTimersByTimeAsync(500);

    const events = await collected;
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it("unwraps a Capacitor rejection envelope from startStream", async () => {
    const fake = createFakePlugin();
    fake.startStream.mockRejectedValue({
      message: "CapacitorException",
      data: {
        schemaVersion: "1.0",
        errorClass: "CapabilityMismatch",
        message: "No streaming-capable provider."
      }
    });

    await expect(startCapacitorStream(fake.plugin, REQUEST)).rejects.toMatchObject({
      errorClass: "CapabilityMismatch",
      message: "No streaming-capable provider."
    });
  });

  it("releases its listeners when startStream rejects", async () => {
    const fake = createFakePlugin();
    fake.startStream.mockRejectedValue({
      data: { schemaVersion: "1.0", errorClass: "Internal", message: "nope" }
    });

    await expect(startCapacitorStream(fake.plugin, REQUEST)).rejects.toBeDefined();
    await vi.waitFor(() => {
      expect(fake.removes).toHaveLength(2);
      expect(fake.removes.every((remove) => remove.mock.calls.length === 1)).toBe(true);
    });
  });

  it("rejects a malformed handle from the native plugin", async () => {
    const fake = createFakePlugin();
    fake.startStream.mockResolvedValue({ runId: "run_1" });

    await expect(startCapacitorStream(fake.plugin, REQUEST)).rejects.toMatchObject({
      errorClass: "Internal"
    });
  });

  it("treats events as single-use across repeated iteration", async () => {
    const fake = createFakePlugin();
    const run = await startCapacitorStream(fake.plugin, REQUEST);
    const streamId = fake.lastStreamId();

    const collected = collect(run);
    fake.emitEvent(streamId, terminal(0));
    await collected;

    await expect(collect(run)).resolves.toEqual([]);
  });

  describe("cancellation", () => {
    it("cancels before any event has arrived", async () => {
      const fake = createFakePlugin();
      const run = await startCapacitorStream(fake.plugin, REQUEST);
      const streamId = fake.lastStreamId();

      const collected = collect(run);
      run.cancel("user navigated away");
      fake.emitEvent(streamId, terminal(0, "cancelled"));

      const events = await collected;
      expect(fake.cancelStream).toHaveBeenCalledWith({
        streamId,
        reason: "user navigated away"
      });
      expect(events).toHaveLength(1);
      expect((events[0].payload as { outcome: string }).outcome).toBe("cancelled");
    });

    it("omits the reason key entirely when none is given", async () => {
      const fake = createFakePlugin();
      const run = await startCapacitorStream(fake.plugin, REQUEST);
      const streamId = fake.lastStreamId();

      const collected = collect(run);
      run.cancel();
      fake.emitEvent(streamId, terminal(0, "cancelled"));
      await collected;

      expect(fake.cancelStream).toHaveBeenCalledWith({ streamId });
      expect(fake.cancelStream.mock.calls[0][0]).not.toHaveProperty("reason");
    });

    it("delivers buffered deltas and then the cancelled terminal", async () => {
      const fake = createFakePlugin();
      const run = await startCapacitorStream(fake.plugin, REQUEST);
      const streamId = fake.lastStreamId();

      const collected = collect(run);
      fake.emitEvent(streamId, delta(0));
      fake.emitEvent(streamId, delta(1));
      run.cancel();
      fake.emitEvent(streamId, terminal(2, "cancelled"));

      const events = await collected;
      expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    });

    it("is idempotent across repeated calls", async () => {
      const fake = createFakePlugin();
      const run = await startCapacitorStream(fake.plugin, REQUEST);
      const streamId = fake.lastStreamId();

      const collected = collect(run);
      run.cancel();
      run.cancel("again");
      fake.emitEvent(streamId, terminal(0, "cancelled"));
      await collected;

      expect(fake.cancelStream).toHaveBeenCalledTimes(1);
    });

    it("does not cross the bridge when cancelled after the terminal", async () => {
      const fake = createFakePlugin();
      const run = await startCapacitorStream(fake.plugin, REQUEST);
      const streamId = fake.lastStreamId();

      const collected = collect(run);
      fake.emitEvent(streamId, terminal(0));
      await collected;

      run.cancel("too late");
      expect(fake.cancelStream).not.toHaveBeenCalled();
    });

    it("surfaces a cancelStream rejection through the iterable", async () => {
      const fake = createFakePlugin();
      fake.cancelStream.mockRejectedValue({
        data: { schemaVersion: "1.0", errorClass: "Internal", message: "cancel failed" }
      });
      const run = await startCapacitorStream(fake.plugin, REQUEST);

      const collected = collect(run);
      const rejects = expect(collected).rejects.toMatchObject({
        errorClass: "Internal",
        message: "cancel failed"
      });
      run.cancel();

      await rejects;
    });

    it("cancels and releases when the consumer abandons the loop", async () => {
      const fake = createFakePlugin();
      const run = await startCapacitorStream(fake.plugin, REQUEST);
      const streamId = fake.lastStreamId();

      const iteration = (async () => {
        for await (const event of run.events) {
          void event;
          break;
        }
      })();
      fake.emitEvent(streamId, delta(0));
      await iteration;

      expect(fake.cancelStream).toHaveBeenCalledWith({ streamId });
      await vi.waitFor(() => {
        expect(fake.removes.every((remove) => remove.mock.calls.length === 1)).toBe(true);
      });
    });
  });

  describe("isolation and listener lifecycle", () => {
    it("keeps two concurrent runs separate", async () => {
      const fake = createFakePlugin();
      fake.startStream
        .mockResolvedValueOnce(handleFor("run_1"))
        .mockResolvedValueOnce(handleFor("run_2"));

      const first = await startCapacitorStream(fake.plugin, REQUEST);
      const firstId = fake.lastStreamId();
      const second = await startCapacitorStream(fake.plugin, REQUEST);
      const secondId = fake.lastStreamId();
      expect(firstId).not.toBe(secondId);

      const firstEvents = collect(first);
      const secondEvents = collect(second);

      fake.emitEvent(firstId, delta(0, "run_1"));
      fake.emitEvent(secondId, delta(0, "run_2"));
      fake.emitEvent(secondId, terminal(1, "completed", "run_2"));
      fake.emitEvent(firstId, terminal(1, "completed", "run_1"));

      expect((await firstEvents).every((event) => event.runId === "run_1")).toBe(true);
      expect((await secondEvents).every((event) => event.runId === "run_2")).toBe(true);
    });

    it("drops an event whose runId does not match its handle", async () => {
      const fake = createFakePlugin();
      const run = await startCapacitorStream(fake.plugin, REQUEST);
      const streamId = fake.lastStreamId();

      const collected = collect(run);
      fake.emitEvent(streamId, delta(0, "run_other"));
      fake.emitEvent(streamId, delta(0, "run_1"));
      fake.emitEvent(streamId, terminal(1, "completed", "run_1"));

      const events = await collected;
      expect(events.every((event) => event.runId === "run_1")).toBe(true);
      expect(events).toHaveLength(2);
    });

    it("registers listeners once for concurrent runs and removes them once at the end", async () => {
      const fake = createFakePlugin();
      fake.startStream
        .mockResolvedValueOnce(handleFor("run_1"))
        .mockResolvedValueOnce(handleFor("run_2"));

      const first = await startCapacitorStream(fake.plugin, REQUEST);
      const firstId = fake.lastStreamId();
      const second = await startCapacitorStream(fake.plugin, REQUEST);
      const secondId = fake.lastStreamId();

      expect(fake.addListener).toHaveBeenCalledTimes(2);

      const firstEvents = collect(first);
      fake.emitEvent(firstId, terminal(0, "completed", "run_1"));
      await firstEvents;

      // One run is still live, so the listeners must stay attached.
      expect(fake.removes.every((remove) => remove.mock.calls.length === 0)).toBe(true);

      const secondEvents = collect(second);
      fake.emitEvent(secondId, terminal(0, "completed", "run_2"));
      await secondEvents;

      await vi.waitFor(() => {
        expect(fake.removes).toHaveLength(2);
        expect(fake.removes.every((remove) => remove.mock.calls.length === 1)).toBe(true);
      });
    });

    it("re-registers listeners for a run started after the previous one finished", async () => {
      const fake = createFakePlugin();
      const first = await startCapacitorStream(fake.plugin, REQUEST);
      const firstId = fake.lastStreamId();
      const firstEvents = collect(first);
      fake.emitEvent(firstId, terminal(0));
      await firstEvents;

      await vi.waitFor(() => {
        expect(fake.removes).toHaveLength(2);
      });

      const second = await startCapacitorStream(fake.plugin, REQUEST);
      const secondId = fake.lastStreamId();
      const secondEvents = collect(second);
      fake.emitEvent(secondId, terminal(0));
      await secondEvents;

      expect(fake.addListener).toHaveBeenCalledTimes(4);
    });

    it("ignores a notification for an unknown streamId", async () => {
      const fake = createFakePlugin();
      const run = await startCapacitorStream(fake.plugin, REQUEST);
      const streamId = fake.lastStreamId();

      const collected = collect(run);
      // A retained notification replayed for a run that has already gone away.
      fake.emitEvent("stream_does_not_exist", delta(0));
      fake.emitError("stream_does_not_exist", {
        schemaVersion: "1.0",
        errorClass: "Internal",
        message: "stale"
      });
      fake.emitEvent(streamId, terminal(0));

      await expect(collected).resolves.toHaveLength(1);
    });
  });
});
