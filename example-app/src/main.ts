import {
  createIndeRunCapacitor,
  type IndeRunCapacitorInstance,
  type StreamEvent,
  type StreamRun,
  type TaskRequest
} from "@independo/capacitor-inderun";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const endpointInput = el<HTMLInputElement>("endpoint");
const modelInput = el<HTMLInputElement>("model");
const promptInput = el<HTMLTextAreaElement>("prompt");
const runButton = el<HTMLButtonElement>("run");
const streamButton = el<HTMLButtonElement>("stream");
const cancelButton = el<HTMLButtonElement>("cancel");
const twoButton = el<HTMLButtonElement>("two");
const statusLine = el<HTMLParagraphElement>("status");
const output = el<HTMLDivElement>("output");
const log = el<HTMLPreElement>("log");

/** The run the Cancel button acts on. */
let active: StreamRun | null = null;

function reset(): void {
  output.textContent = "";
  log.textContent = "";
}

function append(line: string, isError = false): void {
  const row = document.createElement("span");
  row.textContent = `${line}\n`;
  if (isError) {
    row.className = "err";
  }
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function setStatus(text: string): void {
  statusLine.textContent = text;
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "errorClass" in error) {
    const contract = error as { errorClass: string; message?: string };
    return `${contract.errorClass}: ${contract.message ?? "(no message)"}`;
  }
  return String(error);
}

/**
 * Rebuilt per action so the endpoint and model fields can be edited between runs;
 * a real app would configure once at startup.
 */
function engine(): IndeRunCapacitorInstance {
  const endpointUrl = endpointInput.value.trim();
  return createIndeRunCapacitor({
    openAI: {
      model: modelInput.value.trim() || "gpt-5.2",
      // No credentials in the app: point at a proxy that holds them.
      auth: "none",
      ...(endpointUrl.length > 0 ? { endpointUrl } : {})
    }
  });
}

function request(): TaskRequest {
  return {
    schemaVersion: "1.0",
    task: { kind: "text_to_text" },
    prompt: promptInput.value
  };
}

/**
 * Accumulates one run's user-visible text exactly as a consumer must: deltas append,
 * snapshots *replace* — so an empty snapshot retracts everything delivered so far.
 */
function consume(event: StreamEvent, current: string): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === "content_delta") {
    return current + String(payload["text"] ?? "");
  }
  if (event.type === "content_snapshot") {
    return String(payload["text"] ?? "");
  }
  return current;
}

async function drain(run: StreamRun, label: string, render: (text: string) => void): Promise<void> {
  let text = "";
  try {
    for await (const event of run.events) {
      append(`${label} ${event.runId} · ${event.sequence} · ${event.type}`);
      text = consume(event, text);
      render(text);

      if (event.type === "terminal") {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const outcome = String(payload["outcome"]);
        append(`${label} terminal outcome: ${outcome}`);
        if (outcome === "completed") {
          append(`${label} finalText matches screen: ${payload["finalText"] === text}`);
        } else if (outcome === "cancelled") {
          append(`${label} partialText: ${JSON.stringify(payload["partialText"])}`);
        } else {
          const error = payload["error"] as { errorClass?: string } | undefined;
          append(`${label} error class: ${error?.errorClass}`, true);
        }
      }
    }
    append(`${label} sequence ended normally.`);
  } catch (error) {
    // A transport failure, not a run outcome — a failed run ends in a terminal event.
    append(`${label} iterable threw: ${describeError(error)}`, true);
  }
}

runButton.addEventListener("click", async () => {
  reset();
  setStatus("Running (Mode 1)…");
  try {
    const result = await engine().run(request());
    output.textContent = result.output.text;
    append(`run ${result.runId} · ${result.finishReason} · ${result.telemetry.providerUsed}`);
    setStatus("Run complete.");
  } catch (error) {
    append(`run rejected: ${describeError(error)}`, true);
    setStatus("Run failed.");
  }
});

streamButton.addEventListener("click", async () => {
  reset();
  setStatus("Starting stream…");
  streamButton.disabled = true;

  try {
    const run = await engine().stream(request());
    active = run;
    cancelButton.disabled = false;
    // The handle is available before any event arrives.
    append(`handle runId=${run.handle.runId} providerId=${run.handle.providerId ?? "(pending)"}`);
    setStatus("Streaming…");

    await drain(run, "·", (text) => {
      output.textContent = text;
    });
    setStatus("Stream finished.");
  } catch (error) {
    // Validation and route-selection failures reject here rather than arriving as events.
    append(`stream() rejected: ${describeError(error)}`, true);
    setStatus("Stream rejected.");
  } finally {
    active = null;
    cancelButton.disabled = true;
    streamButton.disabled = false;
  }
});

cancelButton.addEventListener("click", () => {
  // Idempotent, and a no-op once the terminal has arrived.
  active?.cancel("cancelled from the example app");
  append("cancel() called.");
});

twoButton.addEventListener("click", async () => {
  reset();
  setStatus("Starting two concurrent runs…");
  twoButton.disabled = true;

  const inderun = engine();
  const texts: Record<string, string> = { A: "", B: "" };
  const render = (label: "A" | "B") => (text: string) => {
    texts[label] = text;
    output.textContent = `A: ${texts["A"]}\n\nB: ${texts["B"]}`;
  };

  try {
    const [first, second] = await Promise.all([
      inderun.stream(request()),
      inderun.stream(request())
    ]);
    append(`A runId=${first.handle.runId}`);
    append(`B runId=${second.handle.runId}`);
    append(`distinct runIds: ${first.handle.runId !== second.handle.runId}`);

    await Promise.all([drain(first, "A", render("A")), drain(second, "B", render("B"))]);
    setStatus("Both runs finished.");
  } catch (error) {
    append(`concurrent start rejected: ${describeError(error)}`, true);
    setStatus("Concurrent runs failed.");
  } finally {
    twoButton.disabled = false;
  }
});
