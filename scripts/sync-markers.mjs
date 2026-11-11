#!/usr/bin/env node
/**
 * Regenerates the text between every <!-- snippet:... --> and <!-- version:... --> marker pair.
 *
 *   node scripts/sync-markers.mjs --write   rewrite the files
 *   node scripts/sync-markers.mjs --check   fail when any file is out of date (CI)
 *
 * Both modes first fail when versions.json disagrees with the pins in package.json, Package.swift
 * or android/build.gradle.kts. To move IndeRun: edit those pins and versions.json, then --write.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, markdownFiles, renderBlocks, versionDrift } from "./markers.mjs";

const write = process.argv.includes("--write");
if (!write && !process.argv.includes("--check")) {
  console.error("Usage: sync-markers.mjs --write | --check");
  process.exit(2);
}

const drift = versionDrift();
if (drift.length > 0) {
  console.error("versions.json disagrees with the pinned versions:\n  " + drift.join("\n  "));
  console.error("Edit the pins and versions.json together, then run `pnpm sync:markers`.");
  process.exit(1);
}

const stale = [];
for (const file of markdownFiles()) {
  const absolute = path.join(REPO_ROOT, file);
  const text = fs.readFileSync(absolute, "utf8");
  const { output, used } = renderBlocks(text);
  if (used.length === 0 || output === text) continue;
  if (write) {
    fs.writeFileSync(absolute, output);
    console.log(`Updated ${file}`);
  } else {
    stale.push(file);
  }
}

if (stale.length > 0) {
  console.error(`Out of date: ${stale.join(", ")}\nRun \`pnpm sync:markers\` and commit the result.`);
  process.exit(1);
}
if (!write) console.log("Markers are up to date.");
