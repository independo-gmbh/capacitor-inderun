# Contributing

This guide provides instructions for contributing to this Capacitor plugin.

## Developing

### Local Setup

1. Fork and clone the repo.
2. Install the dependencies.

    ```shell
    pnpm install
    ```

### Prerequisites for platform testing

- Java 21 (recommended) for Android unit tests and verification.
- Android SDK for `pnpm test:android` or `pnpm verify:android`.
- Xcode for `pnpm test:ios` or `pnpm verify:ios`.

### Scripts

#### `pnpm build`

Compiles the TypeScript bridge (`tsc -p tsconfig.json`) into `dist/`.

#### `pnpm test`

Runs the Vitest suite for the web fallback (`src/web.test.ts`). Also available as `pnpm test:web`.

#### `pnpm test:android`

Runs the Android unit tests via Gradle (`./gradlew :testDebugUnitTest`).

#### `pnpm test:ios`

Runs the Swift package tests (`swift test`).

#### `pnpm lint`

Type-checks the TypeScript sources without emitting output.

#### `pnpm check:snippets` / `pnpm sync:markers` / `pnpm check:markers`

Every TypeScript example in the README lives in `snippets/NAME.ts` and is type-checked against
`src/index.ts` by `check:snippets`. The README copy sits between `<!-- snippet:NAME -->` markers and
the version facts between `<!-- version:NAME -->` markers (rendered from `versions.json`); edit the
snippet or `versions.json`, then run `sync:markers`. `check:markers` fails when the README is stale or
when `versions.json` disagrees with the pins in `package.json`, `Package.swift` or
`android/build.gradle.kts`. A snippet marked `TODO(verify)` is skipped and reported as pending.

#### iOS plugin sources

`swift build` and `swift test` on macOS skip the Capacitor-conditional plugin sources. Compile them for
the iOS simulator with `cd ios/CIProbe && xcodebuild -scheme Probe -destination 'generic/platform=iOS Simulator' build`;
CI runs the same command. `ios/CIProbe` is a CI-only package and is not published.

#### `pnpm verify:web` / `pnpm verify:android` / `pnpm verify:ios`

Platform build verification. `verify:android` and `verify:ios` require a configured Android SDK/NDK
and Xcode toolchain respectively.

### Local-artifact mode (building against an unreleased IndeRun)

A bump to an IndeRun version that is not released yet commits the final pins, so the branch does not
install or build from the registries until that release exists. Local-artifact mode builds it against
artifacts you produce from an `inderun` checkout. Each platform switches separately, and nothing changes
while the switch is off: no committed file names a local path, a tarball or a `file:` specifier, and
nothing local mode produces is committed.

1. In an `inderun` checkout at the commit you want (a `git worktree` keeps your own checkout clean),
   stamp the version the bridge pins and build the artifacts. Name the directory `inderun`: SwiftPM
   derives the package identity from it. The core build needs rustup with the `wasm32-unknown-unknown`
   target and `wasm-bindgen-cli` (for `pnpm build`), the Android NDK (for `publishToMavenLocal`) and
   the Xcode command line tools.

    ```shell
    node scripts/set-version.mjs <version>   # the version package.json pins
    pnpm install && pnpm build
    for p in contracts inderun-route-core-wasm inderun-web; do
      (cd packages/$p && pnpm pack --pack-destination <tarballs>)
    done
    (cd android && ./gradlew publishToMavenLocal)
    ```

    `<tarballs>` is an absolute directory holding exactly one tarball per package, of the version
    `package.json` pins. The Apple XCFrameworks are committed in `inderun`, so the checkout itself is
    the Swift package.

2. npm, in this repository:

    ```shell
    rm -rf node_modules
    INDERUN_LOCAL_TARBALLS=<tarballs> pnpm install \
      --config.pnpmfile=scripts/inderun-local.pnpmfile.cjs --config.lockfile=false
    export pnpm_config_verify_deps_before_run=false
    ```

    `scripts/inderun-local.pnpmfile.cjs` is a pnpm `readPackage` hook that rewrites the three
    `@independo/inderun-*` dependencies to the local tarballs while pnpm reads the manifests, so
    `package.json` stays as committed, and `lockfile=false` keeps the local resolution out of
    `pnpm-lock.yaml`. pnpm loads the hook only when it is passed like this; it fails when
    `INDERUN_LOCAL_TARBALLS` is unset or a tarball's version differs from the pin. The export stops
    `pnpm <script>` from first re-installing against the lockfile, which fails while the pinned version
    is unpublished. Remove `node_modules` before installing again after rebuilding the tarballs:
    pnpm reports "Already up to date" and keeps the old ones otherwise.

3. Android: pass `-PinderunLocal`, e.g. `pnpm test:android -PinderunLocal` (or set
   `ORG_GRADLE_PROJECT_inderunLocal=true`). `android/settings.gradle` then resolves
   `app.independo.inderun:*` from Maven local only, so a missing local publish fails instead of
   falling back to Maven Central.

4. iOS: set `INDERUN_LOCAL_PATH` to the checkout and keep SwiftPM off the network,
   e.g. `INDERUN_LOCAL_PATH=<checkout> pnpm test:ios --skip-update`, and for the plugin sources
   `cd ios/CIProbe && INDERUN_LOCAL_PATH=<checkout> xcodebuild -scheme Probe -destination 'generic/platform=iOS Simulator' -skipPackageUpdates build`.
   `Package.swift` then uses `.package(path:)` instead of the released tag. The checkout's own
   dependencies still come from git: when an upstream is unreachable, seed `.build/repositories` from
   `~/Library/Caches/org.swift.swiftpm/repositories`. SwiftPM records no path dependency in
   `Package.resolved` (gitignored anyway); run `swift package resolve` once the release exists.

`pnpm-lock.yaml` cannot name an unpublished version, so such a bump leaves it on the previous release
(and `pnpm install --frozen-lockfile` fails until it is refreshed). Once the pinned version is published,
drop the variables and the property, run `rm -rf node_modules && pnpm install`, check that the lockfile's
importer entry moved too (`pnpm up <pkg>@<version>` if not, see `AGENTS.md`), and commit the lockfile.

## Scope of Changes

This repository is a thin Capacitor bridge only — it delegates routing, provider logic, and error
normalization to the released IndeRun platform SDKs (`@independo/inderun-web` on npm, the `IndeRun`
Swift package, and `app.independo.inderun:inderun-*` on Maven Central). Changes to routing,
providers, or error taxonomy belong in the main
[`independo-gmbh/inderun`](https://github.com/independo-gmbh/inderun) monorepo; this repo should
only need updates when the Capacitor-specific plugin surface (registration, marshaling,
configuration bootstrap) changes.

## Commit & Pull Request Guidelines

- Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`); this repo
  relies on `semantic-release` tooling.
- Keep commits scoped and descriptive (e.g., `fix: normalize native error envelope on Android`).
- PRs should include: summary of changes, affected platforms (web/android/ios), test evidence
  (`pnpm test`, `pnpm verify:*` excerpts if run), and notes on any corresponding change needed in
  the `inderun` monorepo.
- Do not commit generated artifacts (`dist/`); ensure lockfile changes are intentional.
- Target pull requests at `dev`, not `main` — `main` only receives stable releases via the `dev` →
  `main` promotion flow.

## Versioning

This package versions independently of `inderun`, under semver driven by `semantic-release`. While
`inderun` is pre-1.0, a `BREAKING CHANGE:` footer releases a minor rather than a major. The supported
`inderun` version is stated in `README.md`. See the Versioning Policy in [`AGENTS.md`](AGENTS.md)
for the pinning rules.
