# IndeRun bridge demo app

An unpublished Capacitor app that demonstrates what the bridge actually does — streaming,
provider routing, and the three failure surfaces — and doubles as the device smoke test. It
is the only way to exercise the parts the unit suites cannot: Capacitor's real listener
transport, plugin teardown, and the native engines end to end.

Not part of the published package (`files` in the root `package.json` is an allowlist), not
part of SwiftPM (every target declares an explicit path under `ios/`), and not part of CI
(all three jobs are root-scoped).

## What it shows

- **Providers on this device** — `checkCapabilities()` per provider: local or cloud, whether
  it can run and stream *right now*, the streaming style it declares, its cancellation
  semantics, and the reason when something is unavailable.
- **Routing** — a four-way `constraints.privacy` selector (Local Only / Prefer Local / Cloud
  Allowed / Cloud Only) plus toggles for which providers get registered at all. There is no
  provider picker, because IndeRun does not have one: you constrain, the engine routes.
- **Runs** — one pane per run, with the live transcript, the provider routing *planned*
  (`handle.providerId`) next to the one that actually *served* it
  (`telemetry.providerUsed`), the content style **observed** versus declared, and a
  per-run event log with `sequence` and the gap between events in milliseconds.
- **The three failure surfaces**, rendered as three visibly different things — see below.

## Setup

The generated native projects are gitignored, so the first run needs `cap add`:

```sh
# from the repository root
pnpm install && pnpm build

cd example-app
pnpm install --ignore-workspace
pnpm exec cap add ios        # first time only
pnpm exec cap add android    # first time only
```

`--ignore-workspace` is required. The repository root is a single pnpm package with no
`packages:` key, so a plain `pnpm install` here finds the parent lockfile and silently does
nothing — no `node_modules`, no error. The flag makes pnpm treat this directory as its own
project; it writes a `pnpm-lock.yaml` and a `pnpm-workspace.yaml` here, both gitignored.

**After changing anything in the root `src/`**, rebuild and reinstall, or the app keeps the
old copy: `"@independo/capacitor-inderun": "file:.."` resolves through the package's `files`
allowlist, so a stale `dist/` shows up as a baffling *"checkCapabilities is not a function"*.

```sh
# from the repository root
pnpm build && (cd example-app && pnpm install --ignore-workspace)
```

## Run

```sh
pnpm run build && pnpm exec cap sync
pnpm exec cap run ios --target <device>
pnpm exec cap run android --target <device>
```

`pnpm dev` runs it in a browser, which is the fastest way to see routing refusals — but only
a device can show on-device streaming (see the platform matrix below).

## Configuration

Everything has a field in the UI; the env vars only pre-fill them, which matters on a phone
where retyping a proxy URL each launch is its own disincentive to test. Put them in
`.env.local` (gitignored).

| Env var | Effect |
| --- | --- |
| `VITE_INDERUN_DEMO_PROXY_URL` | Pre-fills the proxy endpoint |
| `VITE_INDERUN_OPENAI_MODEL` | Pre-fills the model id (default `gpt-5.2`) |
| `VITE_INDERUN_ONNX_MODEL_ID` | Registers the Web ONNX provider with this Hugging Face repo id. Unset by default |

### The proxy

The app sends `auth: "none"` and **never contains a credential**. Point it at an
OpenAI-compatible proxy of your own that holds the key server-side; the upstream
`@independo/inderun-demo-proxy` is not published to npm.

The minimum that proxy has to do:

- `POST` accepting and returning the OpenAI **Responses** shape, and
- for Mode 2, `"stream": true` answered as `text/event-stream` with
  `response.output_text.delta` events and a final `response.completed`.

Without that last part Mode 1 works and Mode 2 mysteriously does not. The provider also
issues a cheap unauthenticated `GET` against the endpoint as a reachability probe, so answer
that too or the capability panel will show the provider unavailable before you press
anything. (That probe result is cached for a few seconds, and changing the endpoint in the UI
reconfigures the engine, so the badge refreshes rather than going stale.)

**Reaching a host-machine proxy from a device** — the single biggest time-waster:

| Target | Host URL |
| --- | --- |
| Android emulator | `http://10.0.2.2:<port>` |
| iOS simulator | `http://localhost:<port>` |
| A physical device | your machine's LAN IP |

### ONNX

`VITE_INDERUN_ONNX_MODEL_ID` is deliberately an env var rather than a checkbox: the provider
needs the optional `@huggingface/transformers` peer dependency installed and downloads real
weights on first use. It is Mode 1 only. The web SDK's runtime-injection seam is a function,
so it cannot cross the plugin's JSON options boundary — meaning the fixture runtime the
upstream demos use offline is not reachable from Capacitor, only the real one.

## What streams where

| Provider family | Web | iOS | Android | Style |
| --- | --- | --- | --- | --- |
| OpenAI-compatible | yes | yes | yes | token deltas |
| Apple Foundation Models | — | yes | — | **snapshots only** |
| Android ML Kit GenAI | — | — | yes | deltas, and can retract |
| Web ONNX Runtime | Mode 1 | Mode 1 | Mode 1 | — |
| Web system-model (Chrome Prompt API) | Mode 1 | — | — | — |

Upstream's [provider matrix](https://github.com/independo-gmbh/inderun/blob/main/docs/architecture/providers.md#provider-matrix)
is the authority; this copy is convenience and can lag it.

The consequence worth internalizing: **no web provider streams on-device**, so `Local Only` +
**Stream** in a browser is refused at routing time. That is correct behavior, not a bug, and
it is the easiest way to see the refusal panel with real data.

## The three failure surfaces

Conflating these is the easiest mistake to make, so the demo renders them as three different
things:

| Surface | When | In the UI |
| --- | --- | --- |
| **Rejection** | Validation failed, or no registered provider can serve the request | The red **Routing refused** panel — no run id, no pane, because nothing started. Shows `failureCode` and the `rejectedProviders` table |
| **Terminal `error`** | A provider failed *after* the run started | Inside the run's pane, as the error chip. The events loop ended normally; this was never a thrown error |
| **Transport fault** | Bridge-only: events were lost or could not be encoded crossing the Capacitor hop | A dashed banner on the pane, styled unlike the terminal chip. It has no engine counterpart |

## Manual verification matrix

| Check | Web (`pnpm dev`) | iOS device | Android device |
| --- | --- | --- | --- |
| Cloud stream renders incrementally; `sequence` gapless, Δms shows real spacing | yes | yes | yes |
| `completed` shows `✓ finalText equals the text on screen` | yes | yes | yes |
| Cancel mid-stream → one `cancelled` terminal, matching `partialText`, nothing after | yes | yes | yes |
| Cancel before the first delta → `cancelled` with empty `partialText` | yes | yes | yes |
| Cancel after the terminal → no-op, nothing thrown | yes | yes | yes |
| Two concurrent streams → distinct run ids, two independent panes | yes | yes | yes |
| Empty prompt → refusal panel with `validationIssues` | yes | yes | yes |
| Unregister the cloud provider, pick `Cloud Only` → refusal naming zero candidates | yes | yes | yes |
| `Local Only` + **Stream** → refusal with `rejectedProviders` reason codes | **yes — canonical** | no (it should succeed) | no (it should succeed) |
| Bad proxy URL → provider shows unavailable with a reason before you run anything | yes | yes | yes |
| Proxy that answers the probe but fails the call → **terminal error**, not a refusal | yes | yes | yes |
| On-device **stream** | **no, by design** | yes (Apple Intelligence device) | yes (AICore / Gemini Nano) |
| `content_snapshot` replaces, transcript flashes, chip reads `observed snapshots` | no | **yes — iOS only** | no |
| Empty-snapshot **retraction** clears the pane, then `CapabilityMismatch` | no | no | **yes — Android only**, via a safety-policy-refused prompt |
| Planned ≠ served (`fell back` chip) with `Prefer Local` and the local provider unavailable | yes | yes | yes |
| Background mid-stream and return: no crash | n/a | yes | yes |
| Force-quit mid-stream, relaunch, stream again (iOS `deinit`, Android `handleOnDestroy`) | n/a | yes | yes |

## Expected failure modes by `errorClass`

- `CapabilityMismatch` — no eligible provider. On **Stream** this is usually a routing
  refusal rather than a terminal, so it rejects the call. On Android it is also what a ML Kit
  safety-policy rejection reports, after retracting the partial text.
- `Offline` — the device has no network and only a cloud provider is eligible.
- `Unavailable` — the proxy could not be reached, or failed before returning a response.
- `AuthError` — the upstream rejected authentication. With `auth: "none"` this means the
  proxy itself is refusing.
- `RateLimited` — the upstream throttled the request (a 429 reaches you as this, not as a
  malformed event stream).
- `Timeout` — the provider exceeded its budget. Note `constraints.timeoutMs` bounds the wait
  for the **response head**, not the whole stream — deliberately, so a stream that legitimately
  runs for minutes is not killed by a time-to-first-byte budget. A tiny value will not abort a
  proxy that answers immediately.
- `Internal` — an unexpected engine or payload-mapping failure. Across the bridge it is also
  what a transport fault reports.

## Known gaps

- **Route diagnostics are only visible on a refusal.** `rejectedProviders` rides on the
  error; on a *successful* run the same information lives in a `route_decided` telemetry
  event, and the Capacitor bridge has no telemetry seam. The upstream web and Android demos
  can show it; this one cannot.
- The Web ONNX provider's fixture runtime is unreachable through the plugin's JSON options,
  so there is no offline local path in a browser.
- The demo reconfigures per action via a bootstrap fingerprint so the provider toggles work.
  An app whose providers never change should use `createIndeRunCapacitor(options)` instead and
  let it configure once at startup.
