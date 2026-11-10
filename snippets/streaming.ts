import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor();

const run = await inderun.stream({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Explain routing in two sentences."
});

console.log(run.handle.runId); // available before the first event

let text = "";
for await (const event of run.events) {
  switch (event.type) {
    case "content_delta":
      text += event.payload?.text ?? ""; // append
      break;
    case "content_snapshot":
      text = event.payload?.text ?? ""; // replace — an empty one retracts
      break;
    case "terminal":
      // exactly one of "completed" | "error" | "cancelled"
      console.log(event.payload?.outcome);
      break;
  }
}

run.cancel("user navigated away"); // idempotent; a no-op after the terminal
