import type { StreamRunHandle, TaskRequest, TaskResult } from "@independo/inderun-contracts";
import { registerPlugin } from "@capacitor/core";
import type {
  CancelStreamOptions,
  CheckCapabilitiesResult,
  ConfigureOptions,
  IndeRunCapacitorPlugin as IndeRunCapacitorPluginContract,
  OnnxProviderBootstrapOptions,
  OpenAIProviderBootstrapOptions,
  ProviderCapabilitySnapshot,
  ProviderDescriptor,
  ProviderDynamicCapabilities,
  StartStreamOptions,
  StreamErrorNotification,
  StreamEventNotification,
  StreamRun,
  SystemModelProviderBootstrapOptions
} from "./definitions.js";
import { normalizePluginError } from "./errors.js";
import { startCapacitorStream } from "./streaming.js";

const IndeRunCapacitorNative = registerPlugin<IndeRunCapacitorPluginContract>("IndeRunCapacitor", {
  web: () => import("./web.js").then((module) => new module.IndeRunWeb())
});

/**
 * The plugin contract plus the ergonomic Mode 2 entry point. `stream()` is not a
 * plugin method — it is `startStream`, the event listeners, and `cancelStream`
 * reassembled into the same shape the platform SDKs return from `stream()`.
 */
export interface IndeRunCapacitorApi extends Omit<IndeRunCapacitorPluginContract, "checkCapabilities"> {
  stream(request: TaskRequest): Promise<StreamRun>;
  /** The plugin's `{ providers }` envelope, unwrapped to match the platform SDKs. */
  checkCapabilities(): Promise<ProviderCapabilitySnapshot[]>;
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

  async cancelStream(options: CancelStreamOptions): Promise<void> {
    try {
      await IndeRunCapacitorNative.cancelStream(options);
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
  }
};

export interface IndeRunCapacitorInstance {
  run(request: TaskRequest): Promise<TaskResult>;
  stream(request: TaskRequest): Promise<StreamRun>;
  checkCapabilities(): Promise<ProviderCapabilitySnapshot[]>;
}

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
    }
  };
}

export { STREAM_ERROR_NAME, STREAM_EVENT_NAME } from "./streaming.js";

export type {
  CancelStreamOptions,
  CheckCapabilitiesResult,
  ConfigureOptions,
  IndeRunCapacitorPluginContract as IndeRunCapacitorPlugin,
  OnnxProviderBootstrapOptions,
  OpenAIProviderBootstrapOptions,
  ProviderCapabilitySnapshot,
  ProviderDescriptor,
  ProviderDynamicCapabilities,
  StartStreamOptions,
  StreamErrorNotification,
  StreamEventNotification,
  StreamRun,
  SystemModelProviderBootstrapOptions,
  TaskRequest,
  TaskResult
};

export type * from "@independo/inderun-contracts";
