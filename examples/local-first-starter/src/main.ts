import "./styles.css";
import { createIndeRunCapacitor, type SpeechPlayback } from "@independo/capacitor-inderun";

// One handle for the whole app. It configures itself on the first call. `systemSpeech` is
// opt-in; there is no `openAI` here, so no cloud route exists at all.
const inderun = createIndeRunCapacitor({ systemSpeech: true });

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "errorClass" in error) {
    const { errorClass, message } = error as { errorClass: string; message?: string };
    return `${errorClass}: ${message ?? "(no message)"}`;
  }
  return String(error);
}

// ---------------------------------------------------------------- providers

async function refreshProviders(): Promise<void> {
  const list = el<HTMLUListElement>("providers");
  list.replaceChildren();
  try {
    const snapshots = await inderun.checkCapabilities();
    for (const { descriptor, capabilities } of snapshots) {
      const item = document.createElement("li");
      const state = capabilities.available
        ? "available"
        : `unavailable${capabilities.reason ? ` (${capabilities.reason})` : ""}`;
      // Readiness is per task: "ready", "cold", "not_prepared" or "preparing".
      const readiness = (capabilities.taskCapabilities ?? [])
        .filter((task) => task.readiness)
        .map((task) => `${task.kind}: ${task.readiness}`)
        .join(", ");
      item.textContent = `${descriptor.id} · ${descriptor.type} · ${state}${readiness ? ` · ${readiness}` : ""}`;
      list.append(item);
    }
  } catch (error) {
    const item = document.createElement("li");
    item.textContent = `Could not check providers. ${describeError(error)}`;
    list.append(item);
  }
}

// ---------------------------------------------------------------- run

async function ask(): Promise<void> {
  const answer = el<HTMLDivElement>("answer");
  const button = el<HTMLButtonElement>("run");
  button.disabled = true;
  answer.hidden = false;
  answer.textContent = "Running…";
  try {
    const result = await inderun.run({
      schemaVersion: "1.0",
      task: { kind: "text_to_text" },
      prompt: el<HTMLTextAreaElement>("prompt").value,
      constraints: { privacy: "local_required" }
    });
    const where = result.provenance
      ? `${result.provenance.providerId} (${result.provenance.locality})`
      : "unknown";
    answer.textContent = `${result.output.text ?? ""}\n\nServed by ${where}`;
  } catch (error) {
    answer.textContent = `Refused. ${describeError(error)}\n\nThis device cannot serve the request locally, so IndeRun did not send it anywhere else.`;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- speak

let playback: SpeechPlayback | null = null;

async function speak(): Promise<void> {
  const status = el<HTMLParagraphElement>("speech-status");
  const speakButton = el<HTMLButtonElement>("speak");
  const stopButton = el<HTMLButtonElement>("stop");
  speakButton.disabled = true;
  status.textContent = "Starting…";
  try {
    playback = await inderun.speak({
      text: el<HTMLTextAreaElement>("speech-text").value,
      locale: el<HTMLSelectElement>("locale").value,
      execution: { privacy: "local_required" }
    });
    stopButton.disabled = false;
    status.textContent = "Speaking…";
    const spoken = await playback.result;
    status.textContent = `Finished: ${spoken.finishReason ?? spoken.outcome}`;
  } catch (error) {
    status.textContent = `Refused. ${describeError(error)}`;
  } finally {
    playback = null;
    speakButton.disabled = false;
    stopButton.disabled = true;
  }
}

el("refresh").addEventListener("click", () => void refreshProviders());
el("run").addEventListener("click", () => void ask());
el("speak").addEventListener("click", () => void speak());
el("stop").addEventListener("click", () => void playback?.cancel());

void refreshProviders();
