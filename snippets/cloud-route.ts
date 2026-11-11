import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({
  openAI: {
    models: ["gpt-5.2"],
    // Your own backend, which holds the API key. The app never sees it.
    endpointUrl: "https://example.com/api/inderun/openai-responses",
    auth: "none"
  }
});

const result = await inderun.run({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Summarize why a thin bridge matters.",
  constraints: { privacy: "local_preferred" }
});

console.log(result.provenance?.locality); // "on_device" or "cloud"
