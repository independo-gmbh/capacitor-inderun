import type { PluginListenerHandle } from "@capacitor/core";
import type {
  IndeRunError,
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

export interface ConfigureOptions {
  openAI?: OpenAIProviderBootstrapOptions;
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

export interface IndeRunCapacitorPlugin {
  configure(options?: ConfigureOptions): Promise<void>;
  run(request: TaskRequest): Promise<TaskResult>;
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
