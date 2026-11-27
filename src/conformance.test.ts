import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndeRunError, StreamRunHandle } from "@independo/inderun-contracts";

/**
 * Task-contract conformance: the vendored `text-to-speech.json` fixture (see
 * `test-fixtures/task-contracts/README.md` for its provenance) through the bridge's JS entry
 * points, against a mocked native plugin. Every current case is dispatched; everything else is
 * refused with the normalized validation error before native code is reached.
 */
const { nativePlugin } = vi.hoisted(() => ({
  nativePlugin: {
    configure: vi.fn(),
    run: vi.fn(),
    checkCapabilities: vi.fn(),
    startStream: vi.fn(),
    startPrepare: vi.fn(),
    cancelStream: vi.fn(),
    readArtifact: vi.fn(),
    disposeArtifact: vi.fn(),
    close: vi.fn(),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    removeAllListeners: vi.fn()
  }
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => nativePlugin,
  WebPlugin: class {}
}));

interface FixtureEntry {
  id: string;
  description: string;
  request: unknown;
}
const fixture = JSON.parse(
  readFileSync(new URL("../test-fixtures/task-contracts/text-to-speech.json", import.meta.url), "utf8")
) as { cases: FixtureEntry[]; invalidRequests: FixtureEntry[]; invalidPayloads: FixtureEntry[] };

const HANDLE: StreamRunHandle = {
  schemaVersion: "1.1",
  runId: "run_conformance",
  startedAt: 1_700_000_000_000
};

function noNativeCall(): void {
  for (const name of ["run", "startStream", "startPrepare"] as const) {
    expect(nativePlugin[name]).not.toHaveBeenCalled();
  }
}

async function refusal(promise: Promise<unknown>): Promise<IndeRunError> {
  try {
    await promise;
  } catch (error) {
    return error as IndeRunError;
  }
  throw new Error("expected the call to be refused");
}

describe("text-to-speech task contract", () => {
  beforeEach(() => {
    for (const mock of [nativePlugin.run, nativePlugin.startStream, nativePlugin.configure]) {
      mock.mockReset();
    }
    nativePlugin.run.mockResolvedValue({ schemaVersion: "1.1" });
    nativePlugin.startStream.mockResolvedValue(HANDLE);
    nativePlugin.configure.mockResolvedValue(undefined);
    nativePlugin.addListener.mockClear();
  });

  it("vendors a non-empty fixture", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(fixture.invalidRequests.length).toBeGreaterThan(0);
    expect(fixture.invalidPayloads.length).toBeGreaterThan(0);
  });

  describe.each(fixture.cases.map((entry) => [entry.id, entry] as const))("current case %s", (_id, entry) => {
    it("is dispatched by run()", async () => {
      const { IndeRunCapacitor } = await import("./index.js");
      await IndeRunCapacitor.run(entry.request as never);
      expect(nativePlugin.run).toHaveBeenCalledExactlyOnceWith(entry.request);
    });

    it("is dispatched by startStream() and stream()", async () => {
      const { IndeRunCapacitor } = await import("./index.js");
      await IndeRunCapacitor.startStream({ streamId: "s1", request: entry.request as never });
      await IndeRunCapacitor.stream(entry.request as never);
      expect(nativePlugin.startStream).toHaveBeenCalledTimes(2);
      expect(nativePlugin.startStream.mock.calls[0][0].request).toEqual(entry.request);
      expect(nativePlugin.startStream.mock.calls[1][0].request).toEqual(entry.request);
    });
  });

  const refused = [...fixture.invalidRequests, ...fixture.invalidPayloads];
  describe.each(refused.map((entry) => [entry.id, entry] as const))("refused entry %s", (_id, entry) => {
    it("is refused by run() before native dispatch", async () => {
      const { IndeRunCapacitor } = await import("./index.js");
      const error = await refusal(IndeRunCapacitor.run(entry.request as never));
      expect(error.schemaVersion).toBe("1.1");
      expect(error.errorClass).toBe("Internal");
      expect(error.message).toMatch(/^Validation failed for TaskRequest: /);
      expect(error.details?.validationIssues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: expect.any(String), message: expect.any(String) })])
      );
      noNativeCall();
    });

    it("is refused by startStream() and stream() before native dispatch", async () => {
      const { IndeRunCapacitor } = await import("./index.js");
      const low = await refusal(IndeRunCapacitor.startStream({ streamId: "s1", request: entry.request as never }));
      const high = await refusal(IndeRunCapacitor.stream(entry.request as never));
      for (const error of [low, high]) {
        expect(error.errorClass).toBe("Internal");
        expect(error.details?.validationIssues).toBeDefined();
      }
      noNativeCall();
    });

    it("is refused through a configured instance, without reaching run or startStream", async () => {
      const { createIndeRunCapacitor } = await import("./index.js");
      const inderun = createIndeRunCapacitor();
      await refusal(inderun.run(entry.request as never));
      await refusal(inderun.stream(entry.request as never));
      noNativeCall();
    });
  });

  it("refuses a request that is not an object", async () => {
    const { IndeRunCapacitor } = await import("./index.js");
    for (const bad of [null, undefined, "text", 3]) {
      const error = await refusal(IndeRunCapacitor.run(bad as never));
      expect(error.errorClass).toBe("Internal");
    }
    noNativeCall();
  });
});

describe("speech facade over the validating bridge", () => {
  beforeEach(() => {
    nativePlugin.run.mockReset().mockResolvedValue({ schemaVersion: "1.1" });
    nativePlugin.startStream.mockReset().mockResolvedValue(HANDLE);
    nativePlugin.configure.mockReset().mockResolvedValue(undefined);
    nativePlugin.checkCapabilities.mockReset();
  });

  it("refuses a playback control passed to generateSpeech by a JS caller, rather than dropping it", async () => {
    const { createIndeRunCapacitor } = await import("./index.js");
    const inderun = createIndeRunCapacitor({ systemSpeech: true });
    const error = await refusal(
      inderun.generateSpeech({
        text: "Hallo",
        locale: "de-AT",
        playback: { volume: { value: 0.5, requirement: "preferred" } }
      } as never)
    );
    expect(error.errorClass).toBe("Internal");
    expect(error.details?.validationIssues).toBeDefined();
    expect(nativePlugin.run).not.toHaveBeenCalled();
  });

  it("dispatches speak() with rate, pitch and volume controls intact", async () => {
    const { createIndeRunCapacitor } = await import("./index.js");
    const inderun = createIndeRunCapacitor({ systemSpeech: true });
    await inderun.speak({
      text: "Hallo",
      locale: "de-AT",
      controls: {
        speakingRate: { value: 1.2, requirement: "required" },
        pitch: { value: 1, requirement: "preferred" }
      },
      playback: { volume: { value: 0.5, requirement: "preferred" } }
    });
    expect(nativePlugin.startStream.mock.calls[0][0].request).toMatchObject({
      speech: {
        controls: {
          speakingRate: { value: 1.2, requirement: "required" },
          pitch: { value: 1, requirement: "preferred" }
        }
      },
      delivery: { mode: "playback", playback: { volume: { value: 0.5, requirement: "preferred" } } }
    });
  });

  it("dispatches generateSpeech() with a rate control", async () => {
    nativePlugin.run.mockResolvedValue({
      schemaVersion: "1.1",
      runId: "run_gen",
      output: {
        artifacts: [{ id: "a1", owner: "engine", lifetime: "until_disposed", mediaType: "audio/wav", byteLength: 4 }]
      }
    });
    const { createIndeRunCapacitor } = await import("./index.js");
    const inderun = createIndeRunCapacitor({ systemSpeech: true });
    await inderun.generateSpeech({
      text: "Hallo",
      locale: "de-AT",
      controls: { speakingRate: { value: 0.8, requirement: "required" } }
    });
    expect(nativePlugin.run.mock.calls[0][0]).toMatchObject({
      speech: { controls: { speakingRate: { value: 0.8, requirement: "required" } } },
      delivery: { mode: "artifact" }
    });
  });

  it("passes includeControls and includeUnavailable through listVoices", async () => {
    const voice = { id: "v1", name: "Anna", locale: "de-AT" };
    const declaration = {
      id: "speech.speakingRate",
      valueKind: "number",
      phase: "synthesis",
      lifetime: "utterance",
      deliveries: ["playback", "artifact"]
    };
    const snapshot = (providerId: string, available: boolean) => ({
      providerId,
      descriptor: { taskCapabilities: [{ kind: "text_to_speech", controls: [declaration] }] },
      capabilities: {
        available,
        taskCapabilities: [
          {
            kind: "text_to_speech",
            voices: [voice],
            controlStates: [{ id: "speech.speakingRate", delivery: "playback", available: true }]
          }
        ]
      }
    });
    nativePlugin.checkCapabilities.mockResolvedValue({
      providers: [snapshot("local_speech", true), snapshot("down_speech", false)]
    });
    const { createIndeRunCapacitor } = await import("./index.js");
    const inderun = createIndeRunCapacitor({ systemSpeech: true });

    const plain = await inderun.listVoices();
    expect(plain).toHaveLength(1);
    expect(plain[0]).not.toHaveProperty("controls");

    const full = await inderun.listVoices({ includeControls: true, includeUnavailable: true });
    expect(full.map((entry) => entry.providerId)).toEqual(["local_speech", "down_speech"]);
    expect(full[0].controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "speech.speakingRate", delivery: "playback", available: true })
      ])
    );
    expect(full[1].controls?.every((control) => control.available === false)).toBe(true);
  });
});
