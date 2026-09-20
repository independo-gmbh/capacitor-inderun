# `@independo/capacitor-inderun`

<p align="center">
  <a href="https://github.com/independo-gmbh/capacitor-inderun/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/independo-gmbh/capacitor-inderun/actions/workflows/ci.yml/badge.svg?branch=main"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/maintenance/yes/2026" alt="Maintenance Badge: until 2026" />
  <a href="https://www.npmjs.com/package/@independo/capacitor-inderun"><img src="https://img.shields.io/npm/l/@independo/capacitor-inderun" alt="License Badge: MIT" /></a>
<br>
  <a href="https://www.npmjs.com/package/@independo/capacitor-inderun"><img src="https://img.shields.io/npm/dw/@independo/capacitor-inderun" alt="" role="presentation" /></a>
  <a href="https://www.npmjs.com/package/@independo/capacitor-inderun"><img src="https://img.shields.io/npm/v/@independo/capacitor-inderun" alt="" role="presentation" /></a>
</p>

<p align="center">Built and maintained by <a href="https://www.independo.app/">Independo</a>.</p>

**On-device AI with cloud fallback, for Capacitor apps.**

Runs a prompt on the device when the device can — Apple Foundation Models on iOS, ML Kit GenAI
(Gemini Nano) on Android — and falls back to an OpenAI-compatible cloud endpoint when it cannot.
One API across iOS, Android and the web, with streaming and cancellation. MIT.

It is a thin bridge, not a second engine. The package delegates to the released
[IndeRun](https://github.com/independo-gmbh/inderun) platform SDKs instead of re-implementing
routing, provider logic, or normalized error handling:

- web: [`@independo/inderun-web`](https://www.npmjs.com/package/@independo/inderun-web) (npm)
- iOS: `IndeRun` Swift package (`github.com/independo-gmbh/inderun`, SwiftPM)
- Android: `app.independo.inderun:inderun-*` (Maven Central)

> This repository is the SwiftPM/npm-publishable home of the Capacitor bridge only.
> The native SDKs it wraps live in the main [`independo-gmbh/inderun`](https://github.com/independo-gmbh/inderun) monorepo.

## Install

```sh
pnpm add @independo/capacitor-inderun @capacitor/core
```

Then sync native projects with your normal Capacitor workflow.

## Platform Requirements

| Platform | Minimum version        |
|----------|------------------------|
| iOS      | 16.0                   |
| Android  | API 26 (Android 8.0)   |
| Web      | Any modern browser     |

The iOS floor comes from the IndeRun Swift package this bridge depends on, not from the bridge
itself. On-device execution needs more than the floor: Apple Foundation Models requires an Apple
Intelligence–capable device on iOS 26+, and ML Kit GenAI requires AICore / Gemini Nano support.
Availability is checked at runtime and the cloud provider serves the request when it is missing.

## Usage

```ts
import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({
  openAI: {
    model: "gpt-5.2",
    endpointUrl: "/api/inderun/openai-responses",
    auth: "none"
  }
});

const result = await inderun.run({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Summarize why a thin bridge matters.",
  constraints: { privacy: "cloud_required" }
});
```

## Streaming (Mode 2)

`stream()` returns the same `StreamRun` shape the platform SDKs return directly: the
run's handle, its canonical event sequence, and a cancel hook.

```ts
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
      text += event.payload.text;       // append
      break;
    case "content_snapshot":
      text = event.payload.text ?? "";  // replace — an empty one retracts
      break;
    case "terminal":
      // exactly one of "completed" | "error" | "cancelled"
      console.log(event.payload.outcome);
      break;
  }
}

run.cancel("user navigated away"); // idempotent; a no-op after the terminal
```

Event semantics, ordering, the terminal guarantees, cancellation and fallback are the engines'
contract, identical on every platform, and documented once in
[Streaming (Mode 2)](https://github.com/independo-gmbh/inderun/blob/dev/docs/streaming.md). Two
things are specific to reaching them through a bridge:

- **The bridge hop is not order-preserving.** That is why `sequence` rather than arrival is the
  contract's ordering authority. `events` already yields strictly by it; if you attach your own
  listener to `STREAM_EVENT_NAME` instead, ordering is yours to enforce.
- **A failed run is not a rejected promise**, and a bridge transport fault is a third thing again.
  See [Error Handling](#error-handling).

## API

- `createIndeRunCapacitor(options)` — returns a handle that lazily `configure()`s on the first `run()` or `stream()` and memoizes it. Safe to call once at app startup.
- `run(request)` — Mode 1. Resolves with the canonical IndeRun `TaskResult`.
- `stream(request)` — Mode 2. Resolves with a `StreamRun` (`handle`, `events`, `cancel`). `events` is single-use.
- The low-level plugin methods `configure(options)`, `startStream(options)` and `cancelStream(options)` are also exported, along with the listener event names `STREAM_EVENT_NAME` (`"indeRunStreamEvent"`) and `STREAM_ERROR_NAME` (`"indeRunStreamError"`).

> The two listener event names are **public contract**. Native emits exactly these, and an
> app may attach its own listener to them; renaming one is a breaking change.

The `IndeRunCapacitorPlugin`, `ConfigureOptions`, and `OpenAIProviderBootstrapOptions`
contracts — including the `openAI` bootstrap config and the web-only
`allowDirectOpenAIEndpoint` flag — are defined and documented in
`src/definitions.ts`.

Note one asymmetry in the low-level surface: `run(request)` passes the request at the
options root, while `startStream({ streamId, request })` nests it, because that envelope
also carries the bridge-local correlation id. `stream()` hides this.

## Platform Notes

- Web requires `openAI` registration because the current web SDK only has the OpenAI-compatible provider.
- iOS always registers the Apple on-device provider and optionally registers OpenAI when configured.
- Android always registers the ML Kit on-device provider and optionally registers OpenAI when configured.
- Keep credentials behind `authContextRef`. That keeps a secret out of the request payload and out
  of source; it does not make a key safe to ship, since anything an installed app or a browser can
  read, someone with that app or browser can read. For a key you own, put it behind a backend you
  control and point `endpointUrl` at that — for browser apps, a same-origin proxy with
  `auth: "none"`.

## Current Limitations

- Mode 1 `run()` and Mode 2 `stream()` are supported. Mode 3 sessions are not.
- **No backpressure across the bridge.** Native pushes events; a slow consumer buys memory,
  not throttling, because events buffer in JS until they are read. Runs are finite and
  terminal-bounded, and any drop or throttle policy would be behaviour — which belongs in
  the engines, not in a bridge.
- Which providers can actually stream is decided upstream, not here; see the
  [provider matrix](https://github.com/independo-gmbh/inderun/blob/main/docs/architecture/providers.md#provider-matrix).
- An unrecognized `StreamEvent.type` is passed through untouched rather than rejected, so a
  consumer built against an older contract revision keeps working when a newer one adds an
  event type. Ignore what you do not recognize.
- No plugin-level credential management API is exposed in this first cut.
- The bridge is intentionally thin; cloud provider bootstrap still has to come from the app.

## Error Handling

A streaming run has **three** distinct failure surfaces, and conflating them is the easiest
mistake to make:

| Surface | When | How it reaches you |
| --- | --- | --- |
| Rejection | Request validation, or no streaming-capable provider | `stream()` rejects with an `IndeRunError` |
| Terminal `error` event | A provider failed, or the whole planned chain did | **Not** a rejection — `for await` completes normally and the last event is `terminal` with `payload.outcome === "error"` |
| Bridge fault | The transport lost or could not encode events | `events` throws an `Internal` `IndeRunError` |

So a run that fails *after starting* ends your loop normally. Branch on
`event.payload.outcome` to tell completion from failure from cancellation.

Errors thrown by `configure()` and `run()` conform to `IndeRunError` from
`@independo/inderun-contracts`; branch on `error.errorClass` (the shared error
taxonomy). The bridge unwraps the native error envelope before re-throwing, so
callers receive the same `IndeRunError` shape on every platform.

```ts
try {
  await inderun.run(request);
} catch (error) {
  if (error && typeof error === "object" && "errorClass" in error) {
    // error.errorClass is one of the IndeRun error taxonomy values
  }
}
```

## License

MIT. See [`LICENSE`](./LICENSE).

## Sponsorship & Development

This project is sponsored by [netidee](https://www.netidee.at/inderun) and developed
by [Independo GmbH](https://www.independo.app).

Explore more [open-source tools and research from Independo](https://www.independo.app/open-source).
