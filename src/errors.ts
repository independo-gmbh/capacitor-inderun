import { validateIndeRunError, type IndeRunError } from "@independo/inderun-contracts";

/**
 * Unwraps whatever the Capacitor boundary hands back into the canonical
 * `IndeRunError` the native side rejected with.
 *
 * Capacitor wraps a native rejection's structured data under `error.data`, so a
 * thrown value is either already an `IndeRunError` (the web implementation throws
 * one directly) or carries one there. Anything else is passed through untouched
 * rather than guessed at.
 */
export function normalizePluginError(error: unknown): unknown {
  if (validateIndeRunError(error)) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    validateIndeRunError((error as { data?: unknown }).data)
  ) {
    return (error as { data: IndeRunError }).data;
  }

  return error;
}

/**
 * Mints an `IndeRunError` for a failure of the bridge itself — event loss across
 * the JS boundary, a malformed handle — as opposed to one reported by a provider
 * or the engine. `Internal` is the correct class: nothing about the request or the
 * provider is at fault, the transport is.
 */
export function createBridgeError(message: string, runId?: string): IndeRunError {
  return {
    schemaVersion: "1.0",
    errorClass: "Internal",
    message,
    ...(runId !== undefined ? { runId } : {})
  };
}
