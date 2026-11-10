import type { ArtifactChunk, BridgedArtifactChunk } from "./definitions.js";
import { createBridgeError } from "./errors.js";

/**
 * Turns the `readArtifact` result the plugin resolved back into the contract's
 * `ArtifactChunk`. Native sends `bytes` as base64, because a Capacitor call resolves JSON;
 * the web implementation sends the engine's `Uint8Array`, which is passed through untouched
 * rather than encoded and decoded for nothing.
 */
export function decodeArtifactChunk(chunk: BridgedArtifactChunk): ArtifactChunk {
  // Whatever native resolved is untyped at runtime; a chunk without bytes is a transport
  // fault, reported like a malformed stream handle rather than passed on as `undefined`.
  const bytes: unknown = chunk.bytes;
  if (typeof bytes !== "string" && !(bytes instanceof Uint8Array)) {
    throw createBridgeError(
      "Capacitor bridge received an ArtifactChunk without bytes from the native plugin."
    );
  }
  return {
    artifactId: chunk.artifactId,
    offset: chunk.offset,
    bytes: typeof bytes === "string" ? decodeBase64(bytes) : bytes,
    totalBytes: chunk.totalBytes,
    done: chunk.done
  };
}

/** `atob` rather than Node's `Buffer`: this runs in a webview. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
