/**
 * UI wiring. Controls are static markup in index.html; only the capability panel, the
 * refusal panel and the run panes are rendered from here.
 *
 * Each run pane owns its own DOM and mutates it in place rather than being re-rendered from
 * a state object. Re-rendering a transcript on every token would reset its scroll position
 * and drop the caret, which is the thing the pane exists to show.
 */
import type { ProviderCapabilitySnapshot, StreamRun } from "@independo/capacitor-inderun";
import {
  buildConfigureOptions,
  buildRequest,
  capabilities,
  isWeb,
  platform,
  registersNothing,
  run as runOnce,
  stream as startStream
} from "./bridge.js";
import { DEFAULT_ENDPOINT_URL, DEFAULT_MODEL, ONNX_MODEL_ID } from "./config.js";
import { applyEvent, createPane, type Privacy, type RunPane } from "./stream-state.js";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const controls = {
  platform: el<HTMLSpanElement>("platform"),
  platformNote: el<HTMLParagraphElement>("platform-note"),
  capabilities: el<HTMLDivElement>("capabilities"),
  refreshButton: el<HTMLButtonElement>("refresh"),
  privacyGroup: el<HTMLDivElement>("privacy"),
  optimize: el<HTMLSelectElement>("optimize"),
  timeout: el<HTMLInputElement>("timeout"),
  useCloud: el<HTMLInputElement>("use-cloud"),
  useSystemModel: el<HTMLInputElement>("use-system-model"),
  useSystemModelRow: el<HTMLLabelElement>("use-system-model-row"),
  endpoint: el<HTMLInputElement>("endpoint"),
  model: el<HTMLInputElement>("model"),
  prompt: el<HTMLTextAreaElement>("prompt"),
  runButton: el<HTMLButtonElement>("run"),
  streamButton: el<HTMLButtonElement>("stream"),
  cancelButton: el<HTMLButtonElement>("cancel"),
  twoButton: el<HTMLButtonElement>("two"),
  diagnosticsButton: el<HTMLButtonElement>("diagnostics"),
  status: el<HTMLParagraphElement>("status"),
  refusalSection: el<HTMLElement>("refusal-section"),
  refusal: el<HTMLDivElement>("refusal"),
  panes: el<HTMLDivElement>("panes")
};

let privacy: Privacy = "cloud_allowed";
let showEventLogs = false;
/** Every stream currently in flight, so Cancel acts on all of them. */
const liveRuns = new Set<StreamRun>();

// ---------------------------------------------------------------- small helpers

function setStatus(text: string): void {
  controls.status.textContent = text;
}

function chip(text: string, tone?: "ok" | "warn" | "bad" | "accent"): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = tone ? `chip ${tone}` : "chip";
  span.textContent = text;
  return span;
}

function describeError(error: unknown): { errorClass: string; message: string } {
  if (error && typeof error === "object" && "errorClass" in error) {
    const contract = error as { errorClass: string; message?: string };
    return { errorClass: contract.errorClass, message: contract.message ?? "(no message)" };
  }
  return { errorClass: "(not a contract error)", message: String(error) };
}

function errorDetails(error: unknown): Record<string, unknown> | null {
  if (error && typeof error === "object" && "details" in error) {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === "object") {
      return details as Record<string, unknown>;
    }
  }
  return null;
}

function currentOptions() {
  return buildConfigureOptions({
    cloud: controls.useCloud.checked,
    systemModel: controls.useSystemModel.checked,
    endpointUrl: controls.endpoint.value,
    model: controls.model.value
  });
}

function currentRequest() {
  const raw = controls.timeout.value.trim();
  const timeoutMs = raw.length > 0 ? Number(raw) : null;
  return buildRequest({
    prompt: controls.prompt.value,
    privacy,
    optimizeFor: controls.optimize.value,
    timeoutMs: timeoutMs !== null && Number.isFinite(timeoutMs) ? timeoutMs : null
  });
}

// ---------------------------------------------------------------- capabilities

/**
 * `streamingAvailable` is tri-state on the wire: absent means *inherit* the static
 * `descriptor.supports.streaming`, not "unknown". Only a runtime that can take streaming
 * away from a provider which otherwise declares it sets the flag.
 */
function streamsNow(snapshot: ProviderCapabilitySnapshot): boolean {
  return snapshot.capabilities.streamingAvailable ?? snapshot.descriptor.supports.streaming;
}

function renderCapabilities(snapshots: ProviderCapabilitySnapshot[] | null, error?: unknown): void {
  controls.capabilities.replaceChildren();

  if (error !== undefined) {
    const { errorClass, message } = describeError(error);
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = `checkCapabilities() failed — ${errorClass}: ${message}`;
    controls.capabilities.append(p);
    renderPlatformNote(null);
    return;
  }

  if (snapshots === null || snapshots.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent =
      snapshots === null
        ? "Not checked yet."
        : "No providers registered. Nothing can be routed to — turn one on above.";
    controls.capabilities.append(p);
    renderPlatformNote(snapshots);
    return;
  }

  for (const snapshot of snapshots) {
    const row = document.createElement("div");
    row.className = "provider";

    const id = document.createElement("div");
    id.className = "id";
    id.textContent = snapshot.providerId;
    row.append(id);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.append(
      chip(snapshot.descriptor.type, snapshot.descriptor.type === "local" ? "accent" : undefined),
      chip(snapshot.descriptor.transport),
      chip(snapshot.capabilities.available ? "run ✓" : "run ✗", snapshot.capabilities.available ? "ok" : "bad"),
      chip(streamsNow(snapshot) ? "stream ✓" : "stream ✗", streamsNow(snapshot) ? "ok" : "bad")
    );
    if (snapshot.descriptor.streamingStyle !== undefined) {
      meta.append(chip(`declares ${snapshot.descriptor.streamingStyle}`));
    }
    meta.append(chip(`cancel ${snapshot.descriptor.cancel}`));
    if (snapshot.descriptor.privacy !== undefined) {
      meta.append(
        snapshot.descriptor.privacy.dataLeavesDevice
          ? chip("data leaves device", "warn")
          : chip("stays on device", "ok")
      );
    }
    row.append(meta);

    const reasons = [
      snapshot.capabilities.reason,
      snapshot.capabilities.streamingUnavailableReason
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (reasons.length > 0) {
      const reason = document.createElement("p");
      reason.className = "reason";
      reason.textContent = reasons.join(" · ");
      row.append(reason);
    }

    controls.capabilities.append(row);
  }

  renderPlatformNote(snapshots);
}

/**
 * Derived rather than hand-maintained. A per-platform matrix written into the UI rots the
 * moment upstream ships a provider; the only fixed part is the sentence explaining what the
 * platform's *absence* of a streaming on-device provider means.
 */
function renderPlatformNote(snapshots: ProviderCapabilitySnapshot[] | null): void {
  const lines: string[] = [];

  if (snapshots !== null) {
    const streaming = snapshots.filter(streamsNow).map((snapshot) => snapshot.providerId);
    lines.push(
      streaming.length > 0
        ? `Can stream here: ${streaming.join(", ")}.`
        : "Nothing registered here can stream — every Mode 2 request will be refused at routing time."
    );

    const snapshotStyle = snapshots.filter(
      (snapshot) => snapshot.descriptor.streamingStyle === "snapshots"
    );
    if (snapshotStyle.length > 0) {
      lines.push(
        `${snapshotStyle[0].providerId} streams snapshots, not deltas — the transcript replaces rather than appends.`
      );
    }
  }

  if (isWeb()) {
    lines.push(
      "No web provider streams on-device today, so “Local Only” + Stream is refused here by design — try it. “Local Only” + Run works where the browser's Prompt API is available."
    );
    if (ONNX_MODEL_ID.length === 0) {
      lines.push("VITE_INDERUN_ONNX_MODEL_ID is unset, so the Web ONNX provider is not registered.");
    }
  } else {
    lines.push(
      "The on-device provider is registered by the native plugin regardless of the toggles above; availability is checked at runtime."
    );
  }

  controls.platformNote.textContent = lines.join(" ");
}

async function refreshCapabilities(): Promise<void> {
  controls.refreshButton.disabled = true;
  try {
    renderCapabilities(await capabilities(currentOptions()));
  } catch (error) {
    renderCapabilities(null, error);
  } finally {
    controls.refreshButton.disabled = false;
  }
}

// ---------------------------------------------------------------- refusal panel

/**
 * A **rejection**: `run()`/`stream()` threw, so there is no run id and no events to show —
 * which is why this is a panel of its own rather than a pane. The error's `details` are the
 * only channel that says why each provider was refused.
 */
function renderRefusal(error: unknown): void {
  const { errorClass, message } = describeError(error);
  const details = errorDetails(error);

  const box = document.createElement("div");
  box.className = "refusal";

  const headline = document.createElement("p");
  headline.className = "headline";
  headline.textContent = `${errorClass} — the call itself rejected`;
  box.append(headline);

  const explain = document.createElement("p");
  explain.textContent = message;
  box.append(explain);

  const surface = document.createElement("p");
  surface.className = "note";
  surface.textContent =
    "No run handle and no events: nothing started. This is not the same as a run that started and then failed — that arrives as a terminal event inside a pane.";
  box.append(surface);

  const failureCode = details?.["failureCode"];
  if (typeof failureCode === "string") {
    const code = document.createElement("p");
    code.textContent = `failureCode: ${failureCode}`;
    box.append(code);
  }

  const issues = details?.["validationIssues"];
  if (Array.isArray(issues) && issues.length > 0) {
    box.append(
      table(["Validation issue"], issues.map((issue) => [typeof issue === "string" ? issue : JSON.stringify(issue)]))
    );
  }

  const rejected = details?.["rejectedProviders"];
  if (Array.isArray(rejected) && rejected.length > 0) {
    const rows: string[][] = [];
    for (const entry of rejected) {
      const record = (entry ?? {}) as Record<string, unknown>;
      const providerId = String(record["providerId"] ?? "(unknown)");
      const reasons = Array.isArray(record["reasons"]) ? record["reasons"] : [];
      if (reasons.length === 0) {
        rows.push([providerId, "(no reason given)", ""]);
        continue;
      }
      for (const reason of reasons) {
        const r = (reason ?? {}) as Record<string, unknown>;
        rows.push([providerId, String(r["code"] ?? "(no code)"), String(r["message"] ?? "")]);
      }
    }
    box.append(table(["Provider", "Reason code", "Detail"], rows));
  } else if (details !== null) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "This refusal carried no rejectedProviders list.";
    box.append(note);
  }

  controls.refusal.replaceChildren(box);
  controls.refusalSection.hidden = false;
}

function clearRefusal(): void {
  controls.refusalSection.hidden = true;
  controls.refusal.replaceChildren();
}

function table(headers: string[], rows: string[][]): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "scroll-x";
  const element = document.createElement("table");

  const head = document.createElement("tr");
  for (const header of headers) {
    const th = document.createElement("th");
    th.textContent = header;
    head.append(th);
  }
  element.append(head);

  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      const code = document.createElement("code");
      code.textContent = cell;
      td.append(code);
      tr.append(td);
    }
    element.append(tr);
  }

  wrapper.append(element);
  return wrapper;
}

// ---------------------------------------------------------------- run panes

class PaneView {
  readonly root = document.createElement("div");
  private readonly head = document.createElement("div");
  private readonly transcript = document.createElement("div");
  private readonly caret = document.createElement("span");
  private readonly text = document.createTextNode("");
  private readonly outcome = document.createElement("div");
  private readonly fault = document.createElement("div");
  private readonly logDetails = document.createElement("details");
  private readonly logBody = document.createElement("tbody");
  private lastSnapshotTick = 0;

  constructor() {
    this.root.className = "pane live";
    this.head.className = "head";

    this.transcript.className = "transcript";
    this.caret.className = "caret";
    this.caret.textContent = " ";
    this.transcript.append(this.text, this.caret);

    this.outcome.className = "outcome";
    this.outcome.hidden = true;
    this.fault.className = "fault";
    this.fault.hidden = true;

    this.logDetails.className = "events";
    const summary = document.createElement("summary");
    summary.textContent = "Event log";
    const logTable = document.createElement("table");
    logTable.className = "events";
    const header = document.createElement("tr");
    for (const [label, numeric] of [["seq", true], ["type", false], ["Δms", true]] as const) {
      const th = document.createElement("th");
      th.textContent = label;
      if (numeric) th.className = "num";
      header.append(th);
    }
    logTable.append(header, this.logBody);
    this.logDetails.append(summary, logTable);
    this.logDetails.open = showEventLogs;

    this.root.append(this.head, this.transcript, this.outcome, this.fault, this.logDetails);
  }

  setEventLogOpen(open: boolean): void {
    this.logDetails.open = open;
  }

  update(pane: RunPane): void {
    this.renderHead(pane);

    this.text.nodeValue = pane.text;
    this.caret.hidden = pane.terminal !== null || pane.transportFault !== null;
    this.transcript.scrollTop = this.transcript.scrollHeight;

    if (pane.snapshotTick !== this.lastSnapshotTick) {
      this.lastSnapshotTick = pane.snapshotTick;
      this.flashSnapshot();
    }

    while (this.logBody.childElementCount < pane.events.length) {
      const event = pane.events[this.logBody.childElementCount];
      const tr = document.createElement("tr");
      const seq = document.createElement("td");
      seq.className = "num";
      seq.textContent = String(event.sequence);
      const type = document.createElement("td");
      type.textContent = event.type;
      const delta = document.createElement("td");
      delta.className = "num";
      delta.textContent = event.deltaMs === null ? "—" : String(event.deltaMs);
      tr.append(seq, type, delta);
      this.logBody.append(tr);
    }

    this.renderOutcome(pane);
    this.renderFault(pane);
    this.root.className = pane.terminal || pane.transportFault ? "pane" : "pane live";
  }

  private flashSnapshot(): void {
    this.transcript.classList.add("snapshot-flash");
    window.setTimeout(() => this.transcript.classList.remove("snapshot-flash"), 220);
  }

  private renderHead(pane: RunPane): void {
    this.head.replaceChildren();

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = pane.label;
    this.head.append(label, chip(pane.runId), chip(pane.privacy));

    if (pane.plannedProviderId !== null) {
      this.head.append(chip(`planned ${pane.plannedProviderId}`));
    }
    const served = pane.terminal?.providerUsed;
    if (served !== undefined) {
      this.head.append(chip(`served ${served}`, "ok"));
      if (pane.plannedProviderId !== null && served !== pane.plannedProviderId) {
        // The planned provider is providers[0] of the route plan; a different one serving
        // the run means fallback happened, which is otherwise invisible.
        this.head.append(chip("fell back", "warn"));
      }
    }
    if (pane.observedStyle !== null) {
      this.head.append(chip(`observed ${pane.observedStyle}`, "accent"));
    }
    if (pane.retracted) {
      this.head.append(chip("retracted", "warn"));
    }
  }

  private renderOutcome(pane: RunPane): void {
    const terminal = pane.terminal;
    if (terminal === null) {
      this.outcome.hidden = true;
      return;
    }

    const facts: string[] = [];
    let headline: string;

    if (terminal.outcome === "completed") {
      headline = "completed";
      if (terminal.finishReason !== undefined) facts.push(`finishReason: ${terminal.finishReason}`);
      if (terminal.usage !== undefined) facts.push(`usage: ${JSON.stringify(terminal.usage)}`);
      else facts.push("usage: not reported by this provider");
    } else if (terminal.outcome === "cancelled") {
      headline = "cancelled — not an error";
      facts.push(`reason: ${terminal.reason ?? "(none given)"}`);
      facts.push("Exactly one cancelled terminal, carrying whatever had already been delivered.");
    } else {
      headline = `terminal error — ${terminal.errorClass ?? "(no class)"}`;
      if (terminal.message !== undefined) facts.push(terminal.message);
      facts.push(
        "The events loop ended normally; this was not a thrown error. A run that fails after starting reports it here, not as a rejection."
      );
    }

    this.outcome.className = `outcome ${terminal.outcome}`;
    this.outcome.replaceChildren();

    const line = document.createElement("div");
    line.className = "headline";
    line.textContent = headline;
    this.outcome.append(line);

    if (terminal.outcome !== "error") {
      const assert = document.createElement("div");
      assert.className = "assert";
      const field = terminal.outcome === "completed" ? "finalText" : "partialText";
      assert.textContent = `${terminal.textMatches ? "✓" : "✗"} ${field} equals the text on screen`;
      this.outcome.append(assert);
    }

    const list = document.createElement("ul");
    for (const fact of facts) {
      const li = document.createElement("li");
      li.textContent = fact;
      list.append(li);
    }
    this.outcome.append(list);
    this.outcome.hidden = false;
  }

  private renderFault(pane: RunPane): void {
    if (pane.transportFault === null) {
      this.fault.hidden = true;
      return;
    }
    this.fault.textContent = `Bridge transport fault — ${pane.transportFault}. Events were lost or could not be encoded crossing the Capacitor hop. This surface exists only on the bridge; it has no engine counterpart.`;
    this.fault.hidden = false;
  }
}

const views: PaneView[] = [];

function resetPanes(): void {
  views.length = 0;
  controls.panes.replaceChildren();
  clearRefusal();
}

/** Drives one run: owns its pane state, mutates its view in place. */
async function drain(label: string, streamRun: StreamRun, privacyUsed: Privacy): Promise<void> {
  let pane = createPane(label, streamRun.handle.runId, privacyUsed, streamRun.handle.providerId ?? null);
  const view = new PaneView();
  views.push(view);
  controls.panes.append(view.root);
  view.update(pane);

  try {
    for await (const event of streamRun.events) {
      pane = applyEvent(pane, event, Date.now());
      view.update(pane);
    }
  } catch (error) {
    // The iterable threw: a bridge transport fault, not a run outcome.
    const { errorClass, message } = describeError(error);
    pane = { ...pane, transportFault: `${errorClass}: ${message}` };
    view.update(pane);
  }
}

// ---------------------------------------------------------------- actions

function setStreamingUi(streaming: boolean): void {
  controls.cancelButton.hidden = !streaming;
  controls.streamButton.hidden = streaming;
  controls.runButton.disabled = streaming;
  controls.twoButton.disabled = streaming;
}

async function guardRegistration(): Promise<boolean> {
  const options = currentOptions();
  if (!registersNothing(options)) {
    return true;
  }
  setStatus("No provider registered — turn one on above.");
  renderRefusal({
    errorClass: "Unavailable",
    message:
      "No provider is registered, so there is nothing to configure the engine with. On the web at least one of the cloud or on-device providers has to be turned on."
  });
  return false;
}

controls.runButton.addEventListener("click", async () => {
  resetPanes();
  if (!(await guardRegistration())) return;

  setStatus("Running (Mode 1)…");
  controls.runButton.disabled = true;
  try {
    const result = await runOnce(currentOptions(), currentRequest());

    const view = new PaneView();
    views.push(view);
    controls.panes.append(view.root);
    view.update({
      ...createPane("Run (Mode 1)", result.runId, privacy, null),
      text: result.output.text,
      terminal: {
        outcome: "completed",
        textMatches: true,
        ...(result.telemetry.providerUsed !== undefined
          ? { providerUsed: result.telemetry.providerUsed }
          : {}),
        ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
        ...(result.usage !== undefined ? { usage: result.usage as Record<string, unknown> } : {})
      },
      finishedAt: Date.now()
    });
    setStatus(`Run complete — served by ${result.telemetry.providerUsed}.`);
  } catch (error) {
    renderRefusal(error);
    setStatus("Run rejected.");
  } finally {
    controls.runButton.disabled = false;
    void refreshCapabilities();
  }
});

controls.streamButton.addEventListener("click", async () => {
  resetPanes();
  if (!(await guardRegistration())) return;

  setStatus("Starting stream…");
  setStreamingUi(true);
  const privacyUsed = privacy;

  try {
    const streamRun = await startStream(currentOptions(), currentRequest());
    liveRuns.add(streamRun);
    setStatus("Streaming…");
    await drain("Stream (Mode 2)", streamRun, privacyUsed);
    liveRuns.delete(streamRun);
    setStatus("Stream finished.");
  } catch (error) {
    // Validation and route-selection failures reject here rather than arriving as events.
    renderRefusal(error);
    setStatus("Stream refused before it started.");
  } finally {
    liveRuns.clear();
    setStreamingUi(false);
    void refreshCapabilities();
  }
});

controls.cancelButton.addEventListener("click", () => {
  // Idempotent, and a no-op once the terminal has arrived.
  for (const streamRun of liveRuns) {
    streamRun.cancel("cancelled from the demo app");
  }
  setStatus("cancel() called — expecting exactly one cancelled terminal per run.");
});

controls.twoButton.addEventListener("click", async () => {
  resetPanes();
  if (!(await guardRegistration())) return;

  setStatus("Starting two concurrent streams…");
  setStreamingUi(true);
  const privacyUsed = privacy;
  const options = currentOptions();

  try {
    const [first, second] = await Promise.all([
      startStream(options, currentRequest()),
      startStream(options, currentRequest())
    ]);
    liveRuns.add(first);
    liveRuns.add(second);

    const labelA = `A${first.handle.runId === second.handle.runId ? " (SAME runId!)" : ""}`;
    await Promise.all([
      drain(labelA, first, privacyUsed),
      drain("B", second, privacyUsed)
    ]);
    setStatus("Both runs finished, in their own panes.");
  } catch (error) {
    renderRefusal(error);
    setStatus("Concurrent streams refused before they started.");
  } finally {
    liveRuns.clear();
    setStreamingUi(false);
    void refreshCapabilities();
  }
});

controls.refreshButton.addEventListener("click", () => void refreshCapabilities());

controls.diagnosticsButton.addEventListener("click", () => {
  showEventLogs = !showEventLogs;
  controls.diagnosticsButton.setAttribute("aria-pressed", String(showEventLogs));
  controls.diagnosticsButton.textContent = showEventLogs ? "Hide event logs" : "Show event logs";
  for (const view of views) {
    view.setEventLogOpen(showEventLogs);
  }
});

controls.privacyGroup.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-privacy]");
  if (button === null) return;
  privacy = button.dataset["privacy"] as Privacy;
  for (const other of controls.privacyGroup.querySelectorAll<HTMLButtonElement>("[data-privacy]")) {
    other.setAttribute("aria-pressed", String(other === button));
  }
});

// A changed bootstrap or endpoint means a different registry, so the badges are stale.
for (const control of [controls.useCloud, controls.useSystemModel, controls.endpoint, controls.model]) {
  control.addEventListener("change", () => void refreshCapabilities());
}

export function start(): void {
  controls.platform.textContent = platform();
  controls.endpoint.value = DEFAULT_ENDPOINT_URL;
  controls.model.value = DEFAULT_MODEL;
  // Native registers its own on-device provider; the toggle would be a lie there.
  controls.useSystemModelRow.hidden = !isWeb();
  renderCapabilities(null);
  void refreshCapabilities();
}
