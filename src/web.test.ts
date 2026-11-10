import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamRunHandle, TaskResult } from "@independo/inderun-contracts";
import { validateStreamEvent } from "@independo/inderun-contracts";
import { IndeRunException, type IndeRunApi } from "@independo/inderun-web";

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

import { createIndeRunCapacitor, IndeRunCapacitor } from "./index.js";
import type { ProviderCapabilitySnapshot } from "./definitions.js";
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
      telemetry: { providerUsed: "openai:gpt-5.2", totalMs: 12 },
      // Passed through untouched, like every other field the engine returns.
      provenance: {
        schemaVersion: "1.0",
        modelProfile: "auto",
        providerId: "openai:gpt-5.2",
        locality: "cloud",
        configuredModel: "gpt-5.2",
        fallbackOccurred: false,
        attemptCount: 1,
        attempts: [{ providerId: "openai:gpt-5.2", outcome: "succeeded" }],
        routeRejections: []
      }
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
          models: ["gpt-5.2"],
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
        models: ["gpt-5.2"],
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

  it("still rejects an options object that registers no provider at all", async () => {
    const plugin = new IndeRunWeb();

    await expect(plugin.configure({})).rejects.toMatchObject({
      schemaVersion: "1.0",
      errorClass: "Unavailable"
    });
    expect(createIndeRunWebMock).not.toHaveBeenCalled();
  });

  it("registers the browser system-model provider on its own, without a cloud provider", async () => {
    createIndeRunWebMock.mockReturnValue({ run: vi.fn() });

    const plugin = new IndeRunWeb();
    await expect(plugin.configure({ systemModel: {} })).resolves.toBeUndefined();

    expect(createIndeRunWebMock).toHaveBeenCalledOnce();
    expect(createIndeRunWebMock.mock.calls[0][0]).toStrictEqual({ systemModel: {} });
  });

  it("forwards every configured web provider and omits the ones left out", async () => {
    createIndeRunWebMock.mockReturnValue({ run: vi.fn() });

    const plugin = new IndeRunWeb();
    await plugin.configure({
      openAI: { models: ["gpt-5.2"], auth: "none" },
      systemModel: { id: "local.system-model.web", timeoutMs: 30_000 },
      onnx: { modelPackage: { id: "demo", format: "onnx" } }
    });

    expect(createIndeRunWebMock.mock.calls[0][0]).toStrictEqual({
      openAI: { models: ["gpt-5.2"], auth: "none" },
      systemModel: { id: "local.system-model.web", timeoutMs: 30_000 },
      onnx: { modelPackage: { id: "demo", format: "onnx" } }
    });
  });

  it("forwards modelProfiles to the web SDK unchanged", async () => {
    createIndeRunWebMock.mockReturnValue({ run: vi.fn() });

    const plugin = new IndeRunWeb();
    await plugin.configure({
      openAI: { models: ["gpt-5.2", "gpt-5-mini"], auth: "none" },
      modelProfiles: { smart: ["openai:gpt-5.2"], fast: ["openai:gpt-5-mini"] }
    });

    expect(createIndeRunWebMock.mock.calls[0][0]).toStrictEqual({
      openAI: { models: ["gpt-5.2", "gpt-5-mini"], auth: "none" },
      modelProfiles: { smart: ["openai:gpt-5.2"], fast: ["openai:gpt-5-mini"] }
    });
  });

  it("rejects a configuration that redefines the built-in auto profile", async () => {
    const actual =
      await vi.importActual<typeof import("@independo/inderun-web")>("@independo/inderun-web");
    createIndeRunWebMock.mockImplementation(actual.createIndeRunWeb);

    const plugin = new IndeRunWeb();
    await expect(
      plugin.configure({
        openAI: { models: ["gpt-5.2"], endpointUrl: "/api/inderun/openai-responses", auth: "none" },
        modelProfiles: { auto: ["openai:gpt-5.2"] }
      })
    ).rejects.toMatchObject({ schemaVersion: "1.0", message: expect.stringContaining("auto") });
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
      ),
      // The facade shares one plugin across tests, so the next configure closes this engine.
      close: vi.fn()
    });

    await IndeRunCapacitor.configure({
      openAI: {
        models: ["gpt-5.2"]
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

  describe("checkCapabilities", () => {
    const snapshot: ProviderCapabilitySnapshot = {
      providerId: "openai",
      descriptor: {
        id: "openai",
        type: "cloud",
        transport: "http",
        streamingStyle: "tokens",
        supports: {
          run: true,
          streaming: true,
          realtime: false,
          tools: false,
          reasoningEvents: false,
          structuredOutput: false,
          multimodal: false
        },
        cancel: "hard",
        tasks: ["text_to_text"],
        privacy: { dataLeavesDevice: true }
      },
      capabilities: { available: true }
    };

    it("returns the SDK's snapshots verbatim inside the providers envelope", async () => {
      const checkCapabilitiesMock = vi.fn().mockResolvedValue([snapshot]);
      createIndeRunWebMock.mockReturnValue({
        checkCapabilities: checkCapabilitiesMock,
        close: vi.fn()
      });

      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      await expect(plugin.checkCapabilities()).resolves.toStrictEqual({ providers: [snapshot] });
      expect(checkCapabilitiesMock).toHaveBeenCalledOnce();
    });

    it("omits streamingAvailable rather than reporting it as null when the SDK leaves it unset", async () => {
      // Absence means "inherit descriptor.supports.streaming". A null would be a
      // third state the consumers do not have, which is why both native encoders
      // drop the key. The web path gets it for free; assert it anyway.
      createIndeRunWebMock.mockReturnValue({
        checkCapabilities: vi.fn().mockResolvedValue([snapshot])
      });

      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      const { providers } = await plugin.checkCapabilities();
      expect(providers[0].capabilities).not.toHaveProperty("streamingAvailable");
      expect(providers[0].capabilities).not.toHaveProperty("cancellationAvailable");
    });

    it("returns a normalized contract error when called before configure()", async () => {
      const plugin = new IndeRunWeb();

      await expect(plugin.checkCapabilities()).rejects.toMatchObject({
        schemaVersion: "1.0",
        errorClass: "Unavailable"
      });
    });

    it("normalizes a thrown SDK failure to a contract error", async () => {
      createIndeRunWebMock.mockReturnValue({
        checkCapabilities: vi.fn().mockRejectedValue(new Error("registry exploded"))
      });

      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      await expect(plugin.checkCapabilities()).rejects.toMatchObject({
        schemaVersion: "1.0",
        errorClass: "Internal"
      });
    });

    it("unwraps the envelope on the facade and configures exactly once per instance", async () => {
      const checkCapabilitiesMock = vi.fn().mockResolvedValue([snapshot]);
      createIndeRunWebMock.mockReturnValue({
        checkCapabilities: checkCapabilitiesMock,
        close: vi.fn()
      });

      const inderun = createIndeRunCapacitor({ openAI: { models: ["gpt-5.2"] } });

      await expect(inderun.checkCapabilities()).resolves.toStrictEqual([snapshot]);
      await expect(inderun.checkCapabilities()).resolves.toStrictEqual([snapshot]);

      expect(createIndeRunWebMock).toHaveBeenCalledOnce();
      expect(checkCapabilitiesMock).toHaveBeenCalledTimes(2);
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
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });
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

    it("delegates startPrepare() to the engine's prepare and delivers its events like a stream", async () => {
      const controllable = createControllableRun();
      const prepareMock = vi.fn().mockResolvedValue(controllable.run);
      createIndeRunWebMock.mockReturnValue({ prepare: prepareMock });
      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      const notifications: { streamId: string; event: StreamEvent }[] = [];
      await plugin.addListener("indeRunStreamEvent", (notification) => {
        notifications.push(notification as { streamId: string; event: StreamEvent });
      });

      const request = { tasks: ["text_to_speech"], allowDownload: true };
      await expect(plugin.startPrepare({ streamId: "p1", request })).resolves.toBe(handle);
      expect(prepareMock).toHaveBeenCalledWith(request);

      await plugin.cancelStream({ streamId: "p1", reason: "not now" });
      expect(controllable.cancel).toHaveBeenCalledWith("not now");

      controllable.push(terminalEvent(0, "cancelled"));
      controllable.finish();
      await vi.waitFor(() => {
        expect(notifications).toHaveLength(1);
      });
      expect(notifications[0].streamId).toBe("p1");
    });

    it("returns a normalized contract error when startPrepare() is called before configure()", async () => {
      const plugin = new IndeRunWeb();

      await expect(plugin.startPrepare({ streamId: "p1", request: {} })).rejects.toMatchObject({
        schemaVersion: "1.0",
        errorClass: "Unavailable"
      });
    });

    it("reassembles a prepare run on the facade, in sequence order", async () => {
      const controllable = createControllableRun();
      createIndeRunWebMock.mockReturnValue({
        prepare: vi.fn().mockResolvedValue(controllable.run),
        close: vi.fn()
      });

      const run = await createIndeRunCapacitor({ openAI: { models: ["gpt-5.2"] } }).prepare({});
      const progress: StreamEvent = {
        schemaVersion: "1.0",
        runId: "run_web",
        sequence: 0,
        timestamp: 1_700_000_000_000,
        type: "preparation_progress",
        payload: { providerId: "local.speech", task: "text_to_speech", fractionCompleted: 0.5 }
      };
      controllable.push(progress);
      controllable.push(terminalEvent(1, "completed"));
      controllable.finish();

      const events: StreamEvent[] = [];
      for await (const event of run.events) {
        events.push(event);
      }
      expect(events.map((event) => event.type)).toEqual(["preparation_progress", "terminal"]);
      expect(run.handle).toEqual(handle);
    });
  });

  describe("engine lifecycle and artifacts", () => {
    const artifact = {
      id: "artifact_1",
      owner: "engine" as const,
      lifetime: "until_disposed" as const,
      mediaType: "audio/wav"
    };

    it("closes the previous engine when configure() builds a new one", async () => {
      const firstClose = vi.fn().mockResolvedValue(undefined);
      const secondRun = vi.fn().mockResolvedValue({ runId: "second" });
      createIndeRunWebMock
        .mockReturnValueOnce({ close: firstClose })
        .mockReturnValueOnce({ run: secondRun, close: vi.fn() });
      const plugin = new IndeRunWeb();

      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });
      expect(firstClose).not.toHaveBeenCalled();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });
      expect(firstClose).toHaveBeenCalledOnce();

      await expect(
        plugin.run({ schemaVersion: "1.0", task: { kind: "text_to_text" }, prompt: "Hello" })
      ).resolves.toEqual({ runId: "second" });
    });

    it("keeps the previous engine when a new configuration is refused", async () => {
      const close = vi.fn();
      createIndeRunWebMock.mockReturnValue({ close });
      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      await expect(plugin.configure({})).rejects.toMatchObject({ errorClass: "Unavailable" });
      expect(close).not.toHaveBeenCalled();
    });

    it("returns the engine's chunk from readArtifact() with its bytes untouched", async () => {
      const chunk = {
        artifactId: "artifact_1",
        offset: 0,
        bytes: new Uint8Array([1, 2, 3]),
        totalBytes: 3,
        done: true
      };
      const readArtifact = vi.fn().mockResolvedValue(chunk);
      createIndeRunWebMock.mockReturnValue({ readArtifact });
      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      await expect(plugin.readArtifact({ artifactId: "artifact_1" })).resolves.toBe(chunk);
      expect(readArtifact).toHaveBeenCalledWith({ artifactId: "artifact_1" });
    });

    it("maps a readArtifact() failure to a contract error", async () => {
      createIndeRunWebMock.mockReturnValue({
        readArtifact: vi.fn().mockRejectedValue(
          new IndeRunException({
            errorClass: "Unavailable",
            message: "No such artifact.",
            details: { code: "artifact_not_found" }
          })
        )
      });
      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      await expect(plugin.readArtifact({ artifactId: "gone" })).rejects.toMatchObject({
        schemaVersion: "1.0",
        errorClass: "Unavailable",
        details: { code: "artifact_not_found" }
      });
    });

    it("forwards disposeArtifact() and close() to the engine", async () => {
      const disposeArtifact = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn().mockResolvedValue(undefined);
      createIndeRunWebMock.mockReturnValue({ disposeArtifact, close });
      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      await plugin.disposeArtifact(artifact);
      expect(disposeArtifact).toHaveBeenCalledWith(artifact);

      await plugin.close();
      expect(close).toHaveBeenCalledOnce();
    });

    it("keeps the closed engine, so later calls fail the way the engine fails them", async () => {
      const engineClosed = new IndeRunException({
        errorClass: "Unavailable",
        message: "The engine is closed.",
        details: { code: "engine_closed" }
      });
      const run = vi.fn().mockRejectedValue(engineClosed);
      createIndeRunWebMock.mockReturnValue({ run, close: vi.fn() });
      const plugin = new IndeRunWeb();
      await plugin.configure({ openAI: { models: ["gpt-5.2"] } });

      await plugin.close();
      await expect(
        plugin.run({ schemaVersion: "1.0", task: { kind: "text_to_text" }, prompt: "Hello" })
      ).rejects.toMatchObject({ errorClass: "Unavailable", details: { code: "engine_closed" } });
      expect(run).toHaveBeenCalledOnce();
    });

    it("resolves close() on a plugin that was never configured", async () => {
      await expect(new IndeRunWeb().close()).resolves.toBeUndefined();
    });

    it("decodes a base64 chunk on the facade and passes a Uint8Array through", async () => {
      const readArtifact = vi
        .fn()
        // What native resolves: bytes as base64 over the JSON hop.
        .mockResolvedValueOnce({
          artifactId: "artifact_1",
          offset: 0,
          bytes: "AAEC/w==",
          totalBytes: 4,
          done: true
        })
        // What the web plugin resolves: the engine's bytes as they are.
        .mockResolvedValueOnce({
          artifactId: "artifact_1",
          offset: 0,
          bytes: new Uint8Array([9]),
          totalBytes: 1,
          done: true
        });
      createIndeRunWebMock.mockReturnValue({ readArtifact, close: vi.fn() });
      const inderun = createIndeRunCapacitor({ openAI: { models: ["gpt-5.2"] } });

      const decoded = await inderun.readArtifact({ artifactId: "artifact_1" });
      expect(decoded).toStrictEqual({
        artifactId: "artifact_1",
        offset: 0,
        bytes: new Uint8Array([0, 1, 2, 255]),
        totalBytes: 4,
        done: true
      });
      const passed = await inderun.readArtifact({ artifactId: "artifact_1" });
      expect(passed.bytes).toStrictEqual(new Uint8Array([9]));
    });

    it("does not configure an instance just to close it", async () => {
      const inderun = createIndeRunCapacitor({ openAI: { models: ["gpt-5.2"] } });

      await expect(inderun.close()).resolves.toBeUndefined();
      expect(createIndeRunWebMock).not.toHaveBeenCalled();
    });

    it("closes a configured instance, which then stays closed", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      const checkCapabilities = vi.fn().mockResolvedValue([]);
      createIndeRunWebMock.mockReturnValue({ checkCapabilities, close });
      const inderun = createIndeRunCapacitor({ openAI: { models: ["gpt-5.2"] } });

      await inderun.checkCapabilities();
      await inderun.close();
      expect(close).toHaveBeenCalledOnce();

      // Not reconfigured: the call reaches the closed engine.
      await expect(inderun.checkCapabilities()).resolves.toEqual([]);
      expect(createIndeRunWebMock).toHaveBeenCalledOnce();
    });

    it("can be handed to the web SDK as an IndeRunApi", async () => {
      const disposeArtifact = vi.fn().mockResolvedValue(undefined);
      createIndeRunWebMock.mockReturnValue({ disposeArtifact, close: vi.fn() });

      // The assignment is what matters; index.ts holds the compile-time guard, since
      // `pnpm lint` does not type-check test files.
      const api: IndeRunApi = createIndeRunCapacitor({ openAI: { models: ["gpt-5.2"] } });
      await api.disposeArtifact(artifact);

      expect(disposeArtifact).toHaveBeenCalledWith(artifact);
    });
  });
});
