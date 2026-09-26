import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import YAML from "yaml"
import mobileVersion from "../apps/mobile/config/version.cjs"
import {
  MANIFEST_PATHS,
  latestReleaseTag,
  nextAutoReleaseVersion,
  notesSincePreviousRelease,
  planAutomaticRelease,
  stageReleaseChangelog,
} from "./prepare-automatic-release.mjs"

function fixture(version = "0.1.0-beta.3") {
  const manifests = Object.fromEntries(
    MANIFEST_PATHS.map((manifestPath) => [
      manifestPath,
      { name: manifestPath, version },
    ])
  )
  const packages = Object.fromEntries(
    MANIFEST_PATHS.map((manifestPath) => [
      manifestPath === "package.json"
        ? ""
        : manifestPath.slice(0, -"/package.json".length),
      { version },
    ])
  )
  return {
    manifests,
    lock: {
      name: "betterc0de",
      version,
      packages: {
        ...packages,
        "node_modules/example": { version: "3.2.1" },
      },
    },
    changelog:
      "# Changelog\n\n" +
      "## [Unreleased]\n\n" +
      "### Fixed\n\n- Cursor remains available after slow startup.\n\n" +
      "## [0.1.0-beta.3] - 2026-09-25\n\n- Previous release.\n",
    existingTags: ["v0.1.0-beta.2", "v0.1.0-beta.3"],
    date: "2026-09-26",
  }
}

test("the next beta advances the mobile update version and rolls over at 99", () => {
  assert.equal(nextAutoReleaseVersion("0.1.0-beta.3"), "0.1.0-beta.4")
  assert.equal(nextAutoReleaseVersion("0.1.0-beta.99"), "0.1.1-beta.0")
  assert.equal(nextAutoReleaseVersion("0.1.99-beta.99"), "0.2.0-beta.0")
  assert.equal(nextAutoReleaseVersion("0.1.0"), "0.1.1")
  assert.ok(
    mobileVersion.androidVersionCode("0.1.1-beta.0") >
      mobileVersion.androidVersionCode("0.1.0-beta.99")
  )
})

test("a tagged version becomes a new versioned commit with release notes", () => {
  const input = fixture()
  const plan = planAutomaticRelease(input)

  assert.equal(plan.tag, "v0.1.0-beta.4")
  assert.equal(plan.version, "0.1.0-beta.4")
  for (const manifestPath of MANIFEST_PATHS) {
    assert.equal(plan.manifests[manifestPath].version, plan.version)
    const lockKey =
      manifestPath === "package.json"
        ? ""
        : manifestPath.slice(0, -"/package.json".length)
    assert.equal(plan.lock.packages[lockKey].version, plan.version)
  }
  assert.equal(plan.lock.version, plan.version)
  assert.equal(plan.lock.packages["node_modules/example"].version, "3.2.1")
  assert.match(
    plan.changelog,
    /## \[Unreleased\]\n\n## \[0\.1\.0-beta\.4\] - 2026-09-26/
  )
  assert.match(plan.changelog, /Cursor remains available after slow startup/)
  assert.match(plan.changelog, /## \[0\.1\.0-beta\.3\]/)
  assert.doesNotMatch(
    plan.changelog.split("## [0.1.0-beta.4]")[0],
    /Cursor remains available/
  )
})

test("an already bumped but untagged version is released without another bump", () => {
  const input = fixture("0.1.0-beta.4")
  input.existingTags = ["v0.1.0-beta.3"]
  input.changelog =
    "# Changelog\n\n" +
    "## [Unreleased]\n\n- A later fix.\n\n" +
    "## [0.1.0-beta.4] - 2026-09-26\n\n- Planned update.\n\n" +
    "## [0.1.0-beta.3] - 2026-09-25\n\n- Previous release.\n"

  const plan = planAutomaticRelease(input)
  assert.equal(plan.tag, "v0.1.0-beta.4")
  assert.match(
    plan.changelog,
    /## \[0\.1\.0-beta\.4\] - 2026-09-26\n\n- A later fix\.\n\n- Planned update\./
  )
})

test("a later merge advances the latest tag even when main keeps its old version", () => {
  const input = fixture()
  input.existingTags.push("v0.1.0-beta.4")
  input.previousNotes =
    "### Fixed\n\n- Cursor remains available after slow startup."
  input.previousChangelog =
    "# Changelog\n\n" +
    "## [Unreleased]\n\n" +
    "## [0.1.0-beta.4] - 2026-09-26\n\n" +
    input.previousNotes +
    "\n\n## [0.1.0-beta.3] - 2026-09-25\n\n- Previous release.\n"
  input.changelog = input.changelog.replace(
    "- Cursor remains available after slow startup.",
    "- Cursor remains available after slow startup.\n\n" +
      "### Added\n\n- A new provider option."
  )

  const plan = planAutomaticRelease(input)
  assert.equal(plan.tag, "v0.1.0-beta.5")
  assert.match(plan.changelog, /- A new provider option\./)
  assert.match(plan.changelog, /## \[0\.1\.0-beta\.4\] - 2026-09-26/)
  assert.doesNotMatch(
    plan.changelog.split("## [0.1.0-beta.4]")[0],
    /Cursor remains available after slow startup/
  )
  assert.equal(
    latestReleaseTag(["v0.1.0-beta.9", "v0.1.0-beta.10"]),
    "v0.1.0-beta.10"
  )
  assert.equal(
    notesSincePreviousRelease(
      "### Fixed\n\n- Earlier fix.\n\n- Later fix.",
      "### Fixed\n\n- Earlier fix."
    ),
    "### Fixed\n\n- Later fix."
  )
})

test("release notes do not repeat entries from older automatic releases", () => {
  const input = fixture()
  input.existingTags.push("v0.1.0-beta.4", "v0.1.0-beta.5")
  input.changelog = input.changelog.replace(
    "- Cursor remains available after slow startup.",
    "- Cursor remains available after slow startup.\n\n" +
      "- A second release change.\n\n" +
      "- A new change."
  )
  input.previousChangelog =
    "# Changelog\n\n## [Unreleased]\n\n" +
    "## [0.1.0-beta.5] - 2026-09-27\n\n### Fixed\n\n" +
    "- A second release change.\n\n" +
    "## [0.1.0-beta.4] - 2026-09-26\n\n### Fixed\n\n" +
    "- Cursor remains available after slow startup.\n\n" +
    "## [0.1.0-beta.3] - 2026-09-25\n\n- Previous release.\n"

  const plan = planAutomaticRelease(input)
  assert.equal(plan.tag, "v0.1.0-beta.6")
  const newest = plan.changelog.split("## [0.1.0-beta.5]")[0]
  assert.match(newest, /- A new change\./)
  assert.doesNotMatch(newest, /A second release change/)
  assert.doesNotMatch(newest, /Cursor remains available/)
  assert.match(plan.changelog, /## \[0\.1\.0-beta\.4\]/)
})

test("a merge without changelog entries receives honest maintenance notes", () => {
  const input = fixture()
  input.changelog =
    "# Changelog\n\n## [Unreleased]\n\n## [0.1.0-beta.3] - 2026-09-25\n\n- Previous release.\n"
  const plan = planAutomaticRelease(input)
  assert.match(plan.changelog, /Maintenance changes merged into main/)
})

test("inconsistent workspace versions stop before files are written", () => {
  const mismatch = fixture()
  mismatch.lock.packages["apps/mobile"].version = "0.1.0-beta.2"
  assert.throws(
    () => planAutomaticRelease(mismatch),
    /package-lock.json entry apps\/mobile has another version/
  )
})

test("changelog preparation retains CRLF and refuses missing Unreleased headings", () => {
  const input = fixture()
  const crlf = input.changelog.replaceAll("\n", "\r\n")
  const result = stageReleaseChangelog(crlf, "0.1.0-beta.4", "2026-09-26")
  assert.ok(result.includes("## [Unreleased]\r\n\r\n## [0.1.0-beta.4]"))
  assert.throws(
    () => stageReleaseChangelog("# Changelog\n", "0.1.0-beta.4", "2026-09-26"),
    /exactly one Unreleased heading/
  )
})

test("automatic publishing waits for a successful push CI on this repository's main", () => {
  const workflowPath = path.resolve(
    import.meta.dirname,
    "../.github/workflows/automatic-release.yml"
  )
  const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8"))
  assert.deepEqual(workflow.on.workflow_run.workflows, ["CI"])
  assert.deepEqual(workflow.on.workflow_run.types, ["completed"])
  assert.match(
    workflow.jobs.prepare.if,
    /workflow_run\.conclusion == 'success'/
  )
  assert.match(workflow.jobs.prepare.if, /workflow_run\.event == 'push'/)
  assert.match(workflow.jobs.prepare.if, /workflow_run\.head_branch == 'main'/)
  assert.match(
    workflow.jobs.prepare.if,
    /head_repository\.full_name == github\.repository/
  )
  assert.equal(workflow.permissions.contents, "write")
  assert.equal(workflow.permissions.actions, "write")
})

test("the checked-out repository can prepare release files without writing them", () => {
  const root = path.resolve(import.meta.dirname, "..")
  const manifests = Object.fromEntries(
    MANIFEST_PATHS.map((manifestPath) => [
      manifestPath,
      JSON.parse(fs.readFileSync(path.join(root, manifestPath), "utf8")),
    ])
  )
  const existingTags = execFileSync("git", ["tag", "--list", "v*"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const latestTag = latestReleaseTag(existingTags)
  const previousChangelog = latestTag
    ? execFileSync("git", ["show", latestTag + ":CHANGELOG.md"], {
        cwd: root,
        encoding: "utf8",
      })
    : null
  const plan = planAutomaticRelease({
    manifests,
    lock: JSON.parse(
      fs.readFileSync(path.join(root, "package-lock.json"), "utf8")
    ),
    changelog: fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
    existingTags,
    previousChangelog,
    date: "2026-09-26",
  })
  assert.ok(plan.tag.startsWith("v"))
  assert.ok(plan.changelog.includes("## [" + plan.version + "]"))
  assert.equal(plan.lock.version, plan.version)
})
