import type { StreamRunHandle, TaskResult } from "@independo/inderun-contracts";
import { WebPlugin } from "@capacitor/core";
import { createIndeRunWeb, toIndeRunException } from "@independo/inderun-web";
import { createUnavailable } from "@independo/inderun-web/provider";
import type {
  BridgedArtifactChunk,
  CancelStreamOptions,
  CheckCapabilitiesResult,
  ConfigureOptions,
  IndeRunCapacitorPlugin,
  StartPrepareOptions,
  StartStreamOptions,
  StreamRun
} from "./definitions.js";
import type { ArtifactReadRequest, MediaArtifact, TaskRequest } from "@independo/inderun-contracts";
import type { CreateIndeRunWebOptions, IndeRun } from "@independo/inderun-web";
import { STREAM_ERROR_NAME, STREAM_EVENT_NAME } from "./streaming.js";

export class IndeRunWeb extends WebPlugin implements IndeRunCapacitorPlugin {
  private engine: IndeRun | null = null;
  // Deliberately the bridge's StreamRun, not the web SDK's: the engine's run is
  // assigned straight into this map, so the two shapes staying identical is checked
  // by the compiler rather than by convention.
  private readonly activeStreams = new Map<string, StreamRun>();
  private readonly startingStreams = new Set<string>();
  private readonly pendingCancels = new Map<string, string | undefined>();

  async configure(options?: ConfigureOptions): Promise<void> {
    // The web SDK requires at least one provider, not specifically the cloud one. Held
    // here as well as there so the failure is an `Unavailable` contract error rather than
    // a raw SDK throw, which is what the facade's callers expect.
    if (
      !options?.openAI &&
      !options?.systemModel &&
      !options?.onnx &&
      !options?.systemSpeech &&
      !options?.neuralSpeech?.length
    ) {
      throw createUnavailable(
        "Capacitor web execution requires at least one provider registration. Configure with openAI, systemModel, onnx, systemSpeech and/or neuralSpeech bootstrap options before calling run(request)."
      ).toContractError();
    }

    let previous: IndeRun | null;
    try {
      // The SDK's own option type, not a hand-written copy of it: an upstream rename
      // then fails at the type level instead of silently dropping a field. This is
      // deliberately the *outbound* shape only — `ConfigureOptions` stays a narrower,
      // JSON-serializable subset, because it has to cross the native bridge hop.
      const webOptions: CreateIndeRunWebOptions = {};

      if (options.openAI !== undefined) {
        webOptions.openAI = compactOpenAIOptions(options.openAI);
      }
      if (options.systemModel !== undefined) {
        webOptions.systemModel = compactSystemModelOptions(options.systemModel);
      }
      if (options.onnx !== undefined) {
        webOptions.onnx = compactOnnxOptions(options.onnx);
      }
      if (options.systemSpeech !== undefined) {
        webOptions.systemSpeech = compactSystemSpeechOptions(options.systemSpeech);
      }
      if (options.neuralSpeech !== undefined) {
        webOptions.neuralSpeech = options.neuralSpeech.map(compactNeuralSpeechOptions);
      }
      if (options.modelProfiles !== undefined) {
        webOptions.modelProfiles = options.modelProfiles;
      }
      if (options.allowDirectOpenAIEndpoint !== undefined) {
        webOptions.allowDirectOpenAIEndpoint = options.allowDirectOpenAIEndpoint;
      }

      previous = this.engine;
      this.engine = createIndeRunWeb(webOptions);
    } catch (error) {
      throw toIndeRunException(error).toContractError();
    }

    // One engine per configuration: the old one's streams end in their cancelled terminal
    // and its artifacts are released, as on native. Outside the rejecting `try`, because
    // the new engine is installed by now: the configuration took effect either way.
    try {
      await previous?.close();
    } catch (error) {
      console.warn("Closing the replaced IndeRun engine failed.", error);
    }
  }

  async run(request: TaskRequest): Promise<TaskResult> {
    if (!this.engine) {
      throw createUnavailable(
        "Capacitor IndeRun has not been configured. Configure providers before calling run(request)."
      ).toContractError();
    }

    try {
      return await this.engine.run(request);
    } catch (error) {
      throw toIndeRunException(error).toContractError();
    }
  }

  async checkCapabilities(): Promise<CheckCapabilitiesResult> {
    if (!this.engine) {
      throw createUnavailable(
        "Capacitor IndeRun has not been configured. Configure providers before calling checkCapabilities()."
      ).toContractError();
    }

    try {
      // Uncast: the engine's snapshots are the generated contract type the bridge
      // declares too. See definitions.ts.
      return { providers: await this.engine.checkCapabilities() };
    } catch (error) {
      throw toIndeRunException(error).toContractError();
    }
  }

  /**
   * The web path deliberately round-trips through `notifyListeners` rather than
   * handing the engine's `StreamRun` straight back.
   *
   * Short-circuiting would require the facade to branch on the platform and would
   * leave two reassembly paths whose equivalence is only a convention — while this
   * way there is exactly one, exercised on every platform. It also equalizes the
   * loss of generator backpressure that the native paths have regardless.
   */
  async startStream(options: StartStreamOptions): Promise<StreamRunHandle> {
    const engine = this.requireEngine("stream(request)");
    return this.startBridgedRun(options.streamId, () => engine.stream(options.request));
  }

  /** Delivered exactly like `startStream`; see there. */
  async startPrepare(options: StartPrepareOptions): Promise<StreamRunHandle> {
    const engine = this.requireEngine("prepare(request)");
    return this.startBridgedRun(options.streamId, () => engine.prepare(options.request));
  }

  async readArtifact(request: ArtifactReadRequest): Promise<BridgedArtifactChunk> {
    const engine = this.requireEngine("readArtifact(request)");
    try {
      // The engine's bytes as they are: there is no JSON hop to base64-encode for.
      return await engine.readArtifact(request);
    } catch (error) {
      throw toIndeRunException(error).toContractError();
    }
  }

  async disposeArtifact(artifact: MediaArtifact): Promise<void> {
    const engine = this.requireEngine("disposeArtifact(artifact)");
    try {
      await engine.disposeArtifact(artifact);
    } catch (error) {
      throw toIndeRunException(error).toContractError();
    }
  }

  /**
   * Keeps the closed engine rather than dropping it, so every later call fails the way
   * the engine fails it (`engine_closed`) until `configure()` builds a new one.
   */
  async close(): Promise<void> {
    try {
      await this.engine?.close();
    } catch (error) {
      throw toIndeRunException(error).toContractError();
    }
  }

  private requireEngine(method: string): IndeRun {
    if (!this.engine) {
      throw createUnavailable(
        `Capacitor IndeRun has not been configured. Configure providers before calling ${method}.`
      ).toContractError();
    }
    return this.engine;
  }

  private async startBridgedRun(
    streamId: string,
    start: () => Promise<StreamRun>
  ): Promise<StreamRunHandle> {
    this.startingStreams.add(streamId);

    let run: StreamRun;
    try {
      run = await start();
    } catch (error) {
      this.startingStreams.delete(streamId);
      this.pendingCancels.delete(streamId);
      throw toIndeRunException(error).toContractError();
    }

    this.startingStreams.delete(streamId);
    this.activeStreams.set(streamId, run);

    if (this.pendingCancels.has(streamId)) {
      const reason = this.pendingCancels.get(streamId);
      this.pendingCancels.delete(streamId);
      run.cancel(reason);
    }

    // Pump on a later microtask so this call's handle settles first.
    queueMicrotask(() => void this.pump(streamId, run));
    return run.handle;
  }

  async cancelStream(options: CancelStreamOptions): Promise<void> {
    const run = this.activeStreams.get(options.streamId);
    if (run !== undefined) {
      // Never abandon the generator: the engine must stay free to emit its one
      // `cancelled` terminal event.
      run.cancel(options.reason);
      return;
    }

    if (this.startingStreams.has(options.streamId)) {
      // Cancel raced startStream's route selection; applied once the run attaches.
      this.pendingCancels.set(options.streamId, options.reason);
      return;
    }

    // Unknown or already-finished run: cancelling after the terminal is a no-op,
    // not an error.
  }

  private async pump(streamId: string, run: StreamRun): Promise<void> {
    try {
      for await (const event of run.events) {
        this.notifyListeners(STREAM_EVENT_NAME, { streamId, event }, true);
      }
    } catch (error) {
      this.notifyListeners(
        STREAM_ERROR_NAME,
        { streamId, error: toIndeRunException(error).toContractError() },
        true
      );
    } finally {
      this.activeStreams.delete(streamId);
    }
  }
}

type WebOpenAIOptions = NonNullable<CreateIndeRunWebOptions["openAI"]>;

/**
 * Assigns only the fields the caller actually set. `exactOptionalPropertyTypes` makes
 * this incremental style mandatory rather than cosmetic: assigning `undefined` to an
 * optional property is an error, and an explicit `undefined` on the wire is not the same
 * thing as an absent key to the provider that reads it.
 *
 * `id`, `healthCheckTimeoutMs` and `healthCheckCacheMs` are deliberately not bridged —
 * all optional, and the bridge has no reason to expose provider-tuning knobs it cannot
 * also offer on native.
 */
function compactOpenAIOptions(openAI: NonNullable<ConfigureOptions["openAI"]>): WebOpenAIOptions {
  const result: WebOpenAIOptions = {
    models: openAI.models
  };

  if (openAI.endpointUrl !== undefined) {
    result.endpointUrl = openAI.endpointUrl;
  }
  if (openAI.auth !== undefined) {
    result.auth = openAI.auth;
  }
  if (openAI.authContextRef !== undefined) {
    result.authContextRef = openAI.authContextRef;
  }
  if (openAI.timeoutMs !== undefined) {
    result.timeoutMs = openAI.timeoutMs;
  }

  return result;
}

type WebSystemModelOptions = NonNullable<CreateIndeRunWebOptions["systemModel"]>;
type WebOnnxOptions = NonNullable<CreateIndeRunWebOptions["onnx"]>;

function compactSystemModelOptions(
  systemModel: NonNullable<ConfigureOptions["systemModel"]>
): WebSystemModelOptions {
  const result: WebSystemModelOptions = {};

  if (systemModel.id !== undefined) {
    result.id = systemModel.id;
  }
  if (systemModel.timeoutMs !== undefined) {
    result.timeoutMs = systemModel.timeoutMs;
  }

  return result;
}

function compactOnnxOptions(onnx: NonNullable<ConfigureOptions["onnx"]>): WebOnnxOptions {
  const result: WebOnnxOptions = {
    modelPackage: onnx.modelPackage
  };

  if (onnx.id !== undefined) {
    result.id = onnx.id;
  }
  if (onnx.timeoutMs !== undefined) {
    result.timeoutMs = onnx.timeoutMs;
  }

  return result;
}

type WebSystemSpeechOptions = NonNullable<CreateIndeRunWebOptions["systemSpeech"]>;
type WebNeuralSpeechOptions = NonNullable<CreateIndeRunWebOptions["neuralSpeech"]>[number];

/** `true` is the defaults, which the web SDK spells `{}`. */
function compactSystemSpeechOptions(
  systemSpeech: NonNullable<ConfigureOptions["systemSpeech"]>
): WebSystemSpeechOptions {
  const result: WebSystemSpeechOptions = {};

  if (systemSpeech !== true && systemSpeech.id !== undefined) {
    result.id = systemSpeech.id;
  }

  return result;
}

/**
 * The runtime crosses as a descriptor (`{ kind: "onnx" }`), the web SDK's JSON-serializable
 * stand-in for a runtime object. A runtime built from a descriptor is the engine's to close, so
 * closing the engine releases it: the bridge holds nothing of its own here to close.
 */
function compactNeuralSpeechOptions(
  neuralSpeech: NonNullable<ConfigureOptions["neuralSpeech"]>[number]
): WebNeuralSpeechOptions {
  if (neuralSpeech.runtime !== undefined && neuralSpeech.runtime !== "onnx") {
    throw new Error(
      `The "${neuralSpeech.runtime}" neural speech runtime is not available on the web; use "onnx".`
    );
  }

  const result: WebNeuralSpeechOptions = {
    modelPackage: neuralSpeech.modelPackage,
    runtime: { kind: "onnx" }
  };

  if (neuralSpeech.id !== undefined) {
    result.id = neuralSpeech.id;
  }
  if (neuralSpeech.timeoutMs !== undefined) {
    result.timeoutMs = neuralSpeech.timeoutMs;
  }
  if (neuralSpeech.autoDownload !== undefined) {
    result.autoDownload = neuralSpeech.autoDownload;
  }

  return result;
}
