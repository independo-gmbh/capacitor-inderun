import type {
  ArtifactReadRequest,
  MediaArtifact,
  PrepareRequest,
  StreamRunHandle,
  TaskRequest,
  TaskResult
} from "@independo/inderun-contracts";
import type { IndeRunApi } from "@independo/inderun-web";
import { registerPlugin } from "@capacitor/core";
import type {
  ArtifactChunk,
  BridgedArtifactChunk,
  CancelStreamOptions,
  CheckCapabilitiesResult,
  ConfigureOptions,
  IndeRunCapacitorPlugin as IndeRunCapacitorPluginContract,
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
  SystemModelProviderBootstrapOptions
} from "./definitions.js";
import { decodeArtifactChunk } from "./artifacts.js";
import { normalizePluginError } from "./errors.js";
import { startCapacitorPrepare, startCapacitorStream } from "./streaming.js";

const IndeRunCapacitorNative = registerPlugin<IndeRunCapacitorPluginContract>("IndeRunCapacitor", {
  web: () => import("./web.js").then((module) => new module.IndeRunWeb())
});

/**
 * The plugin contract plus the ergonomic Mode 2 entry points. `stream()` and `prepare()`
 * are not plugin methods — each is `startStream` / `startPrepare`, the event listeners,
 * and `cancelStream` reassembled into the same shape the platform SDKs return.
 */
export interface IndeRunCapacitorApi
  extends Omit<IndeRunCapacitorPluginContract, "checkCapabilities" | "readArtifact"> {
  stream(request: TaskRequest): Promise<StreamRun>;
  prepare(request: PrepareRequest): Promise<StreamRun>;
  /** The plugin's `{ providers }` envelope, unwrapped to match the platform SDKs. */
  checkCapabilities(): Promise<ProviderCapabilitySnapshot[]>;
  /** The plugin's base64 transport decoded back into bytes, matching the platform SDKs. */
  readArtifact(request: ArtifactReadRequest): Promise<ArtifactChunk>;
}

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
 */
export interface IndeRunCapacitorInstance {
  run(request: TaskRequest): Promise<TaskResult>;
  stream(request: TaskRequest): Promise<StreamRun>;
  checkCapabilities(): Promise<ProviderCapabilitySnapshot[]>;
  prepare(request: PrepareRequest): Promise<StreamRun>;
  readArtifact(request: ArtifactReadRequest): Promise<ArtifactChunk>;
  disposeArtifact(artifact: MediaArtifact): Promise<void>;
  close(): Promise<void>;
}

/**
 * Compile-time guard: the instance must stay assignable to the web SDK's `IndeRunApi`, the
 * type its facade functions take. Lives here rather than in a test because `pnpm lint`
 * does not compile the test files.
 */
type AssertIndeRunApi<T extends IndeRunApi> = T;
type _InstanceIsIndeRunApi = AssertIndeRunApi<IndeRunCapacitorInstance>;

export function createIndeRunCapacitor(options?: ConfigureOptions): IndeRunCapacitorInstance {
  let configured: Promise<void> | null = null;

  function ensureConfigured(): Promise<void> {
    configured ??= IndeRunCapacitor.configure(options).catch((error) => {
      configured = null;
      throw error;
    });
    return configured;
  }

  return {
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
    }
  };
}

export { STREAM_ERROR_NAME, STREAM_EVENT_NAME } from "./streaming.js";

export type {
  ArtifactChunk,
  BridgedArtifactChunk,
  CancelStreamOptions,
  CheckCapabilitiesResult,
  ConfigureOptions,
  IndeRunCapacitorPluginContract as IndeRunCapacitorPlugin,
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
  TaskRequest,
  TaskResult
};

export type * from "@independo/inderun-contracts";
