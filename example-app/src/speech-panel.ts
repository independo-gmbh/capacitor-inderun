/**
 * The speech panel: system voices and the downloaded neural voice. These runs are the device
 * verification record for speech, so every outcome, including a refusal, is printed rather than
 * swallowed. All calls go through bridge.ts so the text panels and this one share one engine
 * configuration instead of reloading the neural model on every click.
 */
import { Capacitor } from "@capacitor/core";
import type { SpeechPlayback, SpeechVoiceInfo } from "@independo/capacitor-inderun";
import {
  disposeArtifact,
  generateSpeech,
  listVoices,
  platform,
  prepare,
  readAllBytes,
  setSpeechConfig,
  speak
} from "./bridge.js";
import {
  catalogEntryToModelPackage,
  downloadPackage,
  ENTRY,
  PROFILE_NAME,
  totalBytes
} from "./neural-package.js";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  text: el<HTMLTextAreaElement>("speech-text"),
  locale: el<HTMLSelectElement>("speech-locale"),
  sysList: el<HTMLButtonElement>("sys-list"),
  sysSpeak: el<HTMLButtonElement>("sys-speak"),
  sysGenerate: el<HTMLButtonElement>("sys-generate"),
  sysStatus: el<HTMLParagraphElement>("sys-status"),
  download: el<HTMLButtonElement>("neural-download"),
  prepare: el<HTMLButtonElement>("neural-prepare"),
  progress: el<HTMLProgressElement>("neural-progress"),
  voice: el<HTMLSelectElement>("neural-voice"),
  neuralSpeak: el<HTMLButtonElement>("neural-speak"),
  neuralGenerate: el<HTMLButtonElement>("neural-generate"),
  neuralStatus: el<HTMLParagraphElement>("neural-status"),
  stop: el<HTMLButtonElement>("speech-stop"),
  result: el<HTMLDivElement>("speech-result")
};

let playback: SpeechPlayback | null = null;
let neuralConfigured = false;
let neuralVoices: SpeechVoiceInfo[] = [];

/** Neural speech provider id: `local.onnx.speech.<apple|android|web>:<package id>`. */
function neuralProviderId(): string {
  const side = platform() === "ios" ? "apple" : platform() === "android" ? "android" : "web";
  return `local.onnx.speech.${side}:${ENTRY.id}`;
}

function systemProviderId(): string {
  const side = platform() === "ios" ? "apple" : platform() === "android" ? "android" : "web";
  return `${side}_system_speech`;
}

function configureSystemOnly(): void {
  setSpeechConfig({ systemSpeech: true });
}

function configureWithNeural(): void {
  setSpeechConfig({
    systemSpeech: true,
    neuralSpeech: [{ modelPackage: catalogEntryToModelPackage() }],
    // The profile lists the neural voice first, then the system voice as the fallback.
    modelProfiles: { [PROFILE_NAME]: [neuralProviderId(), systemProviderId()] }
  });
  neuralConfigured = true;
}

// ---------------------------------------------------------------- output helpers

function describeError(error: unknown): { errorClass: string; message: string } {
  if (error && typeof error === "object" && "errorClass" in error) {
    const contract = error as { errorClass: string; message?: string };
    return { errorClass: contract.errorClass, message: contract.message ?? "(no message)" };
  }
  return { errorClass: "(not a contract error)", message: String(error) };
}

function show(kind: "ok" | "refused" | "failed", headline: string, lines: string[] = []): void {
  ui.result.hidden = false;
  ui.result.className = `panel ${kind}`;
  ui.result.replaceChildren();
  const head = document.createElement("div");
  head.className = "headline";
  head.textContent = headline;
  ui.result.append(head, document.createTextNode(lines.join("\n")));
}

function showError(what: string, error: unknown): void {
  const { errorClass, message } = describeError(error);
  show("refused", `${what} refused: ${errorClass}`, [message]);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Sample rate from a RIFF/WAVE header, or null when the bytes are not one. */
function wavSampleRate(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 28) return null;
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(24, true);
}

function setBusy(busy: boolean): void {
  for (const button of [
    ui.sysList,
    ui.sysSpeak,
    ui.sysGenerate,
    ui.download,
    ui.prepare,
    ui.neuralSpeak,
    ui.neuralGenerate
  ]) {
    button.disabled = busy;
  }
}

// ---------------------------------------------------------------- shared actions

function speechBase(): { text: string; locale: string } {
  return { text: ui.text.value, locale: ui.locale.value };
}

async function doSpeak(label: string, extra: Record<string, unknown>): Promise<void> {
  setBusy(true);
  show("ok", `${label}: starting…`);
  try {
    playback = await speak({
      ...speechBase(),
      ...extra,
      execution: { privacy: "local_required" }
    });
    ui.stop.disabled = false;
    show("ok", `${label}: speaking…`, [`runId ${playback.runId}`]);
    const spoken = await playback.result;
    show("ok", `${label}: ${spoken.outcome}`, [
      `finishReason: ${spoken.finishReason ?? "(none)"}`,
      `provider: ${spoken.provenance?.providerId ?? "(unknown)"} (${spoken.provenance?.locality ?? "?"})`,
      `voice: ${JSON.stringify(spoken.speech ?? null)}`,
      `timing: ${JSON.stringify(spoken.timing ?? null)}`
    ]);
  } catch (error) {
    showError(label, error);
  } finally {
    playback = null;
    ui.stop.disabled = true;
    setBusy(false);
  }
}

async function doGenerate(label: string, extra: Record<string, unknown>): Promise<void> {
  setBusy(true);
  show("ok", `${label}: generating…`);
  try {
    const generated = await generateSpeech({
      ...speechBase(),
      ...extra,
      mediaTypes: ["audio/wav"],
      execution: { privacy: "local_required" }
    });
    try {
      const bytes = await readAllBytes(generated.artifact);
      const rate = wavSampleRate(bytes);
      show("ok", `${label}: ${generated.finishReason}`, [
        `bytes read: ${bytes.byteLength} (artifact says ${generated.artifact.sizeBytes ?? "?"})`,
        `WAV sample rate: ${rate ?? "not a WAV"} Hz`,
        `media type: ${generated.artifact.mediaType}`,
        `provider: ${generated.provenance?.providerId ?? "(unknown)"} (${generated.provenance?.locality ?? "?"})`,
        `voice: ${JSON.stringify(generated.speech ?? null)}`,
        "artifact disposed after reading."
      ]);
    } finally {
      await disposeArtifact(generated.artifact);
    }
  } catch (error) {
    showError(label, error);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- system voices

ui.sysList.addEventListener("click", async () => {
  configureSystemOnlyUnlessNeural();
  setBusy(true);
  try {
    const voices = await listVoices({ locale: ui.locale.value, localeMatch: "language" });
    const system = voices.filter((voice) => voice.kind === "platform");
    const network = system.filter((voice) => voice.networkRequired === true).length;
    ui.sysStatus.textContent = `${system.length} system voice(s) for ${ui.locale.value}; ${network} need the network.`;
    show("ok", "System voices", system.slice(0, 20).map((v) => `${v.name ?? v.id ?? "?"} · ${v.locale}${v.networkRequired ? " · network" : ""}`));
  } catch (error) {
    showError("listVoices", error);
  } finally {
    setBusy(false);
  }
});

function configureSystemOnlyUnlessNeural(): void {
  if (!neuralConfigured) configureSystemOnly();
}

ui.sysSpeak.addEventListener("click", () => {
  configureSystemOnlyUnlessNeural();
  void doSpeak("System speak", {});
});

ui.sysGenerate.addEventListener("click", () => {
  configureSystemOnlyUnlessNeural();
  void doGenerate("System generateSpeech", {});
});

// ---------------------------------------------------------------- neural voice

async function refreshNeuralVoices(): Promise<void> {
  const voices = await listVoices({ locale: ui.locale.value, localeMatch: "language" });
  neuralVoices = voices.filter((voice) => voice.providerId === neuralProviderId());
  ui.voice.replaceChildren();
  for (const [index, voice] of neuralVoices.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${voice.name ?? voice.id ?? "?"} (${voice.locale})`;
    ui.voice.append(option);
  }
  ui.voice.disabled = neuralVoices.length === 0;
}

function neuralExtra(): Record<string, unknown> {
  const voice = neuralVoices[Number(ui.voice.value)];
  return { model: PROFILE_NAME, ...(voice ? { voice } : {}) };
}

ui.download.addEventListener("click", async () => {
  if (!Capacitor.isNativePlatform()) {
    ui.neuralStatus.textContent =
      "Download needs a device: it writes to the app's private storage with @capacitor/filesystem.";
    return;
  }
  setBusy(true);
  ui.progress.hidden = false;
  ui.progress.value = 0;
  ui.neuralStatus.textContent = "Downloading…";
  try {
    await downloadPackage((p) => {
      ui.progress.value = p.doneBytes / p.totalBytes;
      ui.neuralStatus.textContent = `${p.skipped ? "Already there" : "Downloading"}: ${p.file} (${p.fileIndex + 1}/${p.fileCount}), ${megabytes(p.doneBytes)} of ${megabytes(p.totalBytes)}`;
    });
    ui.neuralStatus.textContent = `Downloaded ${megabytes(totalBytes())}. Press Prepare to load and verify it.`;
  } catch (error) {
    ui.neuralStatus.textContent = "Download failed.";
    show("failed", "Download failed", [String(error instanceof Error ? error.message : error)]);
  } finally {
    setBusy(false);
  }
});

ui.prepare.addEventListener("click", async () => {
  configureWithNeural();
  setBusy(true);
  ui.progress.hidden = false;
  ui.progress.value = 0;
  ui.neuralStatus.textContent = "Preparing…";
  try {
    const run = await prepare({ tasks: ["text_to_speech"] });
    let outcome = "(no terminal)";
    const lines: string[] = [];
    for await (const event of run.events) {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (event.type === "preparation_progress") {
        const fraction = payload?.["fractionCompleted"];
        if (typeof fraction === "number") ui.progress.value = fraction;
        ui.neuralStatus.textContent = `Preparing ${String(payload?.["providerId"] ?? "")}…`;
      } else if (event.type === "terminal") {
        outcome = String(payload?.["outcome"] ?? "?");
        const items = (payload?.["output"] as { preparation?: Array<Record<string, unknown>> } | undefined)?.preparation ?? [];
        for (const item of items) {
          lines.push(`${String(item["providerId"])} ${String(item["task"])}: ${String(item["status"])}${item["reason"] ? ` — ${String(item["reason"])}` : ""}`);
        }
        const error = payload?.["error"] as { errorClass?: string; message?: string } | undefined;
        if (error) lines.push(`${error.errorClass ?? "Error"}: ${error.message ?? ""}`);
      }
    }
    const failed = outcome !== "completed" || lines.some((line) => line.includes(": failed"));
    // A checksum mismatch is reported here, by the provider, as a failed item with its reason.
    show(failed ? "failed" : "ok", `Prepare: ${outcome}${failed ? " (see below; a checksum mismatch is reported here)" : ""}`, lines);
    ui.neuralStatus.textContent = failed ? "Prepare failed." : "Ready.";
    if (!failed) await refreshNeuralVoices();
  } catch (error) {
    showError("prepare", error);
    ui.neuralStatus.textContent = "Prepare refused.";
  } finally {
    ui.progress.hidden = true;
    setBusy(false);
  }
});

ui.neuralSpeak.addEventListener("click", () => {
  configureWithNeural();
  void doSpeak("Neural speak", neuralExtra());
});

ui.neuralGenerate.addEventListener("click", () => {
  configureWithNeural();
  void doGenerate("Neural generateSpeech", neuralExtra());
});

ui.stop.addEventListener("click", () => playback?.cancel("stopped from the demo app"));

ui.locale.addEventListener("change", () => {
  if (neuralConfigured) void refreshNeuralVoices().catch(() => undefined);
});

export function startSpeechPanel(): void {
  ui.neuralStatus.textContent = Capacitor.isNativePlatform()
    ? `Not downloaded yet (${megabytes(totalBytes())}).`
    : "Neural download is native only. On the web the files must be served by URL.";
}
