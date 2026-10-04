import type { PluginListenerHandle } from "@capacitor/core";
import type {
  IndeRunError,
  ModelPackage,
  StreamEvent,
  StreamRunHandle,
  TaskRequest,
  TaskResult
} from "@independo/inderun-contracts";

export interface OpenAIProviderBootstrapOptions {
  model: string;
  endpointUrl?: string;
  auth?: "authContextRef" | "none";
  authContextRef?: string;
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
  id?: string;
  timeoutMs?: number;
}

/**
 * Bootstrap options for the Web ONNX Runtime provider, for a developer-supplied local
 * model.
 *
 * **Web only**, like `systemModel`, and Mode 1 only.
 *
 * Two caveats worth knowing before reaching for this. The consumer has to install the
 * optional `@huggingface/transformers` peer dependency — this bridge does not declare it —
 * and supply real model weights, because the web SDK's `runtime` seam is a function and so
 * cannot cross the JSON bridge hop: only the default Transformers.js runtime is reachable
 * from here, never the fixture runtime the upstream demos use offline. A registered
 * provider that cannot load turns a clean routing refusal into a provider error, so
 * register it only when the weights are actually there.
 */
export interface OnnxProviderBootstrapOptions {
  id?: string;
  modelPackage: ModelPackage;
  timeoutMs?: number;
}

export interface ConfigureOptions {
  openAI?: OpenAIProviderBootstrapOptions;
  /** Web only; native registers its own on-device provider. */
  systemModel?: SystemModelProviderBootstrapOptions;
  /** Web only; native registers its own on-device provider. */
  onnx?: OnnxProviderBootstrapOptions;
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
 * A provider's static capability declaration.
 *
 * Declared here rather than imported, because — unlike `TaskRequest`, `StreamEvent` and
 * the rest — this shape is *not* a generated contract. There is no schema for it in
 * `@independo/inderun-contracts` and no validator; each SDK declares it independently
 * (`core/provider.d.ts` in `@independo/inderun-web`, `IndeRunCore/Provider.swift`,
 * `core/Provider.kt`), and this is the fourth copy. Importing it from
 * `@independo/inderun-web` is not an option either: that would make the native
 * platforms' plugin contract depend on the web SDK.
 *
 * The drift guard is in `web.ts`, which returns the web SDK's value into this type
 * uncast — so `tsc` proves the shapes still match on every build, the same way the
 * `StreamRun` mirror below is checked. See the upstream follow-up asking for a schema.
 */
export interface ProviderDescriptor {
  id: string;
  type: "local" | "edge" | "cloud";
  transport: "in_process" | "system_service" | "http" | "sse" | "realtime";
  streamingStyle?: "tokens" | "chunks" | "snapshots";
  supports: {
    run: boolean;
    streaming: boolean;
    realtime: boolean;
    tools: boolean;
    reasoningEvents: boolean;
    structuredOutput: boolean;
    multimodal: boolean;
  };
  cancel: "hard" | "soft" | "none";
  tasks: string[];
  limits?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxImageBytes?: number;
    maxAudioSeconds?: number;
  };
  privacy?: {
    dataLeavesDevice: boolean;
    regions?: string[];
  };
}

/**
 * A provider's live availability, as of the moment `checkCapabilities()` was called.
 *
 * `streamingAvailable` and `cancellationAvailable` are **absent**, not `null`, when the
 * runtime has nothing to say: absence means *inherit the static declaration*
 * (`descriptor.supports.streaming`, and `descriptor.cancel !== "none"`). Both native
 * encoders omit the key rather than emitting null for exactly that reason.
 */
export interface ProviderDynamicCapabilities {
  available: boolean;
  reason?: string;
  streamingAvailable?: boolean;
  streamingUnavailableReason?: string;
  cancellationAvailable?: boolean;
}

/** One registered provider's identity, static declaration, and live availability. */
export interface ProviderCapabilitySnapshot {
  providerId: string;
  descriptor: ProviderDescriptor;
  capabilities: ProviderDynamicCapabilities;
}

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
  configure(options?: ConfigureOptions): Promise<void>;
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
  cancelStream(options: CancelStreamOptions): Promise<void>;
  addListener(
    eventName: "indeRunStreamEvent",
    listenerFunc: (notification: StreamEventNotification) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "indeRunStreamError",
    listenerFunc: (notification: StreamErrorNotification) => void
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
