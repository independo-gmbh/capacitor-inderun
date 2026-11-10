import { createIndeRunCapacitor, type IndeRunError } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor();

// What can run here, right now. Availability changes, so ask again instead of caching.
for (const provider of await inderun.checkCapabilities()) {
  console.log(provider.providerId, provider.capabilities.available, provider.capabilities.reason);
}

try {
  const result = await inderun.run({
    schemaVersion: "1.0",
    task: { kind: "text_to_text" },
    prompt: "Summarize why a thin bridge matters.",
    constraints: { privacy: "local_required" }
  });

  console.log(result.output.text);
  // Where it ran: provenance names the provider and its locality.
  console.log(result.provenance?.providerId, result.provenance?.locality); // e.g. "on_device"
} catch (error) {
  if (error && typeof error === "object" && "errorClass" in error) {
    // `local_required` never leaves the device. When no local provider can serve the request,
    // it is refused here, for example with errorClass "CapabilityMismatch".
    const { errorClass, provenance } = error as IndeRunError;
    console.log(errorClass, provenance?.routeRejections);
  }
}
