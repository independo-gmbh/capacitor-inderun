/**
 * Shared logic for the two marker kinds (ADR 024) that keep copies of code and version facts in
 * the README in sync:
 *
 *   <!-- snippet:NAME -->      filled from snippets/NAME.ts, which `check-snippets.mjs` type-checks
 *   <!-- /snippet -->
 *
 *   <!-- version:NAME -->      rendered from versions.json by VERSION_BLOCKS[NAME]
 *   <!-- /version -->
 *
 * Both render on GitHub and npm (the comments are invisible). Only the text between the markers
 * is generated; everything around it is hand-written.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNIPPETS_DIR = path.join(REPO_ROOT, "snippets");
export const PENDING_MARKER = "TODO(verify)";

const BLOCK = /(<!-- (snippet|version):([a-z0-9-]+) -->)([\s\S]*?)(<!-- \/\2 -->)/g;

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8");

export function readVersions() {
  return JSON.parse(read("versions.json"));
}

/** Every Markdown file in the repository, outside node_modules. */
export function markdownFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  })
    .split("\n")
    .filter(
      (file) => file && !file.includes("node_modules/") && fs.existsSync(path.join(REPO_ROOT, file))
    );
}

export function snippetPath(name) {
  return path.join(SNIPPETS_DIR, `${name}.ts`);
}

export function readSnippet(name) {
  const file = snippetPath(name);
  if (!fs.existsSync(file))
    throw new Error(`Unknown snippet "${name}" (expected ${path.relative(REPO_ROOT, file)})`);
  return fs.readFileSync(file, "utf8");
}

const fence = (lang, body) =>
  `\n\`\`\`${lang}\n${body.endsWith("\n") ? body : `${body}\n`}\`\`\`\n`;

/** Version blocks: each returns the Markdown that goes between its markers, newlines included. */
export const VERSION_BLOCKS = {
  install: (v) => fence("sh", `pnpm add @independo/capacitor-inderun @capacitor/core@${v.capacitor}`),
  // Inline: sits inside a sentence, so it carries no newlines.
  "inderun-version": (v) => `**IndeRun ${v.inderun}**`,
  "supported-table": (v) =>
    "\n| Platform | Artifact | Constraint |\n|----------|----------|------------|\n" +
    `| Web      | \`@independo/inderun-web\`, \`@independo/inderun-contracts\` | \`${v.inderun}\` (exact) |\n` +
    `| iOS      | \`inderun\` SwiftPM package | \`${v.inderun}\` (exact) |\n` +
    `| Android  | \`app.independo.inderun:inderun-*\` | \`${v.inderun}\` (exact) |\n`,
  // Inline, inside a table cell.
  "kotlin-plugin": (v) => `\`org.jetbrains.kotlin:kotlin-gradle-plugin:${v.kotlinGradlePlugin}\``,
  "kotlin-plugin-gradle": (v) =>
    fence(
      "groovy",
      `// android/build.gradle\nbuildscript {\n    dependencies {\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${v.kotlinGradlePlugin}'\n    }\n}`
    )
};

/** Renders every block in `text`. Returns the new text and the blocks it touched. */
export function renderBlocks(text, versions = readVersions()) {
  const used = [];
  const output = text.replace(BLOCK, (_match, open, kind, name, _body, close) => {
    used.push({ kind, name });
    if (kind === "snippet") return `${open}${fence("ts", readSnippet(name))}${close}`;
    const block = VERSION_BLOCKS[name];
    if (!block) throw new Error(`Unknown version block "${name}"`);
    return `${open}${block(versions)}${close}`;
  });
  return { output, used };
}

export function isPending(name) {
  return readSnippet(name).includes(PENDING_MARKER);
}

/**
 * versions.json is the one place a version is written by hand besides the manifests that have to
 * carry it. This returns one message per manifest that disagrees, so a partial bump cannot ship.
 */
export function versionDrift(v = readVersions()) {
  const problems = [];
  const expect = (where, actual, wanted) => {
    if (actual !== wanted)
      problems.push(`${where}: found ${JSON.stringify(actual)}, versions.json says ${JSON.stringify(wanted)}`);
  };

  const pkg = JSON.parse(read("package.json"));
  expect("package.json dependencies[@independo/inderun-web]", pkg.dependencies?.["@independo/inderun-web"], v.inderun);
  expect("package.json dependencies[@independo/inderun-contracts]", pkg.dependencies?.["@independo/inderun-contracts"], v.inderun);
  expect("package.json peerDependencies[@capacitor/core]", pkg.peerDependencies?.["@capacitor/core"], `^${v.capacitor}.0.0`);

  const swift = read("Package.swift").match(/inderun\.git",\s*(?:exact:|from:|\.upToNextMinor\(from:)\s*"([^"]+)"/);
  expect("Package.swift inderun pin", swift?.[1], v.inderun);

  const gradle = read("android/build.gradle.kts");
  const artifacts = [...gradle.matchAll(/"app\.independo\.inderun:[a-z-]+:([^"]+)"/g)];
  if (artifacts.length === 0) problems.push("android/build.gradle.kts: no inderun artifacts found");
  for (const artifact of artifacts) expect(`android/build.gradle.kts ${artifact[0]}`, artifact[1], v.inderun);
  const kgp = gradle.match(/kotlin-gradle-plugin:([^"]+)"/);
  expect("android/build.gradle.kts kotlin-gradle-plugin", kgp?.[1], v.kotlinGradlePlugin);
  const cap = gradle.match(/"com\.capacitorjs:core:(\d+)\./);
  expect("android/build.gradle.kts com.capacitorjs:core major", cap?.[1], v.capacitor);

  return problems;
}
