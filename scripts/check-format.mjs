#!/usr/bin/env node

// Prettier gate for the files a change touches.
//
// Most of the tree predates enforced formatting, so `prettier --check .`
// would fail on files nobody touched. Reformatting all of them at once would
// bury `git blame` and conflict with every open pull request. Instead this
// checks every TS/TSX file that differs from the base revision, including
// uncommitted and untracked files. A file is reformatted the first time
// someone edits it, and the unformatted remainder only shrinks.
//
// Base revision, first match wins:
//   1. FORMAT_BASE (CI sets it to the pull request base or the previous push)
//   2. the merge-base of HEAD and origin/main, when HEAD is not already on it
//
// On main itself with no FORMAT_BASE there is nothing to compare, and the
// check passes with a note: a tag build releases a commit that CI already
// checked when it landed.
//
// `--write` formats the same file set instead of checking it.

import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, "..")

// Matches the `format` script. Widen both together.
export const FORMATTED_EXTENSIONS = [".ts", ".tsx"]
// Windows caps a command line at 32,767 characters.
const FILES_PER_PRETTIER_RUN = 80
const NULL_COMMIT = /^0+$/

export function selectFormattableFiles(paths) {
  const unique = new Set()
  for (const raw of paths) {
    const file = raw.trim().replaceAll("\\", "/")
    if (!file) continue
    if (!FORMATTED_EXTENSIONS.some((extension) => file.endsWith(extension))) {
      continue
    }
    unique.add(file)
  }
  return [...unique].sort()
}

export function chunk(items, size) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError("chunk size must be a positive integer")
  }
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

export function normalizeBase(value) {
  const base = String(value ?? "").trim()
  if (!base || NULL_COMMIT.test(base)) return null
  return base
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.error) {
    throw new Error(`git is required for the format check: ${result.error.message}`)
  }
  if (result.status !== 0) {
    if (allowFailure) return null
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr.trim()}`)
  }
  return result.stdout
}

function resolveBase(env = process.env) {
  const explicit = normalizeBase(env.FORMAT_BASE)
  if (explicit) {
    const commit = git(["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`], {
      allowFailure: true,
    })
    if (!commit) {
      throw new Error(
        `FORMAT_BASE=${explicit} is not a commit in this clone. Fetch it (or the full history) before running the format check.`
      )
    }
    return { base: commit.trim(), reason: `FORMAT_BASE=${explicit}` }
  }

  const upstream = ["origin/main", "main"].find((ref) =>
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true })
  )
  if (!upstream) {
    throw new Error(
      "Cannot find origin/main or main to compare against. Set FORMAT_BASE=<commit> to choose the base revision."
    )
  }
  const mergeBase = git(["merge-base", "HEAD", upstream], { allowFailure: true })?.trim()
  if (!mergeBase) {
    throw new Error(
      `HEAD shares no history with ${upstream}. Set FORMAT_BASE=<commit> to choose the base revision.`
    )
  }
  return { base: mergeBase, reason: `merge-base with ${upstream}` }
}

function changedFiles(base) {
  // Two-dot diff against the working tree: committed, staged and unstaged
  // edits since the base. Deleted files are excluded (--diff-filter).
  const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", base, "--"])
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
  return selectFormattableFiles(`${tracked}\n${untracked}`.split("\n"))
}

function runPrettier(mode, files) {
  const prettier = require.resolve("prettier/bin/prettier.cjs", { paths: [root] })
  let status = 0
  for (const batch of chunk(files, FILES_PER_PRETTIER_RUN)) {
    const result = spawnSync(process.execPath, [prettier, mode, ...batch], {
      cwd: root,
      stdio: "inherit",
    })
    if (result.error) throw result.error
    if (result.status !== 0) status = result.status ?? 1
  }
  return status
}

function main({ write = false } = {}) {
  const { base, reason } = resolveBase()
  const files = changedFiles(base)
  const since = `${base.slice(0, 12)} [${reason}]`

  if (files.length === 0) {
    const head = git(["rev-parse", "HEAD"]).trim()
    const note = base === head ? " (HEAD is the base revision)" : ""
    process.stdout.write(
      `Format check: no changed ${FORMATTED_EXTENSIONS.join("/")} files since ${since}${note}.\n`
    )
    return 0
  }

  process.stdout.write(`Format check: ${files.length} changed file(s) since ${since}.\n`)
  if (write) return runPrettier("--write", files)
  if (runPrettier("--check", files) === 0) return 0
  process.stderr.write(
    "\nFormat check failed. Run `npm run format:changed` to format the changed files, review the result, and commit it.\n"
  )
  return 1
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32"
    ? self.toLowerCase() === entry.toLowerCase()
    : self === entry
}

if (isEntryPoint()) {
  try {
    process.exitCode = main({ write: process.argv.includes("--write") })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
