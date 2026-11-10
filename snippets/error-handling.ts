import { createIndeRunCapacitor, type TaskRequest } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor();
const request: TaskRequest = {
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Hello."
};

try {
  await inderun.run(request);
} catch (error) {
  if (error && typeof error === "object" && "errorClass" in error) {
    // error.errorClass is one of the IndeRun error taxonomy values
  }
}
