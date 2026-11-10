import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IndeRunError,
  MediaArtifact,
  StreamEvent,
  StreamRunHandle,
  TaskResult
} from "@independo/inderun-contracts";
import type { ProviderCapabilitySnapshot } from "./definitions.js";

/**
 * The speech methods are the web SDK's facade over the bridge, so these tests mock the *native
 * plugin* — what `registerPlugin` hands back on iOS and Android — and run the real facade and
 * the real stream reassembly on top of it.
 */
const { nativePlugin } = vi.hoisted(() => {
  const listeners: { name: string; callback: (notification: unknown) => void }[] = [];
  const plugin = {
    listeners,
    configure: vi.fn(),
    run: vi.fn(),
    checkCapabilities: vi.fn(),
    startStream: vi.fn(),
    startPrepare: vi.fn(),
    cancelStream: vi.fn(),
    readArtifact: vi.fn(),
    disposeArtifact: vi.fn(),
    close: vi.fn(),
    addListener: vi.fn(async (name: string, callback: (notification: unknown) => void) => {
      const entry = { name, callback };
      listeners.push(entry);
      return {
        remove: vi.fn(async () => {
          listeners.splice(listeners.indexOf(entry), 1);
        })
      };
    }),
    removeAllListeners: vi.fn()
  };
  return { nativePlugin: plugin };
});

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => nativePlugin,
  WebPlugin: class {}
}));

const HANDLE: StreamRunHandle = {
  schemaVersion: "1.0",
  runId: "run_speak",
  startedAt: 1_700_000_000_000,
  providerId: "apple_system_speech"
};

const ARTIFACT: MediaArtifact = {
  id: "artifact_1",
  owner: "engine",
  lifetime: "until_disposed",
  mediaType: "audio/wav",
  byteLength: 4
};

function emit(streamId: string, event: StreamEvent): void {
  for (const listener of [...nativePlugin.listeners]) {
    if (listener.name === "indeRunStreamEvent") {
      listener.callback({ streamId, event });
    }
  }
}

function terminal(payload: Record<string, unknown>, sequence = 1): StreamEvent {
  return {
    schemaVersion: "1.0",
    runId: HANDLE.runId,
    sequence,
    timestamp: 1_700_000_000_000 + sequence,
    type: "terminal",
    payload: { schemaVersion: "1.0", runId: HANDLE.runId, ...payload }
  };
}

function started(): StreamEvent {
  return {
    schemaVersion: "1.0",
    runId: HANDLE.runId,
    sequence: 0,
    timestamp: 1_700_000_000_000,
    type: "lifecycle",
    payload: { phase: "started" }
  };
}

function lastStreamId(): string {
  const calls = nativePlugin.startStream.mock.calls;
  return (calls[calls.length - 1][0] as { streamId: string }).streamId;
}

/** Each test gets fresh modules: the stream dispatcher and the facade's lazy import are module state. */
async function freshIndex(): Promise<typeof import("./index.js")> {
  vi.resetModules();
  return import("./index.js");
}

describe("speech through the bridge", () => {
  beforeEach(() => {
    nativePlugin.listeners.length = 0;
    nativePlugin.configure.mockReset().mockResolvedValue(undefined);
    nativePlugin.run.mockReset();
    nativePlugin.checkCapabilities.mockReset();
    nativePlugin.startStream.mockReset().mockResolvedValue(HANDLE);
    nativePlugin.cancelStream.mockReset().mockResolvedValue(undefined);
    nativePlugin.readArtifact.mockReset();
  });

  describe("speak", () => {
    it("configures, then streams one playback request and settles on the terminal", async () => {
      const { createIndeRunCapacitor } = await freshIndex();
      const inderun = createIndeRunCapacitor({ systemSpeech: true });

      const playback = await inderun.speak({ text: "Der Bus kommt.", locale: "de-AT" });

      expect(nativePlugin.configure).toHaveBeenCalledWith({ systemSpeech: true });
      expect(nativePlugin.startStream).toHaveBeenCalledOnce();
      expect(nativePlugin.startStream.mock.calls[0][0]).toMatchObject({
        request: {
          schemaVersion: "1.0",
          task: { kind: "text_to_speech" },
          speech: { text: "Der Bus kommt.", locale: "de-AT" },
          delivery: { mode: "playback" }
        }
      });
      expect(playback.runId).toBe("run_speak");

      const streamId = lastStreamId();
      emit(streamId, started());
      emit(
        streamId,
        terminal({
          outcome: "completed",
          finishReason: "stop",
          output: {
            type: "playback",
            playback: { timing: { firstAudioMs: 120, durationMs: 900 } },
            speech: { locale: "de-AT", voice: { id: "voice.anna", name: "Anna" } }
          }
        })
      );

      await expect(playback.result).resolves.toMatchObject({
        runId: "run_speak",
        finishReason: "stop",
        timing: { firstAudioMs: 120, durationMs: 900 },
        speech: { locale: "de-AT", voice: { id: "voice.anna", name: "Anna" } },
        outcome: { outcome: "completed" }
      });
    });

    it("stops playback through cancelStream with the run's streamId", async () => {
      const { createIndeRunCapacitor } = await freshIndex();
      const inderun = createIndeRunCapacitor({ systemSpeech: true });

      const playback = await inderun.speak({ text: "Hallo", locale: "de-DE" });
      const streamId = lastStreamId();
      emit(streamId, started());

      playback.cancel("user stopped");
      expect(nativePlugin.cancelStream).toHaveBeenCalledWith({ streamId, reason: "user stopped" });

      // The engine owns the cancelled terminal; the bridge only delivers it.
      emit(streamId, terminal({ outcome: "cancelled", partialText: "" }, 1));
      await expect(playback.result).resolves.toMatchObject({
        finishReason: "cancelled",
        outcome: { outcome: "cancelled" }
      });
    });

    it("rejects the result with the run's error when the terminal is an error", async () => {
      const { createIndeRunCapacitor } = await freshIndex();
      const inderun = createIndeRunCapacitor({ systemSpeech: true });

      const playback = await inderun.speak({ text: "Hallo", locale: "de-DE" });
      const streamId = lastStreamId();
      emit(streamId, started());
      emit(
        streamId,
        terminal({
          outcome: "error",
          partialText: "",
          error: { schemaVersion: "1.0", errorClass: "Unavailable", message: "No voice." }
        })
      );

      const failure = await playback.result.catch((error: unknown) => error);
      // The fresh module graph's class, not one imported before vi.resetModules().
      const { IndeRunException } = await import("@independo/inderun-web");
      expect(failure).toBeInstanceOf(IndeRunException);
      expect(failure).toMatchObject({ errorClass: "Unavailable", message: "No voice." });
    });

    it("rejects with the normalized contract error when routing refuses the stream", async () => {
      const refusal: IndeRunError = {
        schemaVersion: "1.0",
        errorClass: "CapabilityMismatch",
        message: "No provider can speak de-AT."
      };
      nativePlugin.startStream.mockRejectedValue({ message: refusal.message, data: refusal });
      const { createIndeRunCapacitor } = await freshIndex();

      await expect(
        createIndeRunCapacitor({ systemSpeech: true }).speak({ text: "Servus", locale: "de-AT" })
      ).rejects.toEqual(refusal);
    });
  });

  describe("generateSpeech", () => {
    it("runs one artifact request and returns the facade's result, readable through readArtifact", async () => {
      const taskResult: TaskResult = {
        schemaVersion: "1.0",
        runId: "run_generate",
        finishReason: "stop",
        output: {
          type: "artifact",
          artifact: ARTIFACT,
          speech: { locale: "de-DE", voice: { id: "voice.anna" } }
        },
        telemetry: { providerUsed: "apple_system_speech", totalMs: 40 }
      };
      nativePlugin.run.mockResolvedValue(taskResult);
      // Native sends artifact bytes as base64.
      nativePlugin.readArtifact.mockResolvedValue({
        artifactId: ARTIFACT.id,
        offset: 0,
        bytes: "AAEC/w==",
        totalBytes: 4,
        done: true
      });
      const { createIndeRunCapacitor } = await freshIndex();
      const inderun = createIndeRunCapacitor({ systemSpeech: true });

      const generated = await inderun.generateSpeech({
        text: "Hallo",
        locale: "de-DE",
        mediaTypes: ["audio/wav"]
      });

      expect(nativePlugin.configure).toHaveBeenCalledOnce();
      expect(nativePlugin.run).toHaveBeenCalledWith({
        schemaVersion: "1.0",
        task: { kind: "text_to_speech" },
        speech: { text: "Hallo", locale: "de-DE" },
        delivery: { mode: "artifact", mediaTypes: ["audio/wav"] }
      });
      expect(generated).toEqual({
        artifact: ARTIFACT,
        speech: { locale: "de-DE", voice: { id: "voice.anna" } },
        finishReason: "stop",
        runId: "run_generate",
        taskResult
      });

      const chunk = await inderun.readArtifact({ artifactId: generated.artifact.id });
      expect(chunk.bytes).toEqual(new Uint8Array([0, 1, 2, 255]));
      expect(chunk.done).toBe(true);
    });

    it("rejects with the normalized contract error the native run rejected with", async () => {
      const refusal: IndeRunError = {
        schemaVersion: "1.0",
        errorClass: "CapabilityMismatch",
        message: "No provider writes audio/ogg."
      };
      nativePlugin.run.mockRejectedValue({ message: refusal.message, data: refusal });
      const { IndeRunCapacitor } = await freshIndex();

      await expect(
        IndeRunCapacitor.generateSpeech({ text: "Hallo", locale: "de-DE", mediaTypes: ["audio/ogg"] })
      ).rejects.toEqual(refusal);
    });
  });

  describe("listVoices", () => {
    const snapshots: ProviderCapabilitySnapshot[] = [
      {
        providerId: "apple_system_speech",
        descriptor: {
          id: "apple_system_speech",
          type: "local",
          transport: "system_service",
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
          tasks: ["text_to_speech"]
        },
        capabilities: {
          available: true,
          taskCapabilities: [
            {
              kind: "text_to_speech",
              voices: [
                { id: "voice.anna", name: "Anna", locale: "de-DE", gender: "female" },
                { id: "voice.daniel", name: "Daniel", locale: "en-GB", gender: "male" }
              ]
            }
          ]
        }
      },
      {
        providerId: "local.onnx.speech.apple:articulino",
        descriptor: {
          id: "local.onnx.speech.apple:articulino",
          type: "local",
          model: "articulino",
          transport: "in_process",
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
          tasks: ["text_to_speech"]
        },
        capabilities: {
          available: true,
          taskCapabilities: [
            {
              kind: "text_to_speech",
              readiness: "cold",
              voices: [{ id: "lena", name: "Lena", locale: "de-AT", readiness: "cold" }]
            }
          ]
        }
      }
    ];

    it("reads the unwrapped capability snapshots and filters by locale", async () => {
      nativePlugin.checkCapabilities.mockResolvedValue({ providers: snapshots });
      const { createIndeRunCapacitor } = await freshIndex();

      const voices = await createIndeRunCapacitor({ systemSpeech: true }).listVoices({ locale: "de" });

      expect(nativePlugin.configure).toHaveBeenCalledOnce();
      expect(voices).toEqual([
        {
          providerId: "apple_system_speech",
          kind: "platform",
          id: "voice.anna",
          name: "Anna",
          locale: "de-DE",
          gender: "female"
        },
        {
          providerId: "local.onnx.speech.apple:articulino",
          kind: "model",
          model: "articulino",
          id: "lena",
          name: "Lena",
          locale: "de-AT",
          readiness: "cold"
        }
      ]);
    });

    it("works on the plugin object as well, without configuring", async () => {
      nativePlugin.checkCapabilities.mockResolvedValue({ providers: snapshots });
      const { IndeRunCapacitor } = await freshIndex();

      const voices = await IndeRunCapacitor.listVoices();

      expect(nativePlugin.configure).not.toHaveBeenCalled();
      expect(voices.map((voice) => voice.id)).toEqual(["voice.anna", "voice.daniel", "lena"]);
    });
  });
});
