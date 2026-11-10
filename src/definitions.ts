import type { PluginListenerHandle } from "@capacitor/core";
import type {
  ArtifactReadRequest,
  IndeRunError,
  MediaArtifact,
  ModelPackage,
  PrepareRequest,
  ProviderCapabilitySnapshot,
  ProviderDescriptor,
  ProviderDynamicCapabilities,
  StreamEvent,
  StreamRunHandle,
  TaskRequest,
  TaskResult
} from "@independo/inderun-contracts";

/**
 * Bootstrap options for the OpenAI-compatible cloud provider.
 *
 * One target is registered per entry in `models`, with id `openai:<model>` (for example
 * `openai:gpt-5.2`) on every platform — the id a model profile lists and the
 * `providerId` that results, errors and provenance report. At least one model is required.
 */
export interface OpenAIProviderBootstrapOptions {
  /** Model names to register, one target each. At least one. */
  models: string[];
  /**
   * The Responses endpoint to call. Point it at a backend you control, which holds the API key;
   * for a browser app, a same-origin proxy with `auth: "none"`.
   */
  endpointUrl?: string;
  /**
   * How the request authenticates. `"none"` sends no credential, for a proxy that holds it.
   * `"authContextRef"` resolves the one named by `authContextRef` through the host's secure
   * storage. Never a raw secret.
   */
  auth?: "authContextRef" | "none";
  /** Secure-storage slot for the credential. Used with `auth: "authContextRef"`. */
  authContextRef?: string;
  /** Bounds a request, in milliseconds. A request's `constraints.timeoutMs` wins. */
  timeoutMs?: number;
}

/**
 * Bootstrap options for the browser-managed on-device provider (Chrome's Prompt API).
 *
 * **Web only**, and ignored on iOS and Android, which register their own on-device
 * providers — Apple Foundation Models and ML Kit GenAI — from `configure()` regardless.
 *
 * The browser owns model availability, download and execution, so there is nothing to
 * configure: registering it is the whole point, and it is what makes
 * `constraints.privacy = "local_required"` routable in a browser. Mode 1 only — this
 * provider does not stream, so a `local_required` *stream* on the web is still refused at
 * routing time.
 *
 * The web SDK's `runtime` injection seam is deliberately not exposed: it is a function,
 * and `configure()` has to survive a JSON bridge hop on native.
 */
export interface SystemModelProviderBootstrapOptions {
  /** Provider id. Defaults to `local.system-model.web`. */
  id?: string;
  /** Bounds a run until it commits, in milliseconds. A request's `constraints.timeoutMs` wins. */
  timeoutMs?: number;
}

/**
 * Bootstrap options for the ONNX Runtime text provider, for a developer-supplied local model.
 * Mode 1 only. Runs on the web, iOS and Android.
 *
 * **Model files on iOS and Android** (also for `neuralSpeech`): `modelPackage.source.sourceType`
 * says where they are read from. `app_managed` is the app's own storage under `source.ref`
 * (Application Support on iOS, `context.filesDir` on Android); `filesystem` is the absolute path
 * in `source.ref`; `bundled` is a folder shipped inside the app. `registry` and `remote` are not
 * supported, and the plugin downloads nothing for text models. On the web the files must be
 * reachable by URL instead.
 *
 * On iOS and Android this registers the platform's ONNX Runtime provider (default id
 * `local.onnx.genai.apple` or `local.onnx.genai.android`, or `id`). It loads the model on first
 * use and downloads nothing: the files have to be on the device already.
 * `timeoutMs` bounds a run until it commits; a request's `constraints.timeoutMs` wins.
 *
 * Two caveats for the web. The consumer has to install the
 * optional `@huggingface/transformers` peer dependency — this bridge does not declare it —
 * and supply real model weights, because the web SDK's `runtime` seam is a function and so
 * cannot cross the JSON bridge hop: only the default Transformers.js runtime is reachable
 * from here, never the fixture runtime the upstream demos use offline. A registered
 * provider that cannot load turns a clean routing refusal into a provider error, so
 * register it only when the weights are actually there.
 */
export interface OnnxProviderBootstrapOptions {
  /** Provider id. Defaults to `local.onnx.genai.apple` or `local.onnx.genai.android`. */
  id?: string;
  /** The model files and where they are. Describe each file's sha256 in `integrity.checksums`. */
  modelPackage: ModelPackage;
  /** Bounds a run until it commits, in milliseconds. A request's `constraints.timeoutMs` wins. */
  timeoutMs?: number;
}

/**
 * Bootstrap options for the platform's system speech provider: `AVSpeechSynthesizer` on iOS,
 * `android.speech.tts.TextToSpeech` on Android, `speechSynthesis` on the web. Pass `true` for
 * the defaults.
 *
 * Opt-in on every platform (ADR 018): the router probes every registered provider on every
 * request, so an app that does not speak should not pay for a voice listing. The provider id
 * defaults to `apple_system_speech`, `android_system_speech` or `web_system_speech`. The
 * browser provider only plays audio: it cannot write an artifact, so routing refuses
 * `generateSpeech()` there.
 */
export interface SystemSpeechBootstrapOptions {
  /** Provider id. Defaults to `apple_system_speech`, `android_system_speech` or `web_system_speech`. */
  id?: string;
}

/**
 * Bootstrap options for one neural speech provider: a developer-supplied speech model package
 * (its `speech` block names the pipeline, graphs and voices) and the runtime that executes it.
 *
 * Each entry registers one provider, with id `local.onnx.speech.<platform>:<modelPackage.id>`
 * (`apple`, `android` or `web`) unless `id` is set, so one app can register several models side
 * by side. It plays through the platform's audio output and writes `audio/wav` artifacts.
 *
 * - `runtime` defaults to `"onnx"` (ONNX Runtime, every platform). `"coreai"` runs a
 *   `format: "coreai"` package on Apple Core AI and is **iOS only**: its provider id defaults to
 *   `local.coreai.speech.apple:<modelPackage.id>`, below iOS 27 the provider reports itself
 *   unavailable and routing skips it, and preparing the model on a device needs the app's consent
 *   (`autoDownload`, or `prepare({ allowDownload: true })`). `configure()` rejects `"coreai"` on
 *   Android and the web.
 * - `autoDownload` lets `prepare()`, explicit or on the first run, start this provider's
 *   download on its own. Off by default, because a download can use mobile data; a single call
 *   can still allow one with `prepare({ allowDownload: true })`.
 * - `timeoutMs` bounds the synthesis until the run commits; a request's `constraints.timeoutMs`
 *   wins.
 *
 * On iOS and Android the package's source names files on the device, see
 * the model file paragraph on {@link OnnxProviderBootstrapOptions}. **On the web** the package
 * files must be reachable by URL (`bundled` or `app_managed`): `configure()` has to stay JSON, so the runtime is chosen by name, and a
 * runtime that reads a package the app installed into OPFS cannot be passed across. The web
 * runtime also needs the optional `onnxruntime-web` peer dependency, which this plugin does not
 * declare: the app installs it.
 */
export interface NeuralSpeechBootstrapOptions {
  /**
   * The model package. List a sha256 per file in `integrity.checksums`; the provider verifies
   * each file before loading it.
   */
  modelPackage: ModelPackage;
  /** `"onnx"` (default, every platform) or `"coreai"` (iOS 27+ only). */
  runtime?: "onnx" | "coreai";
  /** Provider id. See the id rule above. */
  id?: string;
  /** Bounds the synthesis until the run commits, in milliseconds. */
  timeoutMs?: number;
  /** Lets `prepare()` start this provider's download on its own. Off by default. */
  autoDownload?: boolean;
}

/**
 * What to register in the engine `configure()` builds. Every field is optional on iOS and
 * Android, which always register their own on-device text provider. On the web at least one
 * of `openAI`, `systemModel`, `onnx`, `systemSpeech` or `neuralSpeech` is required.
 *
 * Nothing here is a cloud route unless you pass `openAI`.
 */
export interface ConfigureOptions {
  /** The OpenAI-compatible cloud provider. Absent means no cloud route exists. */
  openAI?: OpenAIProviderBootstrapOptions;
  /**
   * Named model profiles: a profile name mapped to an ordered list of target ids
   * (`openai:gpt-5.2`, or an on-device provider's id). A request opts in with
   * `TaskRequest.modelProfile`; routing then stays within that list, in that order after
   * placement constraints. Omitted, every request routes within the built-in `auto` profile —
   * every registered target — and naming any other profile fails the request.
   *
   * `auto` cannot be redefined, and a profile must list at least one target, each once;
   * `configure()` rejects a configuration that breaks either rule.
   */
  modelProfiles?: Record<string, string[]>;
  /** Web only; native registers its own on-device provider. */
  systemModel?: SystemModelProviderBootstrapOptions;
  /** Web only; native registers its own on-device provider. */
  onnx?: OnnxProviderBootstrapOptions;
  /** All platforms, and never registered unless asked for. See `SystemSpeechBootstrapOptions`. */
  systemSpeech?: true | SystemSpeechBootstrapOptions;
  /** All platforms; one provider per entry. See `NeuralSpeechBootstrapOptions`. */
  neuralSpeech?: NeuralSpeechBootstrapOptions[];
  /**
   * Web only; ignored on iOS and Android. Explicit opt-in for calling a public Responses
   * endpoint (OpenAI's or OpenRouter's) straight from the browser. Leave it unset and use a
   * proxy endpoint with `openAI.auth = "none"`: direct calls can expose credentials.
   */
  allowDirectOpenAIEndpoint?: boolean;
}

/**
 * Bridge-local correlation id for one streaming run.
 *
 * Not a contract field, and never placed inside the `TaskRequest`: `runId` stays the
 * engine's to mint. `startStream` resolves only *after* the engine has minted one, so
 * keying the JS-side event sink on `runId` would leave a window in which native can
 * emit events for a run JS has not yet heard of. The `streamId` is generated before
 * the call instead, which lets the sink be bound first and makes `cancel()`
 * well-defined even before a handle exists.
 */
export interface StartStreamOptions {
  streamId: string;
  request: TaskRequest;
}

/**
 * Envelope for `startPrepare`: the same shape as `StartStreamOptions`, carrying a
 * `PrepareRequest` instead of a `TaskRequest`. A prepare run is delivered exactly like a
 * stream — the same `"indeRunStreamEvent"` / `"indeRunStreamError"` notifications keyed by
 * `streamId`, cancelled through the same `cancelStream` — because upstream returns the same
 * `StreamRun` from both.
 */
export interface StartPrepareOptions {
  streamId: string;
  request: PrepareRequest;
}

export interface CancelStreamOptions {
  streamId: string;
  reason?: string;
}

/** Payload of `"indeRunStreamEvent"`. `event` is the canonical, unmodified `StreamEvent`. */
export interface StreamEventNotification {
  streamId: string;
  event: StreamEvent;
}

/**
 * Payload of `"indeRunStreamError"`: a failure of the *bridge*, not an outcome of the
 * run. A run that fails ends in a terminal event with `payload.outcome === "error"`,
 * delivered through `"indeRunStreamEvent"` like any other event.
 */
export interface StreamErrorNotification {
  streamId: string;
  error: IndeRunError;
}

/**
 * Structurally identical to `StreamRun` in `@independo/inderun-web`, so bridge and
 * direct-SDK consumers read the same. `events` terminates in exactly one terminal
 * event and is single-use; `cancel()` is idempotent.
 */
export interface StreamRun {
  handle: StreamRunHandle;
  events: AsyncIterable<StreamEvent>;
  cancel(reason?: string): void;
}

/**
 * One range of an engine-owned media artifact's bytes, as `readArtifact` returns it (ADR 017).
 *
 * Declared here rather than imported: it is not a generated contract — each SDK declares its
 * own (`core/artifacts.d.ts` in `@independo/inderun-web`) — and importing it from the web SDK
 * would make the native platforms' plugin contract depend on it. The drift guard is in
 * `index.ts`, which checks that `IndeRunCapacitorInstance` stays assignable to the web SDK's
 * `IndeRunApi`, whose `readArtifact` returns the web SDK's chunk.
 */
export interface ArtifactChunk {
  /** The artifact the bytes belong to. */
  artifactId: string;
  /** Byte offset of `bytes` within the artifact. */
  offset: number;
  /** The bytes of this range; empty when `offset` is the artifact's end. */
  bytes: Uint8Array;
  /** Size of the whole artifact in bytes. */
  totalBytes: number;
  /** Whether this range reaches the end of the artifact. */
  done: boolean;
}

/**
 * `ArtifactChunk` as it crosses the plugin boundary. A Capacitor native call resolves JSON,
 * which cannot carry a byte array, so iOS and Android send `bytes` as a **base64 string**;
 * the web implementation has no hop to cross and sends the engine's `Uint8Array` as is.
 * `IndeRunCapacitor.readArtifact` and `createIndeRunCapacitor()` decode either form back into
 * `ArtifactChunk`. Base64 is transport only: results still carry artifact handles, never bytes.
 */
export interface BridgedArtifactChunk extends Omit<ArtifactChunk, "bytes"> {
  bytes: string | Uint8Array;
}

/**
 * The provider capability shapes `checkCapabilities()` returns.
 *
 * These were hand-written mirrors while the snapshot had no schema; it is now a generated
 * contract (`provider-capability-snapshot.schema.json`), so the bridge uses the contract's
 * types and names the nested ones here. That is also what keeps the bridge assignable to the
 * web SDK's `IndeRunApi`, whose `checkCapabilities()` returns exactly these.
 */
export type { ProviderCapabilitySnapshot, ProviderDescriptor, ProviderDynamicCapabilities };

/** The provider's static capabilities for one task kind. */
export type ProviderTaskCapability = NonNullable<ProviderDescriptor["taskCapabilities"]>[number];

/** Whether data leaves the device, and where it may go. */
export type ProviderPrivacy = NonNullable<ProviderDescriptor["privacy"]>;

/** A provider's live availability for one task kind. Absent fields inherit the task-wide values. */
export type ProviderTaskAvailability = NonNullable<
  ProviderDynamicCapabilities["taskCapabilities"]
>[number];

/** One speech voice a provider can render, as listed at `checkCapabilities()` time. */
export type ProviderVoice = NonNullable<ProviderTaskAvailability["voices"]>[number];

/** How ready a task (or a voice) is on this host: whether using it would first need preparing. */
export type ProviderReadiness = NonNullable<ProviderTaskAvailability["readiness"]>;

/**
 * Envelope for `checkCapabilities()`. The array is wrapped because a Capacitor plugin
 * method must resolve an object on both native platforms — `PluginCall.resolve(JSObject)`
 * and `call.resolve([String: Any])` cannot carry a top-level array. `IndeRunCapacitor`
 * and `createIndeRunCapacitor()` unwrap it, so app code sees the same
 * `ProviderCapabilitySnapshot[]` the three platform SDKs return.
 */
export interface CheckCapabilitiesResult {
  providers: ProviderCapabilitySnapshot[];
}

export interface IndeRunCapacitorPlugin {
  /**
   * Builds one engine for this configuration, which every later call uses until the next
   * `configure()`. Engine-owned artifacts live in that engine, and providers that load a
   * model keep it loaded there. A new configuration replaces the engine and closes the
   * previous one (see `close()`), resolving once that close has finished; a configuration
   * that fails validation leaves the previous engine in place.
   */
  configure(options?: ConfigureOptions): Promise<void>;
  /**
   * Executes a Mode 1 task and resolves with the completed `TaskResult`. Rejects with an
   * `IndeRunError` on validation failure, when no provider is eligible, or when every attempted
   * provider fails. The request is passed at the options root.
   */
  run(request: TaskRequest): Promise<TaskResult>;
  /**
   * Live snapshot of every registered provider, without executing a task. Availability
   * changes between calls — a local model can unload, cloud credentials can expire — so
   * do not cache it across a `run()` or `stream()`.
   */
  checkCapabilities(): Promise<CheckCapabilitiesResult>;
  /**
   * Unlike `run(request)`, which passes the request at the options root, this nests it
   * under `request` so the envelope can also carry `streamId`. Both native decode sites
   * carry a matching comment.
   */
  startStream(options: StartStreamOptions): Promise<StreamRunHandle>;
  /**
   * Starts a prepare run (ADR 019): makes registered providers ready ahead of a run without
   * producing output. Delivered and cancelled exactly like `startStream` — events on
   * `"indeRunStreamEvent"` keyed by `streamId`, ending in one terminal event whose output
   * lists each preparation item; `cancelStream({ streamId })` cancels it.
   */
  startPrepare(options: StartPrepareOptions): Promise<StreamRunHandle>;
  /**
   * Cancels a stream or prepare run by its bridge-local `streamId`. Idempotent. No event is
   * delivered after the cancel, and the run ends in one terminal `cancelled` event.
   */
  cancelStream(options: CancelStreamOptions): Promise<void>;
  /**
   * Reads a byte range of an engine-owned media artifact a run produced. Like `run(request)`,
   * the request is passed at the options root. See `BridgedArtifactChunk` for how `bytes`
   * crosses the boundary.
   */
  readArtifact(request: ArtifactReadRequest): Promise<BridgedArtifactChunk>;
  /** Releases an engine-owned artifact's bytes. Idempotent; the artifact is passed at the options root. */
  disposeArtifact(artifact: MediaArtifact): Promise<void>;
  /**
   * Closes the engine the last `configure()` built: in-flight streams and prepares end in their
   * cancelled terminal, in-flight runs finish, engine-owned artifacts are disposed. Then the
   * speech providers and neural runtimes built from `configure()`'s options are released, with
   * the models they loaded. Every later call fails the way the closed engine fails it
   * (`Unavailable`, `details.code: "engine_closed"`; `checkCapabilities()` reports no
   * providers) until `configure()` builds a new one. Closing an unconfigured or already closed
   * plugin does nothing.
   */
  close(): Promise<void>;
  addListener(
    eventName: "indeRunStreamEvent",
    listenerFunc: (notification: StreamEventNotification) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "indeRunStreamError",
    listenerFunc: (notification: StreamErrorNotification) => void
  ): Promise<PluginListenerHandle>;
  /** Removes every listener this plugin holds, for both event names. */
  removeAllListeners(): Promise<void>;
}
