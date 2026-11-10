# IndeRun local-first starter

A small Capacitor 8 + Vite + TypeScript app (no UI framework) to copy when you start your own.
Everything it does stays on the device. There is no cloud configuration and no account.

Full guide: <https://inderun.dev/docs/getting-started/capacitor>

## What it shows

- **What runs on this device**: `checkCapabilities()`, listed per provider with its type,
  whether it is available (and why not), and per-task readiness.
- **Ask**: `run()` with `constraints.privacy = "local_required"`. It shows the answer and where it
  ran (`provenance.providerId`, `locality`). On a device with no on-device model it shows the
  `IndeRunError` class and message instead. That refusal is a valid outcome: the prompt was not
  sent anywhere else.
- **Speak**: `speak()` with `systemSpeech: true`, a **Stop** button that cancels playback, and the
  `finishReason` once playback has settled.

Neural voices are not here. The demo voice catalog is benchmark-only until legal review
finishes; the [test app](../../example-app/) has a panel for them.

## Prerequisites

- Node 24 and pnpm
- iOS: Xcode (iOS 16 or newer deployment target)
- Android: Android Studio with the Android SDK 37 and NDK installed, a JDK 17+

This app is not part of the repository's pnpm workspace or CI. It installs the plugin from the
repository root (`file:../..`).

## Install and build

```sh
# from the repository root: the starter consumes the built plugin
pnpm install && pnpm build

cd examples/local-first-starter
pnpm install --ignore-workspace   # required: the repo root is not a workspace
pnpm build                        # vite build -> dist/
```

`pnpm dev` runs the page in a browser. The web has no on-device text model, so **Ask** is refused
there (a correct result); **Speak** uses the browser's `speechSynthesis`.

After changing anything in the root `src/`, run `pnpm build` at the root and
`pnpm install --ignore-workspace` here again, or the app keeps the old copy.

## Native projects

The `ios/` and `android/` folders are generated and gitignored, as in the test app. Add them once:

```sh
pnpm exec cap add ios
pnpm exec cap add android
```

A fresh Capacitor project is older than the SDKs this plugin wraps. Apply the changes below once
(the full list, with the error each one prevents, is the root README's
[Host Project Requirements](../../README.md#host-project-requirements)):

```sh
# iOS: before the first `cap sync ios`
sed -i '' 's/IPHONEOS_DEPLOYMENT_TARGET = 15.0/IPHONEOS_DEPLOYMENT_TARGET = 16.0/' \
  ios/App/App.xcodeproj/project.pbxproj

# Android
cd android
sed -i '' -e 's/minSdkVersion = 24/minSdkVersion = 26/' \
          -e 's/compileSdkVersion = 36/compileSdkVersion = 37/' variables.gradle
sed -i '' "s#gradle:8.13.0'#gradle:9.3.1'\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21'#" build.gradle
sed -i '' 's/gradle-8.14.3-all/gradle-9.7.0-all/' gradle/wrapper/gradle-wrapper.properties
sed -i '' 's/proguard-android.txt/proguard-android-optimize.txt/' app/build.gradle
cd ..
```

(The `sed -i ''` form is macOS. On Linux use `sed -i`. The version numbers match what `cap add`
generates today; if yours differ, edit by hand.)

## Run

```sh
pnpm build && pnpm exec cap sync
pnpm exec cap run ios --target <device>
pnpm exec cap run android --target <device>
```

On iOS the app owns the audio session. To hear speech with the silent switch on, set the
`AVAudioSession` category (`.playback`, mode `.spokenAudio`) in your app before calling `speak()`.

## Where to look

All of the app logic is `src/main.ts`, about 120 lines. The one line that matters:

```ts
const inderun = createIndeRunCapacitor({ systemSpeech: true });
```

Pass nothing and iOS/Android register only their on-device text provider. Add `openAI` later if you
want a cloud route, and a request still has to allow it (`constraints.privacy`).
