# Repository Guidelines

## Project Structure & Module Organization
- `src/` holds the TypeScript bridge: `definitions.ts` (plugin contract types — `ConfigureOptions`,
  `OpenAIProviderBootstrapOptions`, `IndeRunCapacitorPlugin`, and the Mode 2 envelopes), `index.ts`
  (registers the Capacitor plugin via `registerPlugin`, exposes `IndeRunCapacitor` and the
  `createIndeRunCapacitor()` helper that lazily configures and memoizes), `streaming.ts` (the Mode 2
  reassembly: `StreamSink`, `StreamDispatcher`, `startCapacitorStream`), `errors.ts`
  (`normalizePluginError`, `createBridgeError`), `web.ts` (the web fallback implementation,
  `IndeRunWeb`, wired to `@independo/inderun-web`).
- Native implementations live in `android/` (Gradle module, plugin entry under
  `android/src/main/`, with `IndeRunStreamRegistry.kt` tracking live streaming runs) and
  `ios/Sources/IndeRunCapacitorPlugin/` (`IndeRunCapacitorPlugin.swift` is the Capacitor plugin
  surface, `IndeRunCapacitorBridge.swift` bridges to the native IndeRun Swift package,
  `IndeRunCapacitorStreamRegistry.swift` is the iOS counterpart of the Kotlin registry). The SwiftPM
  manifest is `Package.swift`.
- Tests: `src/*.test.ts` (Vitest), `android/src/test/` (JVM unit tests), `ios/Tests/` (Swift
  Testing/XCTest). Build output goes to `dist/` — do not edit or commit it.
- `example-app/` is an unpublished Capacitor app for device smoke-testing streaming. It is excluded
  from the npm package by the `files` allowlist, from SwiftPM by the explicit target paths, and from
  CI because every job is root-scoped. Do **not** add it to `pnpm-workspace.yaml`: that file has no
  `packages:` key, so pnpm treats the root as a single package, and adding it would drag the example
  into `--frozen-lockfile`.
- This repo is deliberately a **thin bridge only**: it delegates routing, provider logic, and error
  normalization to the released IndeRun platform SDKs (`@independo/inderun-web` on npm, the
  `IndeRun` Swift package, `app.independo.inderun:inderun-*` on Maven Central). Native SDK behavior
  changes belong in the main [`independo-gmbh/inderun`](https://github.com/independo-gmbh/inderun)
  monorepo, not here.

## Build, Test, and Development Commands
- `pnpm build` — compiles the TypeScript bridge (`tsc -p tsconfig.json`) into `dist/`.
- `pnpm test` / `pnpm test:web` — runs the Vitest suite for the web fallback.
- `pnpm test:android` — runs `android/src/test` via `./gradlew :testDebugUnitTest`.
- `pnpm test:ios` — runs `swift test` against `ios/Tests`.
- `pnpm lint` — type-check only (`tsc --noEmit -p tsconfig.json`); there is no separate ESLint step.
- `pnpm verify:web` / `verify:android` / `verify:ios` — platform build verification (`tsc`, Gradle
  `assembleDebug`, `swift build` respectively). Android/iOS verification require the Android
  SDK/NDK and Xcode toolchains locally.

## Coding Style & Naming Conventions
- TypeScript is `strict` with `NodeNext` module resolution (see `tsconfig.json`); source files use
  `.js`-suffixed relative imports (e.g. `from "./definitions.js"`) as required by NodeNext.
  2-space indentation, double quotes, semicolons — matches existing `src/` files.
  Classes/interfaces/types in `PascalCase`, functions/variables in `camelCase`.
- Keep the bridge thin: new logic that isn't Capacitor-specific plumbing (marshaling errors between
  native/web and the shared `IndeRunError` contract, registering the plugin) belongs upstream in
  `inderun`, not in this repo.
- The Mode 2 reorder buffer is transport plumbing, not orchestration. It exists because the bridge
  hop can reorder delivery and `StreamEvent.sequence` is the contract's ordering authority. It must
  never decide a run's outcome: it does not synthesize terminal events, retry, choose providers, or
  apply fallback. Anything resembling routing, fallback, or terminal policy belongs upstream. The
  same rule is why the two native registries cancel the `StreamRun` rather than the pumping
  task/job — the engine owns the one `cancelled` terminal, the bridge only delivers it.

## Testing Guidelines
- Vitest specs live beside their source as `*.test.ts` (e.g. `src/web.test.ts`); prefer asserting
  observable behavior (error normalization, `configure()`/`run()` sequencing) over implementation
  details.
- Run `pnpm test` before submitting changes; run `pnpm test:android` / `pnpm test:ios` when touching
  native code, and the corresponding `verify:*` script when available locally.

## Commit & Pull Request Guidelines
- Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`) — this repo
  runs `semantic-release` (see `release.config.cjs`) off commit messages.
- PRs should note affected platforms (web/android/ios), test evidence, and any corresponding change
  needed in the `inderun` monorepo (e.g. a new provider option added upstream that this bridge needs
  to expose).
- Do not commit `dist/` or other generated build output.

## Versioning Policy
- This package versions **independently**, under plain semver, driven by `semantic-release` off the
  commit messages in this repo.
- It does *not* mirror the `inderun` monorepo's version. An earlier rule said `MAJOR.MINOR` tracked
  the monorepo's npm packages; that was already untrue in practice (this package reached 1.0.0
  against `inderun` 0.2.2) and pinning two independently released artifacts to one number made
  neither version mean anything. It has been dropped rather than quietly broken again.
- State the supported `inderun` version in `README.md` instead, and bump every platform's pin in one
  go — a partial bump is how the three platforms drift apart.
- Pin `inderun` **exactly** in `package.json` and `android/build.gradle.kts`, and constrain it in
  `Package.swift` with `.upToNextMinor(from:)`. The asymmetry is deliberate: the npm and Gradle pins
  are this package's own resolution, while the SwiftPM constraint is a *consumer's* — an app that also
  depends on `inderun` directly cannot unify its graph against an `exact:` pin. `.upToNextMinor`
  rather than `from:` because `from:` on a 0.x means `<1.0.0`, which would let SwiftPM float across a
  minor (where an 0.x SDK's breaking changes live) while the other two stay pinned, and invisibly, as
  `Package.resolved` is gitignored.
- Bumping is a five-file edit — `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`'s
  `minimumReleaseAgeExclude`, `Package.swift`, `android/build.gradle.kts` — plus the version table in
  `README.md`. Miss the workspace allowlist and the install is age-blocked. Note `pnpm install` alone
  may leave the lockfile's importer entry on the old version while updating its specifier; check it,
  and use `pnpm up <pkg>@<version>` when it does.
- While the bridge tracks an `inderun` **prerelease**, switch `Package.swift` back to `exact:`.
  SwiftPM's `from:` / `.upToNextMinor` / `.upToNextMajor` range operators **exclude** prerelease
  versions, so a range on a `-dev.N` silently resolves the older stable and the build fails somewhere
  far from the cause.
