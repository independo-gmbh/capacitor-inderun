import { createIndeRunCapacitor, type ModelPackage } from "@independo/capacitor-inderun";

const modelPackage: ModelPackage = {
  id: "my-model",
  format: "genai",
  tasks: ["text_to_text"],
  source: { sourceType: "app_managed", ref: "models/my-model" }
};

const inderun = createIndeRunCapacitor({ onnx: { modelPackage } });

const result = await inderun.run({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Summarize why a thin bridge matters.",
  constraints: { privacy: "local_required" }
});
