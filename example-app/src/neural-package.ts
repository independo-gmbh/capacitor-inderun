/**
 * The neural voice's model package and the file download that puts it on the device.
 *
 * The plugin downloads nothing (ADR 019): the app fetches the files, then describes them with a
 * `ModelPackage`. The catalog entry in `neural-catalog.json` is the `articulino-de-en-int8` entry
 * of the upstream `neural-model-catalog.json`, reduced to the fields this app needs, and
 * `catalogEntryToModelPackage` follows the mapping upstream pins in `catalog-to-package.json`
 * (`app_managed` source, `integrity.checksums` keyed by file path, voices carrying their file path).
 *
 * Where the files go. `source.sourceType = "app_managed"` is resolved by the engine, not by
 * this app: Application Support on iOS (`ModelPackageDirectory.swift`), `context.filesDir` on
 * Android (`OnnxModelDirectory.kt`). `@capacitor/filesystem` has no Application Support
 * directory, so the app reaches the same place through `Directory.Library`:
 *   - iOS: `Directory.Library` is `NSLibraryDirectory`, and Application Support is its
 *     `Application Support` subfolder, so the path is `Application Support/<ref>/<file>`.
 *   - Android: `Directory.Library` (like `Directory.Data`) is `context.filesDir`, so the path is
 *     `<ref>/<file>`.
 */
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { ModelPackage } from "@independo/capacitor-inderun";
import catalog from "./neural-catalog.json";

export type CatalogEntry = typeof catalog;

export const ENTRY: CatalogEntry = catalog;
/** The install ref upstream's Voices lab uses: `voices-lab/<id>/<version>`. */
export const PACKAGE_REF = `voices-lab/${ENTRY.id}/${ENTRY.version}`;
export const PROFILE_NAME = `voices-lab:${ENTRY.id}`;

interface CatalogFile {
  path: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** Every file the package needs: the model files and each voice bundle. */
export function catalogFiles(entry: CatalogEntry = ENTRY): CatalogFile[] {
  return [...entry.files, ...entry.voices.map((voice) => voice.file)];
}

export function totalBytes(entry: CatalogEntry = ENTRY): number {
  return catalogFiles(entry).reduce((sum, file) => sum + file.bytes, 0);
}

export function catalogEntryToModelPackage(
  entry: CatalogEntry = ENTRY,
  ref: string = PACKAGE_REF
): ModelPackage {
  const checksums: Record<string, string> = {};
  for (const file of catalogFiles(entry)) {
    checksums[file.path] = `sha256:${file.sha256}`;
  }
  return {
    id: entry.id,
    version: entry.version,
    format: entry.format as ModelPackage["format"],
    variant: entry.variant,
    tasks: ["text_to_speech"],
    license: entry.license,
    source: { sourceType: "app_managed", ref },
    speech: {
      ...entry.speech,
      voices: entry.voices.map((voice) => ({
        id: voice.id,
        name: voice.name,
        locales: voice.locales,
        gender: voice.gender as "male" | "female" | "neutral",
        file: voice.file.path,
        license: voice.license
      }))
    },
    integrity: { checksums }
  } as unknown as ModelPackage;
}

// ---------------------------------------------------------------- download

/** Path inside `Directory.Library` that the engine's `app_managed` source resolves to. */
function devicePath(file: string, ref: string = PACKAGE_REF): string {
  const base = Capacitor.getPlatform() === "ios" ? `Application Support/${ref}` : ref;
  return `${base}/${file}`;
}

async function sizeOnDevice(path: string): Promise<number> {
  try {
    return (await Filesystem.stat({ path, directory: Directory.Library })).size;
  } catch {
    return -1;
  }
}

export interface DownloadProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  /** Bytes of all files done so far, including files that were already complete. */
  doneBytes: number;
  totalBytes: number;
  skipped: boolean;
}

/**
 * Downloads every missing file into the app-managed directory. A file whose size already matches
 * is skipped, so an interrupted download resumes at file granularity. Checksums are not checked
 * here: the provider verifies them at `prepare()`, and a mismatch surfaces there.
 */
export async function downloadPackage(
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  const files = catalogFiles();
  const total = totalBytes();
  let done = 0;
  let current = 0;

  const listener = await Filesystem.addListener("progress", (status) => {
    onProgress({
      file: files[current]?.path ?? "",
      fileIndex: current,
      fileCount: files.length,
      doneBytes: done + status.bytes,
      totalBytes: total,
      skipped: false
    });
  });

  try {
    for (const [index, file] of files.entries()) {
      current = index;
      const path = devicePath(file.path);
      const present = (await sizeOnDevice(path)) === file.bytes;
      if (!present) {
        const parent = path.slice(0, path.lastIndexOf("/"));
        // The Android download does not create parent folders, so make them first.
        await Filesystem.mkdir({ path: parent, directory: Directory.Library, recursive: true }).catch(
          () => undefined // already exists
        );
        await Filesystem.downloadFile({
          url: file.url,
          path,
          directory: Directory.Library,
          progress: true
        });
        const written = await sizeOnDevice(path);
        if (written !== file.bytes) {
          throw new Error(`${file.path}: downloaded ${written} bytes, expected ${file.bytes}`);
        }
      }
      done += file.bytes;
      onProgress({
        file: file.path,
        fileIndex: index,
        fileCount: files.length,
        doneBytes: done,
        totalBytes: total,
        skipped: present
      });
    }
  } finally {
    await listener.remove();
  }
}
