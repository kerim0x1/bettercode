#!/usr/bin/env node

// Sends the iOS app of a release to TestFlight through EAS, Expo's build
// service. The release workflow runs it after the release is published.
//
//   node scripts/eas-ios-release.mjs <tag>
//
// It starts at most one build per commit: a build of this commit that is
// queued, running or finished is left alone (EAS submits it when it
// finishes), so re-running the job does not spend another build of the
// monthly quota. Otherwise it starts `eas build --platform ios --profile
// production --auto-submit` with the phone app's release notes as
// TestFlight's "What to Test", and returns without waiting: EAS builds and
// submits on its own schedule.
//
// It checks first that everything a build needs is configured: EXPO_TOKEN,
// the EAS project (extra.eas.projectId from apps/mobile/app.config.ts) and
// the App Store Connect app (submit.production.ios.ascAppId in eas.json).
// See docs/release-checklist.md.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { readReleaseNotes } from "./release-notes.mjs"

const root = path.resolve(import.meta.dirname, "..")
const mobileRoot = path.join(root, "apps", "mobile")
/** The EAS CLI, pinned: eas.json requires at least 24.3.0. */
export const EAS_CLI = "eas-cli@24.7.0"
/** TestFlight's limit for "What to Test". */
export const WHAT_TO_TEST_LIMIT = 4000
const RELEASES_URL = "https://github.com/kerim0x1/bettercode/releases/tag"

/** What keeps EAS from building and submitting, from the configuration files and the environment. */
export function configurationProblems({ appConfigSource, easJson, env }) {
  const problems = []
  if (!env.EXPO_TOKEN?.trim()) problems.push("EXPO_TOKEN is not set (a secret of the `release` environment)")
  const published = /const PUBLISHED_EAS_PROJECT_ID: string \| null =\s*"([0-9a-f-]{36})"/.exec(appConfigSource)
  if (!published && !env.BETTERC0DE_EAS_PROJECT_ID?.trim()) {
    problems.push("no EAS project: run `eas init` in apps/mobile and put its projectId in app.config.ts")
  }
  if (!/^\d+$/.test(String(easJson?.submit?.production?.ios?.ascAppId ?? ""))) {
    problems.push("no App Store Connect app: set submit.production.ios.ascAppId in apps/mobile/eas.json")
  }
  return problems
}

const ACTIVE = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL"])

/** What to do, given the EAS builds of this commit (`eas build:list --json`). */
export function planTestFlight(builds, commit) {
  const ofCommit = builds.filter((build) => build.gitCommitHash === commit)
  const status = (build) => String(build.status ?? "").toUpperCase()
  const active = ofCommit.find((build) => ACTIVE.has(status(build)))
  if (active) return { action: "running", build: active }
  const finished = ofCommit.find((build) => status(build) === "FINISHED")
  if (finished) return { action: "done", build: finished }
  return { action: "build" }
}

/** Markdown to the plain text TestFlight shows. */
function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{2,}\s*(.+)$/gm, "$1:")
}

/**
 * The release notes for testers: the changelog entries about the phone
 * app, plus where the full notes are. A release without such entries
 * still ships a build, which says so.
 */
export function whatToTest(tag, notes) {
  const bullets = String(notes ?? "")
    .split(/\n(?=- )/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("- ") && /phone app|BetterC0de Remote/i.test(entry))
  const header = `BetterC0de Remote for BetterC0de ${tag}.`
  const footer = `All changes: ${RELEASES_URL}/${tag}`
  const body = bullets.length > 0 ? plainText(bullets.join("\n")) : "No changes to the app itself; it matches the new desktop release."
  const room = WHAT_TO_TEST_LIMIT - header.length - footer.length - 4
  const clipped = body.length > room ? `${body.slice(0, room - 1).trimEnd()}…` : body
  return `${header}\n\n${clipped}\n\n${footer}`
}

/** npx's script next to this Node, so arguments reach EAS without a shell. */
function npxCli() {
  const nodeDir = path.dirname(process.execPath)
  return [
    path.join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ].find((candidate) => fs.existsSync(candidate))
}

/** Runs the pinned EAS CLI in apps/mobile and returns its JSON output. */
function eas(args) {
  const cli = npxCli()
  if (!cli) throw new Error("npx was not found next to this Node.")
  const result = spawnSync(process.execPath, [cli, "--yes", EAS_CLI, ...args], {
    cwd: mobileRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`eas ${args[0]} failed:\n${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout)
}

export async function main([tag] = process.argv.slice(2), env = process.env) {
  if (!tag) throw new Error("Usage: node scripts/eas-ios-release.mjs <tag>")
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
  if (tag !== `v${version}`) throw new Error(`The tag ${tag} does not match the version ${version}.`)
  const problems = configurationProblems({
    appConfigSource: fs.readFileSync(path.join(mobileRoot, "app.config.ts"), "utf8"),
    easJson: JSON.parse(fs.readFileSync(path.join(mobileRoot, "eas.json"), "utf8")),
    env,
  })
  if (problems.length > 0) {
    throw new Error(`EAS is not set up for TestFlight builds:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
  }
  const commit = env.GITHUB_SHA?.trim() || spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
  const builds = eas(["build:list", "--platform", "ios", "--git-commit-hash", commit, "--json", "--non-interactive"])
  const plan = planTestFlight(builds, commit)
  if (plan.action === "running") {
    process.stdout.write(`EAS is already building ${commit} (${plan.build.id}); it submits the build when it finishes.\n`)
    return
  }
  if (plan.action === "done") {
    process.stdout.write(`EAS built ${commit} before (${plan.build.id}) and submitted it; nothing to do.\n`)
    return
  }
  const started = eas([
    "build",
    "--platform",
    "ios",
    "--profile",
    "production",
    "--non-interactive",
    "--freeze-credentials",
    "--auto-submit",
    "--what-to-test",
    whatToTest(tag, readReleaseNotes(version)),
    "--message",
    `BetterC0de ${tag}`,
    "--no-wait",
    "--json",
  ])
  for (const build of [started].flat()) {
    process.stdout.write(`Started EAS build ${build.id}${build.buildDetailsPageUrl ? ` (${build.buildDetailsPageUrl})` : ""}.\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
}
