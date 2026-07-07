// semantic-release configuration for the standalone Capacitor bridge.
//
// This repo publishes a single npm package (@independo/capacitor-inderun) whose
// git tag (vX.Y.Z) doubles as the SwiftPM release consumers resolve by URL. iOS
// ships via the package's Package.swift; Android ships as source in the npm
// tarball's android/ folder — neither needs a separate publish step.
//
// Mirrors the main monorepo policy: stable releases on `main` write CHANGELOG.md
// and commit the version bump; prereleases on `dev` version/tag/publish (under the
// `dev` npm dist-tag) without touching the changelog or committing.
const branch = (process.env.GITHUB_REF_NAME || "").trim();
const isStable = branch === "main";

const plugins = [
  [
    "@semantic-release/commit-analyzer",
    {
      releaseRules: [
        { breaking: true, release: "major" },
        { type: "revert", scope: "*", release: "patch" },
        { type: "docs", scope: "*", release: "patch" },
        { type: "style", scope: "*", release: "patch" },
        { type: "chore", release: "patch" },
        { type: "refactor", scope: "*", release: "patch" },
        { type: "test", scope: "*", release: "patch" },
        { type: "build", scope: "*", release: "patch" },
        { type: "ci", scope: "*", release: "patch" },
        { type: "improvement", scope: "*", release: "patch" },
        { type: "perf", scope: "*", release: "patch" },
        { type: "feat", release: "minor" },
        { type: "fix", release: "patch" }
      ],
      parserOpts: {
        noteKeywords: ["BREAKING CHANGE", "BREAKING CHANGES"]
      }
    }
  ],
  [
    "@semantic-release/release-notes-generator",
    {
      preset: "conventionalcommits",
      presetConfig: {
        types: [
          { type: "feat", section: "Features 🚀", hidden: false },
          { type: "fix", section: "Bug Fixes 🛠️", hidden: false },
          { type: "perf", section: "Performance Improvements 💪", hidden: false },
          { type: "improvement", section: "Improvements 🛠️", hidden: false },
          { type: "revert", section: "Reverts 🔙", hidden: false },
          { type: "docs", section: "Documentation 📚", hidden: false },
          { type: "style", section: "Styles 💅", hidden: false },
          { type: "chore", section: "Miscellaneous Chores 🛠️", hidden: false },
          { type: "wip", section: "Work In Progress 🛠️", hidden: true },
          { type: "refactor", section: "Code Refactors 🏗️", hidden: false },
          { type: "test", section: "Tests 🛠️", hidden: false },
          { type: "build", section: "Build System 🛠️", hidden: false },
          { type: "ci", section: "CI/CD 👷", hidden: false }
        ]
      }
    }
  ]
];

// CHANGELOG.md is only maintained for stable releases (main), not prereleases (dev).
if (isStable) {
  plugins.push("@semantic-release/changelog");
}

// Build before publish; publish the single root package with npm (OIDC Trusted
// Publishing + provenance) — no workspace rewriting needed here.
plugins.push([
  "@semantic-release/npm",
  {
    npmPublish: true,
    tarballDir: "dist-tarball"
  }
]);

// Commit the version bump + changelog only for stable releases. On prereleases the
// version is still applied (working tree) and published, but nothing is committed.
if (isStable) {
  plugins.push([
    "@semantic-release/git",
    {
      assets: ["CHANGELOG.md", "package.json"],
      message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
    }
  ]);
}

plugins.push(["@semantic-release/github", { successComment: false, failTitle: false }]);
plugins.push([
  "@saithodev/semantic-release-backmerge",
  { backmergeBranches: [{ from: "main", to: "dev" }] }
]);

module.exports = {
  branches: [
    { name: "main", prerelease: false },
    { name: "dev", prerelease: true }
  ],
  plugins
};
