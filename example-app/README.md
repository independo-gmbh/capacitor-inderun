# Bridge example app

An unpublished Capacitor app for smoke-testing the bridge on a real device. It is the only
way to exercise the parts the unit suites cannot: Capacitor's actual listener transport,
plugin teardown, and the native engines end to end.

Not part of the published package (`files` in the root `package.json` is an allowlist), not
part of SwiftPM (every target declares an explicit path under `ios/`), and not part of CI
(all three jobs are root-scoped).

## Setup

The generated native projects are gitignored, so the first run needs `cap add`:

```sh
# from the repository root
pnpm install && pnpm build

cd example-app
pnpm install
pnpm exec cap add ios        # first time only
pnpm exec cap add android    # first time only
```

## Run

```sh
pnpm run build && pnpm exec cap sync
pnpm exec cap run ios --target <device>
pnpm exec cap run android --target <device>
```

Point the app at an OpenAI-compatible proxy that holds the credentials. The app sends
`auth: "none"` and never contains a key.

Web is also runnable with `pnpm dev`, but web is covered by Vitest — the value here is the
two native paths.

## What to verify on each device

Streaming:

- Deltas render incrementally, and the event log's `sequence` column increases by exactly
  one with no gaps.
- On `completed`, the logged `finalText matches screen` line reads `true`.

Cancellation — the part most likely to regress:

- **Cancel mid-stream** → exactly one `cancelled` terminal, its `partialText` matching what
  is on screen, and *nothing* logged after it.
- **Cancel before the first delta** → a `cancelled` terminal with empty `partialText`.
- **Cancel after the terminal** → nothing happens and nothing throws.

Isolation and lifecycle:

- **Start two runs** → both accumulate independently, with distinct `runId`s and no
  cross-talk between the A and B panes.
- Background the app mid-stream, then return: no crash.
- Force-quit mid-stream, relaunch, stream again: still works. This is what exercises iOS
  `deinit` and Android `handleOnDestroy`.

Error surfaces — these are distinct and easy to conflate:

- An empty prompt → `stream() rejected` (a rejection: validation failed before a run existed).
- A bad endpoint URL → a **terminal `error` outcome**, logged as an event, *not* a rejection.
