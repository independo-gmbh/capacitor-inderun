import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({
  openAI: {
    models: ["gpt-5.2", "gpt-5-mini"],
    endpointUrl: "https://example.com/api/inderun/openai-responses",
    auth: "none"
  },
  modelProfiles: {
    smart: ["openai:gpt-5.2"],
    fast: ["openai:gpt-5-mini"]
  }
});

const result = await inderun.run({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Summarize why a thin bridge matters.",
  constraints: { privacy: "cloud_allowed" },
  modelProfile: "fast"
});

console.log(result.provenance?.providerId); // "openai:gpt-5-mini"
