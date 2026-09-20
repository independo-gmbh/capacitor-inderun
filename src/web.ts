import type { StreamRunHandle, TaskResult } from "@independo/inderun-contracts";
import { WebPlugin } from "@capacitor/core";
import { createIndeRunWeb, createUnavailable, toIndeRunException } from "@independo/inderun-web";
import type {
  CancelStreamOptions,
  ConfigureOptions,
  IndeRunCapacitorPlugin,
  StartStreamOptions,
  StreamRun
} from "./definitions.js";
import type { TaskRequest } from "@independo/inderun-contracts";
import type { IndeRun } from "@independo/inderun-web";
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
    if (!options?.openAI) {
      throw createUnavailable(
        "Capacitor web execution requires OpenAI provider registration. Configure with openAI bootstrap options before calling run(request)."
      ).toContractError();
    }

    try {
      const webOptions: {
        openAI: {
          model: string;
          endpointUrl?: string;
          auth?: "authContextRef" | "none";
          authContextRef?: string;
          timeoutMs?: number;
        };
        allowDirectOpenAIEndpoint?: boolean;
      } = {
        openAI: compactOpenAIOptions(options)
      };

      if (options.allowDirectOpenAIEndpoint !== undefined) {
        webOptions.allowDirectOpenAIEndpoint = options.allowDirectOpenAIEndpoint;
      }

      this.engine = createIndeRunWeb(webOptions);
    } catch (error) {
      throw toIndeRunException(error).toContractError();
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
    if (!this.engine) {
      throw createUnavailable(
        "Capacitor IndeRun has not been configured. Configure providers before calling stream(request)."
      ).toContractError();
    }

    this.startingStreams.add(options.streamId);

    let run: StreamRun;
    try {
      run = await this.engine.stream(options.request);
    } catch (error) {
      this.startingStreams.delete(options.streamId);
      this.pendingCancels.delete(options.streamId);
      throw toIndeRunException(error).toContractError();
    }

    this.startingStreams.delete(options.streamId);
    this.activeStreams.set(options.streamId, run);

    if (this.pendingCancels.has(options.streamId)) {
      const reason = this.pendingCancels.get(options.streamId);
      this.pendingCancels.delete(options.streamId);
      run.cancel(reason);
    }

    // Pump on a later microtask so this call's handle settles first.
    queueMicrotask(() => void this.pump(options.streamId, run));
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

function compactOpenAIOptions(options: ConfigureOptions): {
  model: string;
  endpointUrl?: string;
  auth?: "authContextRef" | "none";
  authContextRef?: string;
  timeoutMs?: number;
} {
  const openAI = options.openAI!;
  const result: {
    model: string;
    endpointUrl?: string;
    auth?: "authContextRef" | "none";
    authContextRef?: string;
    timeoutMs?: number;
  } = {
    model: openAI.model
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
