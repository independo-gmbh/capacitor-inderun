<p align="center">
  <img src="https://inderun.dev/brand/inderun-icon-lilac.svg" width="128" height="128" alt="IndeRun logo" />
</p>
<h1 align="center">IndeRun for Capacitor</h1>
<p align="center"><strong><code>@independo/capacitor-inderun</code></strong></p>
<p align="center">On-device AI for the devices your users actually have.<br>On-device when available. Cloud only when you allow it.</p>

<p align="center">
  <a href="https://github.com/independo-gmbh/capacitor-inderun/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/independo-gmbh/capacitor-inderun/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://www.npmjs.com/package/@independo/capacitor-inderun"><img src="https://img.shields.io/npm/l/@independo/capacitor-inderun" alt="License Badge: MIT" /></a>
  <a href="https://inderun.dev/docs/getting-started/capacitor"><img alt="Docs: inderun.dev" src="https://img.shields.io/badge/docs-inderun.dev-A0B3FF"></a>
<br>
  <a href="https://www.npmjs.com/package/@independo/capacitor-inderun"><img src="https://img.shields.io/npm/dw/@independo/capacitor-inderun" alt="" role="presentation" /></a>
  <a href="https://www.npmjs.com/package/@independo/capacitor-inderun"><img src="https://img.shields.io/npm/v/@independo/capacitor-inderun" alt="" role="presentation" /></a>
</p>

<p align="center">Built and maintained by <a href="https://www.independo.app/">Independo</a>. Supported by <a href="https://www.netidee.at/inderun">netidee</a>.</p>

Run a prompt, or speak a sentence, on the device first. IndeRun brings Apple Foundation Models on
iOS, ML Kit GenAI (Gemini Nano) on Android, your own ONNX models, and system and neural voices
behind one API, with streaming and cancellation. Routing decides which one serves a request. A cloud
route exists only if you register one and a request permits it. MIT.

Documentation: [inderun.dev/docs/getting-started/capacitor](https://inderun.dev/docs/getting-started/capacitor).

It is a thin bridge, not a second engine. The package delegates to the released
[IndeRun](https://github.com/independo-gmbh/inderun) platform SDKs instead of re-implementing
routing, provider logic, or normalized error handling:

- web: [`@independo/inderun-web`](https://www.npmjs.com/package/@independo/inderun-web) (npm)
- iOS: `IndeRun` Swift package (`github.com/independo-gmbh/inderun`, SwiftPM)
- Android: `app.independo.inderun:inderun-*` (Maven Central)

> This repository is the SwiftPM/npm-publishable home of the Capacitor bridge only.
> The native SDKs it wraps live in the main [`independo-gmbh/inderun`](https://github.com/independo-gmbh/inderun) monorepo.

## Install

<!-- version:install -->
```sh
pnpm add @independo/capacitor-inderun @capacitor/core@8
```
<!-- /version -->

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
Availability is checked at runtime. When a provider is missing, routing skips it. If nothing else is allowed to serve the request, it is refused with an `IndeRunError`; it never goes to the cloud unless you registered a cloud route and the request permits one.

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
| <!-- version:kotlin-plugin -->`org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21`<!-- /version --> on the app's `buildscript` classpath | — | *"Module was compiled with an incompatible version of Kotlin … metadata is 2.4.0, expected version is 2.2.0"* |

The Kotlin one is the surprising entry: the `inderun-*` artifacts carry Kotlin 2.4.x
metadata, which the Kotlin plugin AGP brings by default cannot read. The plugin's own build
hoists a newer KGP for its standalone build, but a consuming app resolves KGP from its own
buildscript classpath, so the app has to add it too:

<!-- version:kotlin-plugin-gradle -->
```groovy
// android/build.gradle
buildscript {
    dependencies {
        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21'
    }
}
```
<!-- /version -->

AGP 9 also rejects `getDefaultProguardFile('proguard-android.txt')`; switch to
`proguard-android-optimize.txt`.

**iOS**: set `IPHONEOS_DEPLOYMENT_TARGET` to `16.0` in your Xcode project **before**
`npx cap sync ios`. The Capacitor CLI reads that value to generate `CapApp-SPM/Package.swift`,
so syncing with the default leaves a manifest pinned below this package's floor and the build
fails with *"requires minimum platform version 16.0 for the iOS platform, but this target
supports 15.0"*.

## Supported IndeRun Version

This release tracks <!-- version:inderun-version -->**IndeRun 0.5.0**<!-- /version --> on all three platforms:

<!-- version:supported-table -->
| Platform | Artifact | Constraint |
|----------|----------|------------|
| Web      | `@independo/inderun-web`, `@independo/inderun-contracts` | `0.5.0` (exact) |
| iOS      | `inderun` SwiftPM package | `.upToNextMinor(from: "0.5.0")` |
| Android  | `app.independo.inderun:inderun-*` | `0.5.0` (exact) |
<!-- /version -->

<!-- version:pin-policy -->
The npm and Maven pins are exact and bumped together with the SwiftPM pin — a partial bump is how the platforms drift apart. SwiftPM takes the same version as `.upToNextMinor`, so an app that also depends on `inderun` directly can unify its graph.
<!-- /version -->

This package versions **independently** of the IndeRun monorepo under plain semver — the numbers are
unrelated, and this bridge's own version says nothing about which IndeRun release it wraps. Read that
off the table above.

## Usage

Start with no cloud configuration. On iOS and Android the plugin registers the device's own
provider (Apple Foundation Models, ML Kit GenAI) from `configure()`, so there is nothing to pass.
The handle configures itself on the first call.

<!-- snippet:usage -->
```ts
import { createIndeRunCapacitor, type IndeRunError } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor();

// What can run here, right now. Availability changes, so ask again instead of caching.
for (const provider of await inderun.checkCapabilities()) {
  console.log(provider.providerId, provider.capabilities.available, provider.capabilities.reason);
}

try {
  const result = await inderun.run({
    schemaVersion: "1.0",
    task: { kind: "text_to_text" },
    prompt: "Summarize why a thin bridge matters.",
    constraints: { privacy: "local_required" }
  });

  console.log(result.output.text);
  // Where it ran: provenance names the provider and its locality.
  console.log(result.provenance?.providerId, result.provenance?.locality); // e.g. "on_device"
} catch (error) {
  if (error && typeof error === "object" && "errorClass" in error) {
    // `local_required` never leaves the device. When no local provider can serve the request,
    // it is refused here, for example with errorClass "CapabilityMismatch".
    const { errorClass, provenance } = error as IndeRunError;
    console.log(errorClass, provenance?.routeRejections);
  }
}
```
<!-- /snippet -->

`local_required` is a promise: the request is refused rather than sent to a cloud provider, and
the check runs at routing and again before each attempt. `provenance.routeRejections` lists every
provider that was skipped and why.

Every `TaskResult`, `IndeRunError` and terminal stream event carries `provenance`: where the run
executed (`providerId`, `locality`), the model the target is configured with and, when the
backend names one, the model that served it, plus every attempt and every route rejection. Read
it rather than `telemetry.providerUsed` to show users where their request went.

**On the web, register a local provider.** The web has no built-in one, and `configure()` fails
with `Unavailable` when it has nothing to register. Pass `systemModel: {}` (Chrome's Prompt API),
`onnx` (see [On-device ONNX models](#on-device-onnx-models)), or speech
(see [Speech](#speech)):

<!-- snippet:web-system-model -->
```ts
import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({ systemModel: {} });
```
<!-- /snippet -->

`systemModel` is **web-only** and ignored on iOS and Android. It is what makes
`constraints.privacy = "local_required"` routable in a browser.

## Speech

Speech providers register only when asked for, on all three platforms. The router probes every
registered provider on every request, so an app that does not speak should not pay for a voice
listing.

<!-- snippet:speak -->
```ts
import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({
  systemSpeech: true // AVSpeechSynthesizer, Android TextToSpeech, or the browser's speechSynthesis
});

// The voices on this device. Pass one as `voice` to speak with it.
const voices = await inderun.listVoices({ locale: "de-AT" });

const playback = await inderun.speak({
  text: "Der Bus kommt.",
  locale: "de-AT",
  ...(voices[0] ? { voice: voices[0] } : {}),
  execution: { privacy: "local_required" }
});

// Stop early with `playback.cancel()`. `result` settles when playback ends or is stopped.
const spoken = await playback.result;
console.log(spoken.outcome, spoken.provenance?.providerId);
```
<!-- /snippet -->

To get the audio instead of playing it, use `generateSpeech()`. It returns an artifact handle,
never bytes. Read the bytes with `readArtifact()` and release them with `disposeArtifact()`:

<!-- snippet:generate-speech -->
```ts
import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({ systemSpeech: true });

const speech = await inderun.generateSpeech({
  text: "Der Bus kommt.",
  locale: "de-AT",
  mediaTypes: ["audio/wav"]
});

try {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await inderun.readArtifact({ artifactId: speech.artifact.id, offset });
    chunks.push(chunk.bytes);
    offset += chunk.bytes.byteLength;
    if (chunk.done) {
      break;
    }
  }
  const wav = new Blob(chunks as BlobPart[], { type: speech.artifact.mediaType });
  console.log(wav.size, speech.artifact.mediaType);
} finally {
  await inderun.disposeArtifact(speech.artifact);
}
```
<!-- /snippet -->

`speak()` is a `stream()` underneath, so it is cancelled like one. `generateSpeech()` is a `run()`
underneath and cannot be cancelled. Both go through the same routing as text, so `execution`
accepts the same `privacy`, `cloud` and `timeoutMs` constraints.

### Neural voices

A neural voice is a developer-supplied model package. The plugin downloads nothing on its own.
Your app fetches the files with any downloader into the platform's app-managed directory, then
passes a `ModelPackage` that describes them. With `@capacitor/filesystem` (8.1.5), `Directory.Library`
reaches it on both platforms: on iOS the files go to `Application Support/<ref>/<file>` inside the
Library directory (the engine's `app_managed` is Application Support), on Android to `<ref>/<file>`
(`Directory.Library` and `Directory.Data` are both `context.filesDir`, the engine's `app_managed`);
create the folders with `mkdir({ recursive: true })` first, because the Android download does not.
The [test app's speech panel](example-app/src/neural-package.ts) is working code for this.

List a sha256 per file in `integrity.checksums`; the providers verify each file before loading it.
`prepare()` then warms the model up ahead of the first sentence.

<!-- snippet:neural-voices -->
```ts
import { createIndeRunCapacitor, type ModelPackage } from "@independo/capacitor-inderun";

// What `model-package.json` describes, trimmed to the fields that matter here. The source says
// where the app put the files, and each file's checksum is verified before it is loaded.
const modelPackage: ModelPackage = {
  id: "my-voice",
  version: "1",
  format: "onnx",
  tasks: ["text_to_speech"],
  source: { sourceType: "app_managed", ref: "models/voice" },
  integrity: { checksums: { "text.onnx": "sha256:<hex digest of the downloaded file>" } },
  speech: {
    pipeline: "articulino",
    sampleRate: 24000,
    channels: 1,
    graphs: { text: "text.onnx", dit_step: "dit_step.onnx", decoder: "decoder.onnx" },
    voices: [{ id: "de-at-m-1", name: "Max", locales: ["de-AT"], gender: "male", file: "voices/de-at-m-1.safetensors" }]
  }
};

const inderun = createIndeRunCapacitor({
  systemSpeech: true,
  neuralSpeech: [{ modelPackage }]
});

// Optional. Loads and verifies the model now, so the first `speak()` does not pay for it.
const preparation = await inderun.prepare({ tasks: ["text_to_speech"] });
for await (const event of preparation.events) {
  if (event.type === "terminal") {
    console.log(event.payload?.outcome);
  }
}
```
<!-- /snippet -->

`neuralSpeech` registers one provider per entry, with id
`local.onnx.speech.<apple|android|web>:<modelPackage.id>` unless the entry sets `id`. Its `runtime`
defaults to `"onnx"`. `runtime: "coreai"` runs a Core AI package on **iOS 27+** (id
`local.coreai.speech.apple:<modelPackage.id>`); on older iOS the provider reports itself unavailable
and routing skips it, and `configure()` refuses `"coreai"` on Android and the web. `autoDownload`
(default off) lets `prepare()` start that provider's download on its own, and `prepare({ allowDownload: true })`
allows it for one call. On the web the package files must be reachable by URL and the app installs the
optional `onnxruntime-web` peer dependency; see `NeuralSpeechBootstrapOptions`.

Platform notes for speech:

- **iOS:** the app owns the `AVAudioSession`. If you want playback to be audible with the silent
  switch on, set the category (`.playback`, mode `.spokenAudio`) yourself before calling `speak()`.
- **Web:** system speech plays audio but cannot write an artifact, so routing refuses
  `generateSpeech()` there. A neural voice can do both.
- **Android:** the system speech module declares the `TTS_SERVICE` intent query an app needs to see
  a TTS engine from API 30; it merges into the app's manifest.

## On-device ONNX models

`onnx` runs a developer-supplied ONNX text model on every platform. It does not stream: it serves
`run()` only.

<!-- snippet:onnx -->
```ts
import { createIndeRunCapacitor, type ModelPackage } from "@independo/capacitor-inderun";

const modelPackage: ModelPackage = {
  id: "my-model",
  format: "genai",
  tasks: ["text_to_text"],
  source: { sourceType: "app_managed", ref: "models/my-model" }
};

const inderun = createIndeRunCapacitor({ onnx: { modelPackage } });

const result = await inderun.run({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Summarize why a thin bridge matters.",
  constraints: { privacy: "local_required" }
});
```
<!-- /snippet -->

On iOS and Android it registers ONNX Runtime's provider (id `local.onnx.genai.apple` or
`local.onnx.genai.android` unless the options set `id`). The model files have to be on the device
already, and the plugin downloads nothing: `modelPackage.source.sourceType` is `app_managed` (the
app's storage under `source.ref`: Application Support on iOS, `context.filesDir` on Android),
`filesystem` (an absolute path) or `bundled`. The same applies to `neuralSpeech` packages. The
provider loads the model on first use.

On the web, `onnx` needs the consumer to install the optional
`@huggingface/transformers` peer dependency — this bridge does not declare it — and to
supply real model weights, because the web SDK's `runtime` injection seam is a function and
so cannot cross a JSON bridge hop: only the default Transformers.js runtime is reachable
through `configure()`, never the fixture runtime the upstream demos use offline. Register it
only when the weights are there; a provider that cannot load turns a clean routing refusal
into a provider error.

## Allow a cloud route

A cloud route is opt-in twice: you register it in `configure()`, and a request has to permit it.
Without `openAI` there is no cloud route at all. With one, use `privacy: "local_preferred"` to try
the device first and go to the cloud only when the device cannot serve the request.

<!-- snippet:cloud-route -->
```ts
import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({
  openAI: {
    models: ["gpt-5.2"],
    // Your own backend, which holds the API key. The app never sees it.
    endpointUrl: "https://example.com/api/inderun/openai-responses",
    auth: "none"
  }
});

const result = await inderun.run({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Summarize why a thin bridge matters.",
  constraints: { privacy: "local_preferred" }
});

console.log(result.provenance?.locality); // "on_device" or "cloud"
```
<!-- /snippet -->

`openAI.models` registers one OpenAI-compatible target per model, with id `openai:<model>`
(`openai:gpt-5.2` above) on every platform. That id is the `providerId` results, errors and
telemetry report, so code that compares provider ids must expect it rather than `openai`.

Keep credentials out of the app. Point `endpointUrl` at a backend you control (for browser apps, a
same-origin proxy) and use `auth: "none"`, or name a stored credential with
`auth: "authContextRef"` and `authContextRef`. A raw key never belongs in a request payload.

### Model profiles

`modelProfiles` names ordered lists of targets, and a request opts into one with
`modelProfile`. Routing then stays within that list, in that order, after placement
constraints such as `privacy`. Without a `modelProfile` — or with `"auto"`, which cannot be
redefined — every registered target is eligible; naming a profile that was not configured
fails the request.

<!-- snippet:model-profiles -->
```ts
import { createIndeRunCapacitor } from "@independo/capacitor-inderun";

const inderun = createIndeRunCapacitor({
  openAI: {
    models: ["gpt-5.2", "gpt-5-mini"],
    endpointUrl: "https://example.com/api/inderun/openai-responses",
    auth: "none"
  },
  modelProfiles: {
    smart: ["openai:gpt-5.2"],
    fast: ["openai:gpt-5-mini"]
  }
});

const result = await inderun.run({
  schemaVersion: "1.0",
  task: { kind: "text_to_text" },
  prompt: "Summarize why a thin bridge matters.",
  constraints: { privacy: "cloud_allowed" },
  modelProfile: "fast"
});

console.log(result.provenance?.providerId); // "openai:gpt-5-mini"
```
<!-- /snippet -->

Profiles list target ids, so an on-device provider can appear in one too; its id differs per
platform. `checkCapabilities()` lists the ids registered on the current one.

## Streaming (Mode 2)

`stream()` returns the same `StreamRun` shape the platform SDKs return directly: the
run's handle, its canonical event sequence, and a cancel hook.

<!-- snippet:streaming -->
```ts
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
```
<!-- /snippet -->

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
(see `close()` above), then releases the speech providers, ONNX text providers and loaded models the plugin built for it,
resolving once both have finished; a configuration that fails validation leaves the previous engine
in place. Plugin teardown does the same without waiting. The native plugin holds one engine at a time, so
handles that configure differently replace each other's engine.

> The two listener event names are **public contract**. Native emits exactly these, and an
> app may attach its own listener to them; renaming one is a breaking change.

The `IndeRunCapacitorPlugin` and `ConfigureOptions` contracts — including the `openAI`,
`systemModel`, `onnx`, `systemSpeech` and `neuralSpeech` bootstrap configs, `modelProfiles` and the
`allowDirectOpenAIEndpoint` flag — are defined and documented in `src/definitions.ts`.

`systemModel` and `allowDirectOpenAIEndpoint` are **web-only** and ignored on iOS and Android,
which register their own on-device provider from `configure()` regardless.
`allowDirectOpenAIEndpoint` is the web SDK's explicit opt-in for calling a public Responses endpoint
straight from the browser; leave it unset and use a proxy.

Speech is covered in [Speech](#speech) and ONNX text models in [On-device ONNX models](#on-device-onnx-models).

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

- Web requires at least one provider to be registered from `configure()`: `systemModel`, `onnx`,
  `systemSpeech`, `neuralSpeech` or `openAI`. No browser text provider streams, so a
  `local_required` **stream** of text in a browser is refused at routing time, while a
  `local_required` **run** can be served on-device.
- iOS always registers the Apple on-device provider. It adds one OpenAI target per configured model, the ONNX text provider, the system speech provider and the neural speech providers when you configure them.
- Android always registers the ML Kit on-device provider. It adds the same optional providers as iOS.
- Apple Foundation Models and ML Kit GenAI stream on-device. ONNX Runtime text models do not.
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
  Today Apple Foundation Models, ML Kit GenAI and the OpenAI-compatible provider stream text.
  ONNX Runtime and the browser system model are Mode 1 only.
- **The plugin downloads no models.** ONNX text and neural voice packages have to be on the device
  already, put there by your app. A neural voice package that fails its checksum is not loaded.
- **One engine at a time on native.** Handles that configure differently replace each other's engine.
- Core AI speech needs iOS 27 or later. Below that the provider reports itself unavailable.
- An unrecognized `StreamEvent.type` is passed through untouched rather than rejected, so a
  consumer built against an older contract revision keeps working when a newer one adds an
  event type. Ignore what you do not recognize.
- No plugin-level credential management API is exposed. Credentials come from the backend you
  point `endpointUrl` at, or from `authContextRef`.

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

<!-- snippet:error-handling -->
```ts
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
```
<!-- /snippet -->

## License

MIT. See [`LICENSE`](./LICENSE).

## Sponsorship & Development

This project is sponsored by [netidee](https://www.netidee.at/inderun) and developed
by [Independo GmbH](https://www.independo.app).

Explore more [open-source tools and research from Independo](https://www.independo.app/open-source).
