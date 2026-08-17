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

#### `pnpm verify:web` / `pnpm verify:android` / `pnpm verify:ios`

Platform build verification. `verify:android` and `verify:ios` require a configured Android SDK/NDK
and Xcode toolchain respectively.

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

This package's `MAJOR.MINOR` tracks `inderun`'s own npm package versions
(`@independo/inderun-web`, `@independo/inderun-contracts`) — a hard rule for `MAJOR`, generally
followed for `MINOR`. `PATCH` is independent of `inderun`'s patch releases in the other direction.
