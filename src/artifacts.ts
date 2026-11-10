import type { ArtifactChunk, BridgedArtifactChunk } from "./definitions.js";

/**
 * Turns the `readArtifact` result the plugin resolved back into the contract's
 * `ArtifactChunk`. Native sends `bytes` as base64, because a Capacitor call resolves JSON;
 * the web implementation sends the engine's `Uint8Array`, which is passed through untouched
 * rather than encoded and decoded for nothing.
 */
export function decodeArtifactChunk(chunk: BridgedArtifactChunk): ArtifactChunk {
  return {
    artifactId: chunk.artifactId,
    offset: chunk.offset,
    bytes: typeof chunk.bytes === "string" ? decodeBase64(chunk.bytes) : chunk.bytes,
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
