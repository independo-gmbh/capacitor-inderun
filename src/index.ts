import type {
  ArtifactReadRequest,
  MediaArtifact,
  PrepareRequest,
  StreamRunHandle,
  TaskRequest,
  TaskResult
} from "@independo/inderun-contracts";
import type {
  GeneratedSpeech,
  GenerateSpeechOptions,
  IndeRunApi,
  ListVoicesOptions,
  SpeakOptions,
  SpeechExecutionOptions,
  SpeechPlayback,
  SpeechVoiceInfo,
  SpokenSpeech
} from "@independo/inderun-web";
import { registerPlugin } from "@capacitor/core";
import type {
  ArtifactChunk,
  BridgedArtifactChunk,
  CancelStreamOptions,
  CheckCapabilitiesResult,
  ConfigureOptions,
  IndeRunCapacitorPlugin as IndeRunCapacitorPluginContract,
  NeuralSpeechBootstrapOptions,
  OnnxProviderBootstrapOptions,
  OpenAIProviderBootstrapOptions,
  ProviderCapabilitySnapshot,
  ProviderDescriptor,
  ProviderDynamicCapabilities,
  ProviderPrivacy,
  ProviderReadiness,
  ProviderTaskAvailability,
  ProviderTaskCapability,
  ProviderVoice,
  StartPrepareOptions,
  StartStreamOptions,
  StreamErrorNotification,
  StreamEventNotification,
  StreamRun,
  SystemModelProviderBootstrapOptions,
  SystemSpeechBootstrapOptions
} from "./definitions.js";
import { decodeArtifactChunk } from "./artifacts.js";
import { normalizePluginError } from "./errors.js";
import { startCapacitorPrepare, startCapacitorStream } from "./streaming.js";

/**
 * The web SDK's speech facade, loaded on first use. A static import of the package root would
 * put the whole web engine and its WASM route-core loader into every native app's initial
 * bundle — this module is loaded on iOS and Android too. The package is side-effect free now, so
 * the facade alone would be small, but the lazy web fallback shares the SDK's modules with it and
 * a bundler hoists them into the entry's initial chunks (measured at +108 KB raw, with the WASM
 * loader). The facade only translates options into a `TaskRequest` and reads the
 * result back; everything it calls goes through the `IndeRunApi` it is handed.
 */
function loadSpeechFacade(): Promise<typeof import("@independo/inderun-web")> {
  return import("@independo/inderun-web");
}

const IndeRunCapacitorNative = registerPlugin<IndeRunCapacitorPluginContract>("IndeRunCapacitor", {
  web: () => import("./web.js").then((module) => new module.IndeRunWeb())
});

/**
 * The plugin contract plus the ergonomic Mode 2 entry points. `stream()` and `prepare()`
 * are not plugin methods — each is `startStream` / `startPrepare`, the event listeners,
 * and `cancelStream` reassembled into the same shape the platform SDKs return.
 *
 * `speak()`, `generateSpeech()` and `listVoices()` are not plugin methods either: they are the
 * web SDK's speech facade over this object, so a speech call is a `stream()`, a `run()` or a
 * `checkCapabilities()` underneath, exactly as with the platform SDKs.
 */
export interface IndeRunCapacitorApi
  extends Omit<IndeRunCapacitorPluginContract, "checkCapabilities" | "readArtifact"> {
  /**
   * Starts a Mode 2 run. Resolves with a `StreamRun` once the engine has minted a `runId`;
   * `events` ends in exactly one terminal event and is single-use. A failed run is a terminal
   * `error` event, not a rejection. See the README's Error Handling table.
   * @throws {IndeRunError} On validation or routing failure, before any event.
   */
  stream(request: TaskRequest): Promise<StreamRun>;
  /**
   * Makes registered providers ready ahead of a run, without producing output. Resolves with a
   * `StreamRun` like `stream()`: progress events, then one terminal event listing each item.
   * `prepare({})` covers every provider and task. A platform download starts only where
   * `allowDownload` on the request, or `autoDownload` at registration, permits it.
   */
  prepare(request: PrepareRequest): Promise<StreamRun>;
  /** The plugin's `{ providers }` envelope, unwrapped to match the platform SDKs. */
  checkCapabilities(): Promise<ProviderCapabilitySnapshot[]>;
  /** The plugin's base64 transport decoded back into bytes, matching the platform SDKs. */
  readArtifact(request: ArtifactReadRequest): Promise<ArtifactChunk>;
  /** Speaks through the device. See `IndeRunCapacitorInstance.speak()`. */
  speak(options: SpeakOptions): Promise<SpeechPlayback>;
  /** Synthesizes retrievable audio. See `IndeRunCapacitorInstance.generateSpeech()`. */
  generateSpeech(options: GenerateSpeechOptions): Promise<GeneratedSpeech>;
  /** Lists the voices the registered providers offer. See `IndeRunCapacitorInstance.listVoices()`. */
  listVoices(options?: ListVoicesOptions): Promise<SpeechVoiceInfo[]>;
}

/**
 * The plugin singleton, with every call's native error unwrapped into the canonical
 * `IndeRunError`. Low level: you call `configure()` yourself, and it replaces the engine every
 * caller shares, because the native plugin holds one engine at a time. Most apps want
 * `createIndeRunCapacitor()`, which configures once on first use.
 */
export const IndeRunCapacitor: IndeRunCapacitorApi = {
  async configure(options?: ConfigureOptions): Promise<void> {
    try {
      await IndeRunCapacitorNative.configure(options);
    } catch (error) {
      throw normalizePluginError(error);
    }
  },

  async run(request: TaskRequest): Promise<TaskResult> {
    try {
      return await IndeRunCapacitorNative.run(request);
    } catch (error) {
      throw normalizePluginError(error);
    }
  },

  async checkCapabilities(): Promise<ProviderCapabilitySnapshot[]> {
    try {
      const result: CheckCapabilitiesResult = await IndeRunCapacitorNative.checkCapabilities();
      return result.providers;
    } catch (error) {
      throw normalizePluginError(error);
    }
  },

  async startStream(options: StartStreamOptions): Promise<StreamRunHandle> {
    try {
      return await IndeRunCapacitorNative.startStream(options);
    } catch (error) {
      throw normalizePluginError(error);
    }
  },

  async startPrepare(options: StartPrepareOptions): Promise<StreamRunHandle> {
    try {
      return await IndeRunCapacitorNative.startPrepare(options);
    } catch (error) {
      throw normalizePluginError(error);
    }
  },

  async cancelStream(options: CancelStreamOptions): Promise<void> {
    try {
      await IndeRunCapacitorNative.cancelStream(options);
    } catch (error) {
      throw normalizePluginError(error);
    }
  },

  async readArtifact(request: ArtifactReadRequest): Promise<ArtifactChunk> {
    let chunk: BridgedArtifactChunk;
    try {
      chunk = await IndeRunCapacitorNative.readArtifact(request);
    } catch (error) {
      throw normalizePluginError(error);
    }
    return decodeArtifactChunk(chunk);
  },

  async disposeArtifact(artifact: MediaArtifact): Promise<void> {
    try {
      await IndeRunCapacitorNative.disposeArtifact(artifact);
    } catch (error) {
      throw normalizePluginError(error);
    }
  },

  async close(): Promise<void> {
    try {
      await IndeRunCapacitorNative.close();
    } catch (error) {
      throw normalizePluginError(error);
    }
  },

  addListener: IndeRunCapacitorNative.addListener.bind(
    IndeRunCapacitorNative
  ) as IndeRunCapacitorPluginContract["addListener"],

  async removeAllListeners(): Promise<void> {
    await IndeRunCapacitorNative.removeAllListeners();
  },

  stream(request: TaskRequest): Promise<StreamRun> {
    return startCapacitorStream(IndeRunCapacitorNative, request);
  },

  prepare(request: PrepareRequest): Promise<StreamRun> {
    return startCapacitorPrepare(IndeRunCapacitorNative, request);
  },

  async speak(options: SpeakOptions): Promise<SpeechPlayback> {
    const { speak } = await loadSpeechFacade();
    return speak(IndeRunCapacitor, options);
  },

  async generateSpeech(options: GenerateSpeechOptions): Promise<GeneratedSpeech> {
    const { generateSpeech } = await loadSpeechFacade();
    return generateSpeech(IndeRunCapacitor, options);
  },

  async listVoices(options?: ListVoicesOptions): Promise<SpeechVoiceInfo[]> {
    const { listVoices } = await loadSpeechFacade();
    return listVoices(IndeRunCapacitor, options);
  }
};

/**
 * A configured IndeRun engine behind the bridge, with the same methods as the web SDK's
 * `IndeRunApi` — which is what lets it be handed to that SDK's facade functions.
 *
 * `close()` closes the engine for good, as upstream does: the instance is not reconfigured
 * afterwards, so every later call fails with `Unavailable` (`details.code: "engine_closed"`)
 * and `checkCapabilities()` reports no providers. To start over, create a new instance — or
 * call `IndeRunCapacitor.configure()`, which builds a fresh engine for every caller, since
 * the native plugin holds one engine at a time.
 *
 * `speak()`, `generateSpeech()` and `listVoices()` are the web SDK's speech facade over the
 * instance itself: each configures first through the instance's own `stream()`, `run()` or
 * `checkCapabilities()`. `generateSpeech()` returns an artifact handle; read its bytes with
 * `readArtifact()` and release them with `disposeArtifact()`.
 */
export interface IndeRunCapacitorInstance {
  /**
   * Executes a Mode 1 (request/response) task and resolves with the completed `TaskResult`.
   * Routing decides the provider from the request's `constraints` and `preferences`; the caller
   * never names one. There is no partial result: it resolves complete or rejects.
   * @throws {IndeRunError} On validation failure, when no eligible provider exists (for example
   *   `local_required` with no on-device provider), or when every attempted provider fails.
   *   Branch on `errorClass`; `provenance` says where it went.
   */
  run(request: TaskRequest): Promise<TaskResult>;
  /**
   * Starts a Mode 2 (streaming) run. Resolves with a `StreamRun`: `handle`, the single-use
   * `events` iterable, and an idempotent `cancel()`. Provider failure and cancellation arrive as
   * the terminal event, not as a rejection.
   * @throws {IndeRunError} On validation or routing failure, before any event. A bridge fault
   *   surfaces from `events` as an `Internal` error.
   */
  stream(request: TaskRequest): Promise<StreamRun>;
  /**
   * Live snapshot of every registered provider's static descriptor and current availability,
   * without executing a task. Availability changes between calls, so do not cache it across a
   * `run()` or `stream()`. Reports no providers once the handle is closed.
   */
  checkCapabilities(): Promise<ProviderCapabilitySnapshot[]>;
  /**
   * Makes registered providers ready ahead of a run, without producing output (ADR 019). Resolves
   * with a `StreamRun`: progress events, then one terminal event listing each item.
   * `prepare({})` covers every provider and task. A platform download starts only where
   * `allowDownload` on the request, or `autoDownload` at registration, permits it.
   */
  prepare(request: PrepareRequest): Promise<StreamRun>;
  /**
   * Reads a byte range of a media artifact a run produced. `bytes` is decoded from the native
   * base64 transport into a `Uint8Array`. Reads are repeatable until the artifact is disposed.
   * @param request - `artifactId`, plus an optional `offset` and `maxBytes`. Loop until
   *   `done` for a large artifact.
   * @throws {IndeRunError} `Unavailable` with `details.code: "artifact_not_found"` for an unknown
   *   or disposed artifact.
   */
  readArtifact(request: ArtifactReadRequest): Promise<ArtifactChunk>;
  /**
   * Releases an artifact's bytes. Idempotent. Artifacts outlive the run that produced them, so
   * dispose each one you no longer need.
   */
  disposeArtifact(artifact: MediaArtifact): Promise<void>;
  /**
   * Closes the engine for good. In-flight streams and prepares end in their cancelled terminal,
   * in-flight runs finish, artifacts are released, and the speech providers and models the plugin
   * loaded for it are released. Later calls fail with `Unavailable` (`details.code:
   * "engine_closed"`). Closing a handle that never configured does nothing.
   */
  close(): Promise<void>;
  /**
   * Speaks through the device and resolves with a `SpeechPlayback` handle once routing has
   * accepted the request. A `stream()` underneath, so it cancels like one: `playback.cancel()`
   * stops the audio and `await playback.result` settles when playback ends or is stopped.
   * The app never receives bytes.
   * @throws {IndeRunError} On validation or routing refusal, before any audio.
   */
  speak(options: SpeakOptions): Promise<SpeechPlayback>;
  /**
   * Synthesizes retrievable audio. Silent, and not cancellable, because it is a `run()`
   * underneath. Resolves with an `artifact` handle: read it with `readArtifact()` and release it
   * with `disposeArtifact()`. A provider that can only play audio, such as the browser's system
   * speech, is refused by routing.
   * @throws {IndeRunError} As `run()` does.
   */
  generateSpeech(options: GenerateSpeechOptions): Promise<GeneratedSpeech>;
  /**
   * Lists the voices the registered providers offer right now. Pass an entry as `voice` to
   * `speak()` or `generateSpeech()`. A provider that is unavailable contributes none.
   */
  listVoices(options?: ListVoicesOptions): Promise<SpeechVoiceInfo[]>;
}

/**
 * Compile-time guard: the instance and `IndeRunCapacitor` must stay assignable to the web
 * SDK's `IndeRunApi`, the type its facade functions take — both hand themselves to it. Lives
 * here rather than in a test because `pnpm lint` does not compile the test files.
 */
type AssertIndeRunApi<T extends IndeRunApi> = T;
type _InstanceIsIndeRunApi = AssertIndeRunApi<IndeRunCapacitorInstance>;
type _CapacitorIsIndeRunApi = AssertIndeRunApi<IndeRunCapacitorApi>;

/**
 * Creates a handle on one IndeRun engine. Nothing happens until the first call: the handle
 * `configure()`s lazily with `options`, and memoizes that configuration, so concurrent first
 * calls share one `configure()`. If it fails, the failure rejects that call and the next call
 * tries again; a failed configure is never cached. It is safe to create one at app startup.
 *
 * With no `options`, iOS and Android register their on-device provider and nothing else. No
 * cloud route exists unless you pass `openAI`, and even then a request has to permit it. The web
 * has no built-in provider, so pass `systemModel`, `onnx`, `systemSpeech` or `neuralSpeech`
 * there, or `configure()` fails with `Unavailable`.
 *
 * @param options - Provider registrations and model profiles. See `ConfigureOptions`.
 * @example
 * ```ts
 * const inderun = createIndeRunCapacitor();
 *
 * // `local_required` never leaves the device; it is refused when no local provider can serve it.
 * const result = await inderun.run({
 *   schemaVersion: "1.0",
 *   task: { kind: "text_to_text" },
 *   prompt: "Summarize why a thin bridge matters.",
 *   constraints: { privacy: "local_required" }
 * });
 * console.log(result.output.text, result.provenance?.locality);
 * ```
 */
export function createIndeRunCapacitor(options?: ConfigureOptions): IndeRunCapacitorInstance {
  let configured: Promise<void> | null = null;

  function ensureConfigured(): Promise<void> {
    configured ??= IndeRunCapacitor.configure(options).catch((error) => {
      configured = null;
      throw error;
    });
    return configured;
  }

  const instance: IndeRunCapacitorInstance = {
    async run(request: TaskRequest): Promise<TaskResult> {
      await ensureConfigured();
      return IndeRunCapacitor.run(request);
    },

    async stream(request: TaskRequest): Promise<StreamRun> {
      await ensureConfigured();
      return IndeRunCapacitor.stream(request);
    },

    // Configures first: without a registry there are no providers to report on.
    async checkCapabilities(): Promise<ProviderCapabilitySnapshot[]> {
      await ensureConfigured();
      return IndeRunCapacitor.checkCapabilities();
    },

    async prepare(request: PrepareRequest): Promise<StreamRun> {
      await ensureConfigured();
      return IndeRunCapacitor.prepare(request);
    },

    async readArtifact(request: ArtifactReadRequest): Promise<ArtifactChunk> {
      await ensureConfigured();
      return IndeRunCapacitor.readArtifact(request);
    },

    async disposeArtifact(artifact: MediaArtifact): Promise<void> {
      await ensureConfigured();
      return IndeRunCapacitor.disposeArtifact(artifact);
    },

    // Never configures: closing an instance that has no engine yet has nothing to close.
    // One whose configure is still in flight is closed once it lands; one whose configure
    // failed has no engine either.
    async close(): Promise<void> {
      if (configured === null) {
        return;
      }
      try {
        await configured;
      } catch {
        return;
      }
      await IndeRunCapacitor.close();
    },

    async speak(options: SpeakOptions): Promise<SpeechPlayback> {
      const { speak } = await loadSpeechFacade();
      return speak(instance, options);
    },

    async generateSpeech(options: GenerateSpeechOptions): Promise<GeneratedSpeech> {
      const { generateSpeech } = await loadSpeechFacade();
      return generateSpeech(instance, options);
    },

    async listVoices(options?: ListVoicesOptions): Promise<SpeechVoiceInfo[]> {
      const { listVoices } = await loadSpeechFacade();
      return listVoices(instance, options);
    }
  };

  return instance;
}

export { STREAM_ERROR_NAME, STREAM_EVENT_NAME } from "./streaming.js";

export type {
  ArtifactChunk,
  BridgedArtifactChunk,
  CancelStreamOptions,
  CheckCapabilitiesResult,
  ConfigureOptions,
  GeneratedSpeech,
  GenerateSpeechOptions,
  IndeRunCapacitorPluginContract as IndeRunCapacitorPlugin,
  ListVoicesOptions,
  NeuralSpeechBootstrapOptions,
  OnnxProviderBootstrapOptions,
  OpenAIProviderBootstrapOptions,
  ProviderCapabilitySnapshot,
  ProviderDescriptor,
  ProviderDynamicCapabilities,
  ProviderPrivacy,
  ProviderReadiness,
  ProviderTaskAvailability,
  ProviderTaskCapability,
  ProviderVoice,
  SpeakOptions,
  SpeechExecutionOptions,
  SpeechPlayback,
  SpeechVoiceInfo,
  SpokenSpeech,
  StartPrepareOptions,
  StartStreamOptions,
  StreamErrorNotification,
  StreamEventNotification,
  StreamRun,
  SystemModelProviderBootstrapOptions,
  SystemSpeechBootstrapOptions,
  TaskRequest,
  TaskResult
};

export type * from "@independo/inderun-contracts";
