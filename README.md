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

## Host Project Requirements

The IndeRun SDKs this bridge wraps are newer than a freshly generated Capacitor app's
defaults, so `cap add` alone is not enough. Each of these is a hard requirement — the
corresponding build failure is named so it is searchable:

**Android** (`android/variables.gradle` and `android/build.gradle` in your app):

| Setting | Value | Failure if unset |
|---|---|---|
| `compileSdkVersion` | `37` | *"requires libraries and applications that depend on it to compile against version 37 or later"* |
| `minSdkVersion` | `26` | manifest merger conflict |
| Android Gradle Plugin | `9.1.0`+ (Gradle 9.x) | *"requires Android Gradle plugin 9.1.0 or higher"* |
| `org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.10` on the app's `buildscript` classpath | — | *"Module was compiled with an incompatible version of Kotlin … metadata is 2.4.0, expected version is 2.2.0"* |

The Kotlin one is the surprising entry: the `inderun-*` artifacts carry Kotlin 2.4.x
metadata, which the Kotlin plugin AGP brings by default cannot read. The plugin's own build
hoists a newer KGP for its standalone build, but a consuming app resolves KGP from its own
buildscript classpath, so the app has to add it too:

```groovy
// android/build.gradle
buildscript {
    dependencies {
        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.10'
    }
}
```

AGP 9 also rejects `getDefaultProguardFile('proguard-android.txt')`; switch to
`proguard-android-optimize.txt`.

**iOS**: set `IPHONEOS_DEPLOYMENT_TARGET` to `16.0` in your Xcode project **before**
`npx cap sync ios`. The Capacitor CLI reads that value to generate `CapApp-SPM/Package.swift`,
so syncing with the default leaves a manifest pinned below this package's floor and the build
fails with *"requires minimum platform version 16.0 for the iOS platform, but this target
supports 15.0"*.

## Supported IndeRun Version

This release tracks **IndeRun 0.5.0-rc.20** on all three platforms:

| Platform | Artifact | Constraint |
|----------|----------|------------|
| Web      | `@independo/inderun-web`, `@independo/inderun-contracts` | `0.5.0-rc.20` (exact) |
| iOS      | `inderun` SwiftPM package | `0.5.0-rc.20` (exact) |
| Android  | `app.independo.inderun:inderun-*` | `0.5.0-rc.20` (exact) |

All three pins are exact and bumped together — a partial bump is how the platforms drift apart. The
SwiftPM pin is exact only while the bridge tracks an `inderun` prerelease, because SwiftPM's range
operators (`from:`, `.upToNextMinor`) exclude prerelease versions; it returns to a ranged constraint on
the stable release.

This package versions **independently** of the IndeRun monorepo under plain semver — the numbers are
unrelated, and this bridge's own version says nothing about which IndeRun release it wraps. Read that
off the table above.

## Usage

```ts
import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({
  openAI: {
    models: ["gpt-5.2"],
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

`openAI.models` registers one OpenAI-compatible target per model, with id `openai:<model>`
(`openai:gpt-5.2` above) on every platform. That id is the `providerId` results, errors and
telemetry report, so code that compares provider ids must expect it rather than `openai`.

## Model Profiles and Provenance

`modelProfiles` names ordered lists of targets, and a request opts into one with
`modelProfile`. Routing then stays within that list, in that order, after placement
constraints such as `privacy`. Without a `modelProfile` — or with `"auto"`, which cannot be
redefined — every registered target is eligible; naming a profile that was not configured
fails the request.

```ts
const inderun = createIndeRunCapacitor({
  openAI: { models: ["gpt-5.2", "gpt-5-mini"], endpointUrl: "/api/inderun/openai-responses", auth: "none" },
  modelProfiles: {
    smart: ["openai:gpt-5.2"],
    fast: ["openai:gpt-5-mini"]
  }
});

const result = await inderun.run({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Summarize why a thin bridge matters.",
  modelProfile: "fast"
});

result.provenance; // { providerId: "openai:gpt-5-mini", locality: "cloud", attempts: [...], ... }
```

Profiles list target ids, so an on-device provider can appear in one too; its id differs per
platform. `checkCapabilities()` lists the ids registered on the current one.

Every `TaskResult`, `IndeRunError` and terminal stream event carries `provenance`: where the run
executed (`providerId`, `locality`), the model the target is configured with and, when the
backend names one, the model that served it, plus every attempt and every route rejection. Read
it rather than `telemetry.providerUsed` to show users where their request went.

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

- `createIndeRunCapacitor(options)` — returns a handle that lazily `configure()`s on its first call and memoizes it. Safe to call once at app startup. The handle has the same methods as the web SDK's `IndeRunApi`, so it can be passed wherever that type is taken.
- `run(request)` — Mode 1. Resolves with the canonical IndeRun `TaskResult`.
- `stream(request)` — Mode 2. Resolves with a `StreamRun` (`handle`, `events`, `cancel`). `events` is single-use.
- `checkCapabilities()` — every registered provider's static declaration and live availability, without executing a task. Resolves with `ProviderCapabilitySnapshot[]`. Use it for a provider or settings screen; availability changes between calls, so do not cache it across a `run()` or `stream()`.
- `prepare(request)` — makes registered providers ready ahead of a run, without producing output. Resolves with a `StreamRun` like `stream()`: progress events, then one terminal event whose output lists each item. `prepare({})` covers every provider and task; a platform download starts only where `allowDownload` on the call, or `autoDownload` at provider registration, permits it.
- `readArtifact({ artifactId, offset?, maxBytes? })` — reads a byte range of a media artifact a run produced. Resolves with an `ArtifactChunk` whose `bytes` is a `Uint8Array`.
- `disposeArtifact(artifact)` — releases an artifact's bytes. Artifacts outlive the run that produced them, so dispose each one you keep no longer.
- `speak({ text, locale, voice?, ... })` — speaks through the device. Resolves with a `SpeechPlayback` (`runId`, `result`, `cancel()`): `result` settles when playback ends or is stopped, and `cancel()` stops the audio. A `stream()` underneath, so it is cancelled through the same `cancelStream`.
- `generateSpeech({ text, locale, mediaTypes?, ... })` — synthesizes retrievable audio. Resolves with a `GeneratedSpeech` whose `artifact` is a handle, never bytes: read them with `readArtifact()` and release them with `disposeArtifact()`. A `run()` underneath, so it cannot be cancelled.
- `listVoices({ locale?, localeMatch? })` — the voices the registered providers offer right now, as `SpeechVoiceInfo[]`. Pass an entry as `voice` to speak with it.
- `close()` — closes the engine: in-flight streams and prepares end in their cancelled terminal, in-flight runs finish, artifacts are released, and the speech providers and models the plugin loaded for it are released. The handle **stays closed** — later calls fail with `Unavailable` (`details.code: "engine_closed"`) and `checkCapabilities()` reports no providers. Create a new handle to start over. Closing a handle that never configured does nothing.
- `speak`, `generateSpeech` and `listVoices` are the web SDK's speech facade (`@independo/inderun-web`) applied to the handle, so they behave exactly as on the web SDK; the facade is loaded on the first speech call, which keeps the web engine out of native app bundles. They are on `IndeRunCapacitor` too.
- The low-level plugin methods `configure(options)`, `startStream(options)`, `startPrepare(options)`, `cancelStream(options)`, `readArtifact(request)`, `disposeArtifact(artifact)` and `close()` are also exported on `IndeRunCapacitor`, along with the listener event names `STREAM_EVENT_NAME` (`"indeRunStreamEvent"`) and `STREAM_ERROR_NAME` (`"indeRunStreamError"`).

Each `configure()` builds **one engine** that every later call uses until the next `configure()`.
Artifacts belong to that engine, and a provider that loads a model keeps it loaded there, which is
why it is not rebuilt per call. A new `configure()` replaces the engine and closes the previous one
(see `close()` above), then releases the speech providers and loaded models the plugin built for it,
resolving once both have finished; a configuration that fails validation leaves the previous engine
in place. Plugin teardown does the same without waiting. The native plugin holds one engine at a time, so
handles that configure differently replace each other's engine.

> The two listener event names are **public contract**. Native emits exactly these, and an
> app may attach its own listener to them; renaming one is a breaking change.

The `IndeRunCapacitorPlugin` and `ConfigureOptions` contracts — including the `openAI`,
`systemModel`, `onnx`, `systemSpeech` and `neuralSpeech` bootstrap configs, `modelProfiles` and the
`allowDirectOpenAIEndpoint` flag — are defined and documented in `src/definitions.ts`.

Speech providers are registered only when asked for, on all three platforms:

```ts
const inderun = createIndeRunCapacitor({
  systemSpeech: true, // AVSpeechSynthesizer, Android TextToSpeech, or speechSynthesis
  neuralSpeech: [{ modelPackage }] // one neural voice model per entry, run by ONNX Runtime
});

const playback = await inderun.speak({ text: "Der Bus kommt.", locale: "de-AT" });
await playback.result;
```

`neuralSpeech` registers one provider per entry, with id
`local.onnx.speech.<apple|android|web>:<modelPackage.id>` unless the entry sets `id`. Its
`runtime` defaults to `"onnx"`, the only one this build ships: `"coreai"` is refused by
`configure()`. `autoDownload` (default off) lets `prepare()` start that provider's download on its
own. On the web, the package files must be reachable by URL and the app installs the optional
`onnxruntime-web` peer dependency; see `NeuralSpeechBootstrapOptions`. The browser's system speech
can only play audio, so `generateSpeech()` is refused there by routing.

`systemModel`, `onnx` and `allowDirectOpenAIEndpoint` are **web-only** and ignored on iOS
and Android, which register their own on-device provider from `configure()` regardless.
`systemModel` registers the browser-managed on-device provider (Chrome's Prompt API) and is
what makes `constraints.privacy = "local_required"` routable in a browser. Both on-device
web providers are Mode 1 only.

`onnx` carries two caveats. It needs the consumer to install the optional
`@huggingface/transformers` peer dependency — this bridge does not declare it — and to
supply real model weights, because the web SDK's `runtime` injection seam is a function and
so cannot cross a JSON bridge hop: only the default Transformers.js runtime is reachable
through `configure()`, never the fixture runtime the upstream demos use offline. Register it
only when the weights are there; a provider that cannot load turns a clean routing refusal
into a provider error.

Three asymmetries in the low-level surface, all hidden by the ergonomic API:

- `run(request)` passes the request at the options root, while
  `startStream({ streamId, request })` and `startPrepare({ streamId, request })` nest it,
  because that envelope also carries the bridge-local correlation id. `stream()` and
  `prepare()` hide this. A prepare run is delivered on the same two listener events and
  cancelled through the same `cancelStream({ streamId })` as a stream.
- The plugin method `readArtifact` resolves `bytes` as a **base64 string** on iOS and Android,
  because a Capacitor native call resolves JSON, which has no byte type; the web plugin resolves
  the engine's `Uint8Array`. `IndeRunCapacitor.readArtifact()` decodes either into a
  `Uint8Array`. Base64 is transport only: results still carry artifact handles, never bytes.
- The plugin method `checkCapabilities()` resolves `{ providers: [...] }` rather than the
  array itself, because a Capacitor plugin method cannot resolve a top-level array on
  either native platform. `IndeRunCapacitor.checkCapabilities()` unwraps it, so app code
  sees the same array the three platform SDKs return.

`ProviderCapabilitySnapshot` and the `ProviderDescriptor` /
`ProviderDynamicCapabilities` it contains are the generated contract types from
`@independo/inderun-contracts`, like `TaskRequest` or `StreamEvent`. Note
`capabilities.streamingAvailable` and `cancellationAvailable` are **absent**, not `null`,
when the runtime has nothing to add: absence means *inherit the static declaration*.

## Platform Notes

- Web requires at least one provider to be registered from `configure()`. The web SDK ships an
  OpenAI-compatible provider, a Web ONNX Runtime provider and a browser system-model provider, but
  only the OpenAI-compatible one declares streaming support — so a `local_required` **stream** in a
  browser is refused at routing time, while a `local_required` **run** can be served on-device.
- iOS always registers the Apple on-device provider and optionally one OpenAI target per configured model, the system speech provider and the neural speech providers.
- Android always registers the ML Kit on-device provider and optionally one OpenAI target per configured model, the system speech provider and the neural speech providers. The system speech module declares the `TTS_SERVICE` intent query an app needs to see a TTS engine from API 30; it merges into the app's manifest.
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
