#!/usr/bin/env node

// git pre-push hook (installed by husky; see .husky/pre-push).
//
// Pushing a release tag (v<version>) runs the full `npm run release:check`
// first and blocks the push when it fails. The tag must point at the
// checked-out commit and the working tree must be clean, otherwise the
// check would validate something other than what is being released.
// Branch pushes are not gated here; CI runs the same check on every push.
//
// git writes one line per pushed ref to stdin:
//   <local ref> <local sha> <remote ref> <remote sha>
// `git push --no-verify` skips this hook. The release workflow still runs
// release:check on every platform before anything is published.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { readReleaseNotes } from "./release-notes.mjs"

const root = path.resolve(import.meta.dirname, "..")
const DELETED = /^0+$/

/** Release tags being created or moved by this push (deletions excluded). */
export function releaseTagsInPush(stdin) {
  const tags = []
  for (const line of String(stdin ?? "").split(/\r?\n/)) {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/)
    if (!localRef || !localSha || !remoteRef) continue
    if (DELETED.test(localSha)) continue
    const match = remoteRef.match(/^refs\/tags\/(v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)
    if (match) tags.push({ tag: match[1], sha: localSha })
  }
  return tags
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function main() {
  const tags = releaseTagsInPush(fs.readFileSync(0, "utf8"))
  if (tags.length === 0) return 0
  if (tags.length > 1) {
    process.stderr.write(`Push one release tag at a time (got ${tags.map(({ tag }) => tag).join(", ")}).\n`)
    return 1
  }

  const [{ tag, sha }] = tags
  // An annotated tag's ref names the tag object; compare the commit it tags.
  const taggedCommit = git(["rev-parse", `${sha}^{commit}`])
  const head = git(["rev-parse", "HEAD"])
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
  const problems = []
  if (tag !== `v${version}`) problems.push(`${tag} does not match the package version v${version}.`)
  if (taggedCommit !== head) {
    problems.push(`${tag} points at ${taggedCommit.slice(0, 12)}, but HEAD is ${head.slice(0, 12)}. Check out the tagged commit first.`)
  }
  if (!readReleaseNotes(version)) {
    problems.push(`CHANGELOG.md has no "## [${version}]" section; it becomes the release notes.`)
  }
  const dirty = git(["status", "--porcelain"])
  if (dirty) problems.push(`The working tree has uncommitted or untracked files:\n${dirty}`)
  if (problems.length > 0) {
    process.stderr.write(`\nRelease tag push blocked:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`)
    return 1
  }

  process.stdout.write(`\nRunning the release check for ${tag} before pushing it (this takes a while)...\n`)
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "release-check.mjs")], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  })
  if (result.status === 0) return 0
  process.stderr.write(`\nrelease:check failed; ${tag} was not pushed. Fix the failure and push the tag again.\n`)
  return 1
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry
}

if (isEntryPoint()) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
