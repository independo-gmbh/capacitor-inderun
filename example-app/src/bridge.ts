/**
 * The only module that talks to the plugin.
 *
 * It calls the low-level `IndeRunCapacitor` surface directly rather than holding a
 * `createIndeRunCapacitor()` handle, because this demo reconfigures at runtime.
 * `createIndeRunCapacitor()` memoizes `configure()` for the handle's lifetime with no way to
 * invalidate it, so a provider toggle would mean throwing the handle away and rebuilding one
 * per click — which teaches the opposite of the documented lifecycle ("safe to call once at
 * app startup"). The fingerprint below is that memoization plus invalidation, in ten lines.
 *
 * Re-`configure()`ing is cheap and safe: both native sides replace the provider registry
 * wholesale, and the registry is only read when a run or a stream starts, so reconfiguring
 * does not disturb a stream already in flight. That is exactly what a settings screen needs.
 * A real app that never changes its providers should still use `createIndeRunCapacitor()`.
 */
import { Capacitor } from "@capacitor/core";
import {
  IndeRunCapacitor,
  type ConfigureOptions,
  type ProviderCapabilitySnapshot,
  type StreamRun,
  type TaskRequest,
  type TaskResult
} from "@independo/capacitor-inderun";
import { DEFAULT_MODEL, ONNX_MODEL_ID } from "./config.js";
import type { Privacy } from "./stream-state.js";

export type Platform = "web" | "ios" | "android" | string;

export function platform(): Platform {
  return Capacitor.getPlatform();
}

/** Only the web fallback can be handed extra provider bootstrap; native owns its own. */
export function isWeb(): boolean {
  return platform() === "web";
}

export interface BootstrapChoice {
  cloud: boolean;
  systemModel: boolean;
  endpointUrl: string;
  model: string;
}

export function buildConfigureOptions(choice: BootstrapChoice): ConfigureOptions {
  const options: ConfigureOptions = {};

  if (choice.cloud) {
    const endpointUrl = choice.endpointUrl.trim();
    options.openAI = {
      model: choice.model.trim() || DEFAULT_MODEL,
      // No credentials in this app, ever: the proxy holds them.
      auth: "none",
      ...(endpointUrl.length > 0 ? { endpointUrl } : {})
    };
  }

  // Both keys are web-only and ignored on native, which registers Apple Foundation Models
  // or ML Kit GenAI from configure() regardless of what is passed here.
  if (choice.systemModel && isWeb()) {
    options.systemModel = {};
  }

  if (ONNX_MODEL_ID.length > 0 && isWeb()) {
    options.onnx = {
      modelPackage: {
        id: ONNX_MODEL_ID,
        format: "onnx",
        tasks: ["text_to_text"],
        // `registry` is the Hugging Face-style repo case; the runtime reads `source.ref`.
        source: { sourceType: "registry", ref: ONNX_MODEL_ID }
      }
    };
  }

  return options;
}

/** True when the choice registers nothing the engine could route to. */
export function registersNothing(options: ConfigureOptions): boolean {
  return !options.openAI && !options.systemModel && !options.onnx && isWeb();
}

export interface RequestChoice {
  prompt: string;
  privacy: Privacy;
  optimizeFor: string;
  timeoutMs: number | null;
}

export function buildRequest(choice: RequestChoice): TaskRequest {
  const request: TaskRequest = {
    schemaVersion: "1.0",
    task: { kind: "text_to_text" },
    prompt: choice.prompt,
    constraints: {
      privacy: choice.privacy,
      ...(choice.timeoutMs !== null ? { timeoutMs: choice.timeoutMs } : {})
    }
  };

  if (choice.optimizeFor.length > 0) {
    request.preferences = {
      optimizeFor: choice.optimizeFor as NonNullable<TaskRequest["preferences"]>["optimizeFor"]
    };
  }

  return request;
}

let configuredKey: string | null = null;

async function ensureConfigured(options: ConfigureOptions): Promise<void> {
  const key = JSON.stringify(options);
  if (key === configuredKey) {
    return;
  }
  await IndeRunCapacitor.configure(options);
  configuredKey = key;
}

export async function capabilities(
  options: ConfigureOptions
): Promise<ProviderCapabilitySnapshot[]> {
  await ensureConfigured(options);
  return IndeRunCapacitor.checkCapabilities();
}

export async function run(
  options: ConfigureOptions,
  request: TaskRequest
): Promise<TaskResult> {
  await ensureConfigured(options);
  return IndeRunCapacitor.run(request);
}

export async function stream(
  options: ConfigureOptions,
  request: TaskRequest
): Promise<StreamRun> {
  await ensureConfigured(options);
  return IndeRunCapacitor.stream(request);
}
