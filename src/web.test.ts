import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamRunHandle, TaskResult } from "@independo/inderun-contracts";
import { validateStreamEvent } from "@independo/inderun-contracts";
import { IndeRunException } from "@independo/inderun-web";

const { createIndeRunWebMock } = vi.hoisted(() => ({
  createIndeRunWebMock: vi.fn()
}));

vi.mock("@independo/inderun-web", async () => {
  const actual =
    await vi.importActual<typeof import("@independo/inderun-web")>("@independo/inderun-web");
  return {
    ...actual,
    createIndeRunWeb: createIndeRunWebMock
  };
});

import { IndeRunCapacitor } from "./index.js";
import { IndeRunWeb } from "./web.js";

describe("IndeRunWeb", () => {
  beforeEach(() => {
    createIndeRunWebMock.mockReset();
  });

  it("delegates run() to the web SDK with the provided bootstrap options", async () => {
    const result: TaskResult = {
      schemaVersion: "1.0",
      runId: "run_123",
      finishReason: "stop",
      output: { type: "text", text: "Thin wrapper." },
      telemetry: { providerUsed: "openai", totalMs: 12 }
    };

    const runMock = vi.fn().mockResolvedValue(result);
    createIndeRunWebMock.mockReturnValue({ run: runMock });

    const plugin = new IndeRunWeb();
    const request = {
      schemaVersion: "1.0" as const,
      task: { kind: "text_to_text" as const },
      prompt: "Hello"
    };

    await expect(
      plugin.configure({
        openAI: {
          model: "gpt-5.2",
          endpointUrl: "/api/inderun/openai-responses",
          auth: "none"
        }
      })
    ).resolves.toBeUndefined();

    await expect(plugin.run(request)).resolves.toEqual(result);

    expect(createIndeRunWebMock).toHaveBeenCalledOnce();
    const webCallArg = createIndeRunWebMock.mock.calls[0][0] as Record<string, unknown>;
    // compactOpenAIOptions() must omit absent optional fields entirely (not set them to undefined)
    expect(webCallArg).toStrictEqual({
      openAI: {
        model: "gpt-5.2",
        endpointUrl: "/api/inderun/openai-responses",
        auth: "none"
      }
    });
    expect(webCallArg).not.toHaveProperty("allowDirectOpenAIEndpoint");
    expect(webCallArg["openAI"] as Record<string, unknown>).not.toHaveProperty("authContextRef");
    expect(webCallArg["openAI"] as Record<string, unknown>).not.toHaveProperty("timeoutMs");
    expect(runMock).toHaveBeenCalledWith(request);
  });

  it("returns a normalized contract error when web provider registration is missing", async () => {
    const plugin = new IndeRunWeb();

    await expect(plugin.configure()).rejects.toMatchObject({
      schemaVersion: "1.0",
      errorClass: "Unavailable"
    });
  });

  it("returns a normalized contract error when run() is called before configure()", async () => {
    const plugin = new IndeRunWeb();

    await expect(
      plugin.run({
        schemaVersion: "1.0",
        task: { kind: "text_to_text" },
        prompt: "Hello"
      })
    ).rejects.toMatchObject({
      schemaVersion: "1.0",
      errorClass: "Unavailable"
    });
  });

  it("normalizes plugin rejection data exposed by the Capacitor facade", async () => {
    createIndeRunWebMock.mockReturnValue({
      run: vi.fn().mockRejectedValue(
        new IndeRunException({
          errorClass: "AuthError",
          message: "Missing authContextRef."
        })
      )
    });

    await IndeRunCapacitor.configure({
      openAI: {
        model: "gpt-5.2"
      }
    });

    await expect(
      IndeRunCapacitor.run({
        schemaVersion: "1.0",
        task: { kind: "text_to_text" },
        prompt: "Hello"
      })
    ).rejects.toMatchObject({
      schemaVersion: "1.0",
      errorClass: "AuthError",
      message: "Missing authContextRef."
    });
  });

  describe("streaming", () => {
    const handle: StreamRunHandle = {
      schemaVersion: "1.0",
      runId: "run_web",
      startedAt: 1_700_000_000_000
    };

    function terminalEvent(sequence: number, outcome: "completed" | "cancelled"): StreamEvent {
      return {
        schemaVersion: "1.0",
        runId: "run_web",
        sequence,
        timestamp: 1_700_000_000_000 + sequence,
        type: "terminal",
        payload:
          outcome === "completed"
            ? { schemaVersion: "1.0", runId: "run_web", outcome, finalText: "done" }
            : { schemaVersion: "1.0", runId: "run_web", outcome, partialText: "part" }
      };
    }

    /** A stand-in for the engine's StreamRun that the test drives by hand. */
    function createControllableRun() {
      const queue: StreamEvent[] = [];
      let wake: (() => void) | null = null;
      let done = false;
      let failure: unknown = null;

      function signal(): void {
        const resume = wake;
        wake = null;
        resume?.();
      }

      async function* drive(): AsyncGenerator<StreamEvent> {
        for (;;) {
          while (queue.length > 0) {
            yield queue.shift() as StreamEvent;
          }
          if (failure !== null) {
            throw failure;
          }
          if (done) {
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }

      const cancel = vi.fn();
      return {
        run: { handle, events: drive(), cancel },
        cancel,
        push(event: StreamEvent): void {
          queue.push(event);
          signal();
        },
        finish(): void {
          done = true;
          signal();
        },
        fail(error: unknown): void {
          failure = error;
          signal();
        }
      };
    }

    async function configuredPlugin(stream: unknown): Promise<IndeRunWeb> {
      createIndeRunWebMock.mockReturnValue({ run: vi.fn(), stream });
      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { model: "gpt-5.2" } });
      return plugin;
    }

    it("delegates startStream() to the web SDK and returns its handle unchanged", async () => {
      const controllable = createControllableRun();
      const streamMock = vi.fn().mockResolvedValue(controllable.run);
      const plugin = await configuredPlugin(streamMock);

      const request = {
        schemaVersion: "1.0" as const,
        task: { kind: "text_to_text" as const },
        prompt: "Hello"
      };

      await expect(plugin.startStream({ streamId: "s1", request })).resolves.toBe(handle);
      expect(streamMock).toHaveBeenCalledWith(request);
    });

    it("notifies listeners with the engine's canonical event, unmodified", async () => {
      const controllable = createControllableRun();
      const plugin = await configuredPlugin(vi.fn().mockResolvedValue(controllable.run));

      const notifications: { streamId: string; event: StreamEvent }[] = [];
      await plugin.addListener("indeRunStreamEvent", (notification) => {
        notifications.push(notification as { streamId: string; event: StreamEvent });
      });

      await plugin.startStream({
        streamId: "s1",
        request: { schemaVersion: "1.0", task: { kind: "text_to_text" }, prompt: "Hello" }
      });

      const event: StreamEvent = {
        schemaVersion: "1.0",
        runId: "run_web",
        sequence: 0,
        timestamp: 1_700_000_000_000,
        type: "content_delta",
        payload: { text: "hi" }
      };
      controllable.push(event);
      controllable.push(terminalEvent(1, "completed"));
      controllable.finish();

      await vi.waitFor(() => {
        expect(notifications).toHaveLength(2);
      });
      expect(notifications[0].streamId).toBe("s1");
      // The same object the engine produced, not a re-serialized copy.
      expect(notifications[0].event).toBe(event);
      expect(notifications.every((entry) => validateStreamEvent(entry.event))).toBe(true);
    });

    it("returns a normalized contract error when startStream() is called before configure()", async () => {
      const plugin = new IndeRunWeb();

      await expect(
        plugin.startStream({
          streamId: "s1",
          request: { schemaVersion: "1.0", task: { kind: "text_to_text" }, prompt: "Hello" }
        })
      ).rejects.toMatchObject({ schemaVersion: "1.0", errorClass: "Unavailable" });
    });

    it("maps a route-selection failure to a contract error", async () => {
      const plugin = await configuredPlugin(
        vi.fn().mockRejectedValue(
          new IndeRunException({
            errorClass: "CapabilityMismatch",
            message: "No streaming-capable provider."
          })
        )
      );

      await expect(
        plugin.startStream({
          streamId: "s1",
          request: { schemaVersion: "1.0", task: { kind: "text_to_text" }, prompt: "Hello" }
        })
      ).rejects.toMatchObject({
        schemaVersion: "1.0",
        errorClass: "CapabilityMismatch"
      });
    });

    it("cancels through the engine without abandoning the event generator", async () => {
      const controllable = createControllableRun();
      const plugin = await configuredPlugin(vi.fn().mockResolvedValue(controllable.run));

      const notifications: { event: StreamEvent }[] = [];
      await plugin.addListener("indeRunStreamEvent", (notification) => {
        notifications.push(notification as { event: StreamEvent });
      });

      await plugin.startStream({
        streamId: "s1",
        request: { schemaVersion: "1.0", task: { kind: "text_to_text" }, prompt: "Hello" }
      });

      await plugin.cancelStream({ streamId: "s1", reason: "user cancelled" });
      expect(controllable.cancel).toHaveBeenCalledWith("user cancelled");

      // The engine must still be able to deliver its one cancelled terminal.
      controllable.push(terminalEvent(0, "cancelled"));
      controllable.finish();

      await vi.waitFor(() => {
        expect(notifications).toHaveLength(1);
      });
      expect((notifications[0].event.payload as { outcome: string }).outcome).toBe("cancelled");
    });

    it("resolves cancelStream() for an unknown or already-finished run", async () => {
      const plugin = await configuredPlugin(vi.fn());

      await expect(plugin.cancelStream({ streamId: "never_started" })).resolves.toBeUndefined();
    });

    it("reports a pump failure as a stream error notification, not an unhandled rejection", async () => {
      const controllable = createControllableRun();
      const plugin = await configuredPlugin(vi.fn().mockResolvedValue(controllable.run));

      const errors: { streamId: string; error: { errorClass: string } }[] = [];
      await plugin.addListener("indeRunStreamError", (notification) => {
        errors.push(notification as { streamId: string; error: { errorClass: string } });
      });

      await plugin.startStream({
        streamId: "s1",
        request: { schemaVersion: "1.0", task: { kind: "text_to_text" }, prompt: "Hello" }
      });

      controllable.fail(new IndeRunException({ errorClass: "Internal", message: "pump blew up" }));

      await vi.waitFor(() => {
        expect(errors).toHaveLength(1);
      });
      expect(errors[0].streamId).toBe("s1");
      expect(errors[0].error.errorClass).toBe("Internal");
    });
  });
});
