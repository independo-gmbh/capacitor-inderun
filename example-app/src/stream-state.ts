/**
 * The run model and its event reducer. Pure and DOM-free on purpose: this is the one piece
 * of the demo that encodes the Mode 2 contract rather than the UI, so it is worth being able
 * to read on its own.
 */
import type { StreamEvent } from "@independo/capacitor-inderun";

export type Privacy = "local_required" | "local_preferred" | "cloud_allowed" | "cloud_required";

/** Which content event type this run actually produced, as observed — not as declared. */
export type ObservedStyle = "deltas" | "snapshots" | "mixed" | null;

export interface LoggedEvent {
  sequence: number;
  type: string;
  /** Milliseconds since the previous event of this run; `null` for the first. */
  deltaMs: number | null;
}

export interface TerminalSummary {
  outcome: "completed" | "cancelled" | "error" | string;
  providerUsed?: string;
  finishReason?: string;
  usage?: Record<string, unknown>;
  reason?: string;
  errorClass?: string;
  message?: string;
  /**
   * Whether the terminal's cumulative text equals what the content events built up. The one
   * self-verifying invariant in this app, so it is shown rather than logged.
   */
  textMatches: boolean;
}

export interface RunPane {
  label: string;
  runId: string;
  privacy: Privacy;
  /** `handle.providerId` — the provider routing *planned*, known before the first event. */
  plannedProviderId: string | null;
  text: string;
  events: LoggedEvent[];
  observedStyle: ObservedStyle;
  /** True when the most recent content event was an empty snapshot, i.e. a retraction. */
  retracted: boolean;
  /** Set on every `content_snapshot`, so the UI can flash the replace. */
  snapshotTick: number;
  terminal: TerminalSummary | null;
  /** A bridge transport fault: the `events` iterable threw. Not a run outcome. */
  transportFault: string | null;
  lastEventAt: number | null;
  finishedAt: number | null;
}

export function createPane(
  label: string,
  runId: string,
  privacy: Privacy,
  plannedProviderId: string | null
): RunPane {
  return {
    label,
    runId,
    privacy,
    plannedProviderId,
    text: "",
    events: [],
    observedStyle: null,
    retracted: false,
    snapshotTick: 0,
    terminal: null,
    transportFault: null,
    lastEventAt: null,
    finishedAt: null
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function nextStyle(current: ObservedStyle, seen: "deltas" | "snapshots"): ObservedStyle {
  if (current === null) return seen;
  return current === seen ? current : "mixed";
}

/**
 * Folds one event into the run's state.
 *
 * Three rules from the contract, all of which a consumer gets wrong by default:
 *
 * - `content_delta` **appends**; `content_snapshot` **replaces**. A provider's declared
 *   streaming style does not tell you which you will get, so both branches are mandatory —
 *   Apple Foundation Models emits nothing but snapshots.
 * - An **empty** snapshot is a retraction, not a no-op. Android ML Kit uses one to clear a
 *   half-generated answer that failed a safety policy, and then fails `CapabilityMismatch`.
 *   A delta-only consumer leaves the rejected text on screen.
 * - An unrecognized `type` is ignored, never treated as an error. `lifecycle` and
 *   `diagnostic` are contract seams no shipped engine emits yet, and they arrive here as
 *   exactly that: unrecognized.
 */
export function applyEvent(pane: RunPane, event: StreamEvent, now: number): RunPane {
  const payload = asRecord(event.payload);
  const next: RunPane = {
    ...pane,
    events: [
      ...pane.events,
      {
        sequence: event.sequence,
        type: event.type,
        deltaMs: pane.lastEventAt === null ? null : now - pane.lastEventAt
      }
    ],
    lastEventAt: now
  };

  if (event.type === "content_delta") {
    next.text = pane.text + String(payload["text"] ?? "");
    next.observedStyle = nextStyle(pane.observedStyle, "deltas");
    next.retracted = false;
    return next;
  }

  if (event.type === "content_snapshot") {
    const text = String(payload["text"] ?? "");
    next.text = text;
    next.observedStyle = nextStyle(pane.observedStyle, "snapshots");
    next.retracted = text.length === 0 && pane.text.length > 0;
    next.snapshotTick = pane.snapshotTick + 1;
    return next;
  }

  if (event.type === "terminal") {
    next.terminal = summarizeTerminal(payload, next.text);
    next.finishedAt = now;
    return next;
  }

  return next;
}

function summarizeTerminal(payload: Record<string, unknown>, text: string): TerminalSummary {
  const outcome = String(payload["outcome"]);

  if (outcome === "completed") {
    const telemetry = asRecord(payload["telemetry"]);
    const summary: TerminalSummary = {
      outcome,
      textMatches: payload["finalText"] === text
    };
    if (typeof telemetry["providerUsed"] === "string") {
      summary.providerUsed = telemetry["providerUsed"];
    }
    if (typeof payload["finishReason"] === "string") {
      summary.finishReason = payload["finishReason"];
    }
    if (payload["usage"] !== undefined) {
      summary.usage = asRecord(payload["usage"]);
    }
    return summary;
  }

  if (outcome === "cancelled") {
    const summary: TerminalSummary = {
      outcome,
      textMatches: (payload["partialText"] ?? "") === text
    };
    if (typeof payload["reason"] === "string") {
      summary.reason = payload["reason"];
    }
    return summary;
  }

  const error = asRecord(payload["error"]);
  const summary: TerminalSummary = { outcome, textMatches: true };
  if (typeof error["errorClass"] === "string") {
    summary.errorClass = error["errorClass"];
  }
  if (typeof error["message"] === "string") {
    summary.message = error["message"];
  }
  return summary;
}
