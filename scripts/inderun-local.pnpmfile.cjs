// Local-artifact mode for npm (CONTRIBUTING.md): builds the bridge against IndeRun npm tarballs
// that are not published yet. Inert unless passed explicitly, because pnpm only loads a
// `.pnpmfile.cjs` at the repo root by default and this file is not one:
//
//   INDERUN_LOCAL_TARBALLS=<dir> pnpm install \
//     --config.pnpmfile=scripts/inderun-local.pnpmfile.cjs --config.lockfile=false
//
// <dir> holds the `pnpm pack` output of the inderun packages below, one tarball each. The hook
// rewrites those dependencies to `file:` tarballs while pnpm reads each manifest, so neither
// package.json nor pnpm-lock.yaml is edited, and `lockfile=false` keeps pnpm from writing the
// local resolution into the lockfile. Only node_modules changes.
const fs = require("node:fs");
const path = require("node:path");

const PACKAGES = [
  "@independo/inderun-contracts",
  "@independo/inderun-route-core-wasm",
  "@independo/inderun-web"
];
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

const dir = process.env.INDERUN_LOCAL_TARBALLS;
if (!dir) {
  throw new Error("inderun-local.pnpmfile.cjs: set INDERUN_LOCAL_TARBALLS to the directory holding the tarballs");
}

// `pnpm pack` names a scoped package's tarball `<scope>-<name>-<version>.tgz`.
const tarballs = new Map(
  PACKAGES.map((name) => {
    const prefix = `${name.slice(1).replace("/", "-")}-`;
    const hits = fs.readdirSync(dir).filter((file) => file.startsWith(prefix) && file.endsWith(".tgz"));
    if (hits.length !== 1) {
      throw new Error(`inderun-local.pnpmfile.cjs: expected one ${prefix}*.tgz in ${dir}, found ${hits.length}`);
    }
    return [name, { file: path.resolve(dir, hits[0]), version: hits[0].slice(prefix.length, -".tgz".length) }];
  })
);

function readPackage(pkg, context) {
  for (const field of FIELDS) {
    for (const [name, tarball] of tarballs) {
      const spec = pkg[field]?.[name];
      if (spec === undefined) continue;
      // The bridge pins these exactly. A tarball of another version would test something other
      // than what the pin will resolve once released, so refuse it rather than swap it in.
      if (pkg.name === "@independo/capacitor-inderun" && spec !== tarball.version) {
        throw new Error(`inderun-local.pnpmfile.cjs: package.json pins ${name}@${spec}, tarball is ${tarball.version}`);
      }
      context.log(`${pkg.name}: ${name}@${spec} -> ${tarball.file}`);
      pkg[field][name] = `file:${tarball.file}`;
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
