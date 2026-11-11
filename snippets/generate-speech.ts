import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({ systemSpeech: true });

const speech = await inderun.generateSpeech({
  text: "Der Bus kommt.",
  locale: "de-AT",
  mediaTypes: ["audio/wav"]
});

try {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await inderun.readArtifact({ artifactId: speech.artifact.id, offset });
    chunks.push(chunk.bytes);
    offset += chunk.bytes.byteLength;
    if (chunk.done) {
      break;
    }
  }
  const wav = new Blob(chunks as BlobPart[], { type: speech.artifact.mediaType });
  console.log(wav.size, speech.artifact.mediaType);
} finally {
  await inderun.disposeArtifact(speech.artifact);
}
