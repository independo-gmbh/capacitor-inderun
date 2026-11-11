import { createIndeRunCapacitor, type ModelPackage } from "@independo/capacitor-inderun";

// What `model-package.json` describes, trimmed to the fields that matter here. The source says
// where the app put the files, and each file's checksum is verified before it is loaded.
const modelPackage: ModelPackage = {
  id: "my-voice",
  version: "1",
  format: "onnx",
  tasks: ["text_to_speech"],
  source: { sourceType: "app_managed", ref: "models/voice" },
  integrity: { checksums: { "text.onnx": "sha256:<hex digest of the downloaded file>" } },
  speech: {
    pipeline: "articulino",
    sampleRate: 24000,
    channels: 1,
    graphs: { text: "text.onnx", dit_step: "dit_step.onnx", decoder: "decoder.onnx" },
    voices: [{ id: "de-at-m-1", name: "Max", locales: ["de-AT"], gender: "male", file: "voices/de-at-m-1.safetensors" }]
  }
};

const inderun = createIndeRunCapacitor({
  systemSpeech: true,
  neuralSpeech: [{ modelPackage }]
});

// Optional. Loads and verifies the model now, so the first `speak()` does not pay for it.
const preparation = await inderun.prepare({ tasks: ["text_to_speech"] });
for await (const event of preparation.events) {
  if (event.type === "terminal") {
    console.log(event.payload?.outcome);
  }
}
