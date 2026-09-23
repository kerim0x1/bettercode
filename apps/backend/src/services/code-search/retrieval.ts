import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import ignore from "ignore"
import {
  readWorkspaceFile,
  resolveWorkspaceOperationPath,
} from "../workspace/files"
import { translateNestedGitignore } from "../workspace/search"
import type { CodeCandidate, SearchCoverage } from "./contracts"
import { SEARCH_LIMITS } from "./limits"
import {
  analyzeCandidate,
  pathRelevance,
  searchTerms,
  selectCandidates,
} from "./candidate-ranking"

const SOURCE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|c|cpp|h|hpp|rb|php|swift|kt|scala|vue|svelte|css|scss|html|sql|sh|ps1|lua|json|ya?ml|toml|md)$/i
const EXCLUDED = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".venv/",
  "venv/",
  "vendor/",
  ".cache/",
  ".betterc0de/",
  ".codex/",
  ".claude/",
  ".kilo/",
  ".worktrees/",
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.lock",
  "*-lock.json",
  "*.min.js",
  "*.map",
  "credentials*",
  "secrets*",
  ".ssh/",
]

export const SEARCH_SCOPE =
  "Bounded disk snapshot; gitignored, dependency/build, credential-named, shadow and nested Git working trees are excluded. The selected root remains eligible even when itself a worktree. Content search skips binary data and deduplicates identical file bytes. No symbol graph or semantic index; unsaved editor buffers are not searched."

/** Discover paths first, then read with bounded parallelism. No persistent cache. */
export async function collectWorkspaceData(input: {
  readonly root: string
  readonly signal: AbortSignal
  readonly pathPrefixes?: readonly string[]
  readonly search?: {
    readonly query: string
    readonly keywords?: readonly string[]
  }
}): Promise<{
  files: string[]
  candidates: CodeCandidate[]
  lexicalMatchCount: number
  uniqueMatchCount: number
  coverage: SearchCoverage
}> {
  const matcher = ignore()
  const hardExcludes = ignore().add(EXCLUDED)
  const coverage: SearchCoverage = {
    visitedEntries: 0,
    readBytes: 0,
    skippedFiles: 0,
    eligibleFiles: 0,
    scannedFiles: 0,
    duplicateFiles: 0,
    excludedWorktrees: 0,
    incomplete: false,
    reasons: [],
  }
  const files: string[] = []
  const deadline = performance.now() + SEARCH_LIMITS.retrievalMs
  const terms = input.search
    ? searchTerms(input.search.query, input.search.keywords)
    : []
  const prefixes = input.pathPrefixes?.map((prefix) =>
    prefix === "." ? "" : prefix.replace(/^(?:\.\/)+/, "")
  ) ?? [""]

  function mark(reason: SearchCoverage["reasons"][number]) {
    coverage.incomplete = true
    if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason)
  }
  function stopped(): boolean {
    input.signal.throwIfAborted()
    if (performance.now() >= deadline) {
      mark("deadline")
      return true
    }
    return false
  }
  const inScope = (name: string, directory: boolean) =>
    prefixes.some(
      (prefix) =>
        name.startsWith(prefix) || (directory && prefix.startsWith(name + "/"))
    )

  async function walk(relative: string, depth: number): Promise<void> {
    if (stopped()) return
    if (depth > 20) {
      mark("depth")
      return
    }
    const directory = await resolveWorkspaceOperationPath(
      input.root,
      relative || "."
    )
    if (directory.root !== input.root) throw new Error("Workspace root changed")
    if (relative) {
      try {
        await fs.lstat(path.join(directory.target, ".git"))
        coverage.excludedWorktrees++
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          mark("unreadable")
          return
        }
      }
    }
    try {
      const remaining = Math.min(
        64 * 1024,
        SEARCH_LIMITS.readBytes - coverage.readBytes
      )
      const rules = await readWorkspaceFile(
        input.root,
        path.posix.join(relative, ".gitignore"),
        remaining,
        { expectedCanonicalRoot: input.root }
      )
      coverage.readBytes += rules.content.length
      matcher.add(
        relative
          ? translateNestedGitignore(relative, rules.content.toString("utf8"))
          : rules.content.toString("utf8")
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        mark("unreadable")
        return
      }
    }
    const dir = await fs.opendir(directory.target)
    for await (const entry of dir) {
      if (stopped()) return
      if (coverage.visitedEntries >= SEARCH_LIMITS.entries) {
        mark("entries")
        return
      }
      coverage.visitedEntries++
      const name = relative ? relative + "/" + entry.name : entry.name
      const isDirectory = entry.isDirectory()
      if (!inScope(name, isDirectory)) continue
      const matchName = isDirectory ? name + "/" : name
      if (hardExcludes.ignores(matchName) || matcher.ignores(matchName))
        continue
      if (isDirectory) {
        try {
          await walk(name, depth + 1)
        } catch {
          input.signal.throwIfAborted()
          mark("unreadable")
        }
      } else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) {
        files.push(name)
      }
    }
  }
  await walk("", 0)
  coverage.eligibleFiles = files.length
  files.sort(
    (a, b) =>
      pathRelevance(b, terms) - pathRelevance(a, terms) || a.localeCompare(b)
  )

  const validFiles: string[] = []
  const features: NonNullable<ReturnType<typeof analyzeCandidate>>[] = []
  let nextFile = 0
  let reservedBytes = coverage.readBytes
  async function readWorker() {
    while (nextFile < files.length && !stopped()) {
      const name = files[nextFile++]!
      try {
        const target = await resolveWorkspaceOperationPath(input.root, name)
        if (target.root !== input.root)
          throw new Error("Workspace root changed")
        const stat = await fs.lstat(target.target)
        if (!stat.isFile()) throw new Error("File changed")
        if (!input.search) {
          validFiles.push(name)
          continue
        }
        if (terms.length === 0) continue
        if (stat.size > SEARCH_LIMITS.fileBytes) {
          coverage.skippedFiles++
          mark("large-file")
          continue
        }
        if (reservedBytes + stat.size > SEARCH_LIMITS.readBytes) {
          coverage.skippedFiles++
          mark("bytes")
          continue
        }
        // Reserve before awaiting: concurrent reads cannot oversubscribe the ceiling.
        reservedBytes += stat.size
        const { content } = await readWorkspaceFile(
          input.root,
          name,
          stat.size,
          { expectedCanonicalRoot: input.root }
        )
        coverage.readBytes += content.length
        reservedBytes -= stat.size - content.length
        coverage.scannedFiles++
        input.signal.throwIfAborted()
        if (content.includes(0)) {
          coverage.skippedFiles++
          continue
        }
        const feature = analyzeCandidate(
          name,
          content.toString("utf8"),
          createHash("sha256").update(content).digest("hex"),
          terms
        )
        if (feature) features.push(feature)
      } catch {
        input.signal.throwIfAborted()
        coverage.skippedFiles++
        mark("unreadable")
      }
    }
  }
  const workers = await Promise.allSettled(
    Array.from({ length: SEARCH_LIMITS.readConcurrency }, () => readWorker())
  )
  input.signal.throwIfAborted()
  for (const worker of workers)
    if (worker.status === "rejected") throw worker.reason
  const selected = selectCandidates(features, terms)
  coverage.duplicateFiles = selected.duplicateFiles
  validFiles.sort()
  return {
    files: validFiles,
    candidates: selected.candidates,
    lexicalMatchCount: features.length,
    uniqueMatchCount: selected.uniqueMatchCount,
    coverage,
  }
}
