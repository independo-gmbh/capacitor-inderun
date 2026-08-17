# Repository Guidelines

## Project Structure & Module Organization
- `src/` holds the TypeScript bridge: `definitions.ts` (plugin contract types — `ConfigureOptions`,
  `OpenAIProviderBootstrapOptions`, `IndeRunCapacitorPlugin`), `index.ts` (registers the Capacitor
  plugin via `registerPlugin`, exposes `IndeRunCapacitor` and the `createIndeRunCapacitor()` helper
  that lazily configures and memoizes), `web.ts` (the web fallback implementation, `IndeRunWeb`,
  wired to `@independo/inderun-web`).
- Native implementations live in `android/` (Gradle module, plugin entry under
  `android/src/main/`) and `ios/Sources/IndeRunCapacitorPlugin/` (`IndeRunCapacitorPlugin.swift` is
  the Capacitor plugin surface, `IndeRunCapacitorBridge.swift` bridges to the native IndeRun Swift
  package). The SwiftPM manifest is `Package.swift`.
- Tests: `src/web.test.ts` (Vitest), `android/src/test/` (JVM unit tests), `ios/Tests/` (Swift
  Testing/XCTest). Build output goes to `dist/` — do not edit or commit it.
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
- This package's `MAJOR.MINOR` tracks the `inderun` monorepo's own npm package versions
  (`@independo/inderun-web`, `@independo/inderun-contracts`) — a hard rule for `MAJOR`, generally
  followed for `MINOR`. `PATCH` is independent: an `inderun` patch triggers a matching patch here,
  but not the reverse.
