import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import {
  workspaceEffectiveRulesResultSchema,
  type WorkspaceEffectiveRuleScope,
  type WorkspaceEffectiveRuleSource,
  type WorkspaceEffectiveRuleSourceKind,
  type WorkspaceEffectiveRulesResult,
} from "@betterc0de/schema"
import type { AppState } from "../appState"
import { logger } from "../observability/logger"
import { compileBoundedGlob } from "./bounded-glob"
import {
  listProjectInstructions,
  type ProjectInstructionTemplate,
} from "./workspace"

const EFFECTIVE_RULES_MARKER = "<!-- betterc0de-effective-rules:v1 -->"
const MAX_RULE_FILE_BYTES = 64 * 1024
const MAX_EFFECTIVE_RULE_BYTES = 96 * 1024
const MAX_EFFECTIVE_RULE_SOURCE_BYTES = 32 * 1024
const MAX_PROVENANCE_RULE_SOURCE_BYTES = 8 * 1024
const MAX_RULE_DIRECTORY_DEPTH = 4
const MAX_TARGET_RULE_FILES = 96
const MAX_SYSTEM_INSTRUCTION_CHARS = 256 * 1024
const TRUNCATION_MARKER = "\n\n...[truncated]"

const PROJECT_RULE_FILES = [
  { relativePath: ".github/copilot-instructions.md", priority: 10 },
  { relativePath: ".cursorrules", priority: 20 },
  { relativePath: "CONTEXT.md", priority: 30 },
  { relativePath: "CLAUDE.md", priority: 40 },
  { relativePath: "AGENTS.md", priority: 50 },
] as const

const DIRECTORY_RULE_FILES = [
  { relativePath: "CONTEXT.md", priority: 30 },
  { relativePath: "CLAUDE.md", priority: 40 },
  { relativePath: "AGENTS.md", priority: 50 },
] as const

const TARGET_RULE_DIRECTORIES = [
  {
    relativePath: ".github/instructions",
    priority: 10,
    accepts: (name: string) => name.toLowerCase().endsWith(".instructions.md"),
  },
  {
    relativePath: ".cursor/rules",
    priority: 20,
    accepts: (name: string) => {
      const lower = name.toLowerCase()
      return lower.endsWith(".md") || lower.endsWith(".mdc")
    },
  },
  {
    relativePath: ".betterc0de/rules",
    priority: 30,
    accepts: (name: string) => {
      const lower = name.toLowerCase()
      return lower.endsWith(".md") || lower.endsWith(".mdc")
    },
  },
] as const

const PRECEDENCE_EXPLANATION = [
  "Runtime/global rule files are the broadest source.",
  "Backend settings.custom_rules override runtime/global files.",
  "Project-root guides and configured instructions override global rules.",
  "Ancestor guides apply from shallow to deep; the nearest directory wins.",
  "Matching target-glob rules are most specific and merge shallow to deep.",
  "Ties use glob specificity, native filename priority, then source path.",
] as const

interface RuleDocument {
  readonly content: string
  readonly targetGlobs: string[]
  readonly alwaysApply?: boolean
}

interface RuleCandidate {
  readonly key: string
  readonly sourcePath: string
  readonly sourceKind: WorkspaceEffectiveRuleSourceKind
  readonly scope: WorkspaceEffectiveRuleScope
  readonly scopePath: string | null
  readonly depth: number
  readonly priority: number
  readonly content: string
  readonly targetGlobs: string[]
  readonly alwaysApply?: boolean
  readonly truncated: boolean
}

interface RuleDecision {
  applied: boolean
  reason: string
  content: string
  truncated: boolean
}

interface ResolvedTarget {
  readonly root: string
  readonly targetPath: string
  readonly targetDirectory: string
  readonly targetSpecified: boolean
}

export interface ResolveEffectiveRulesInput {
  readonly workspaceRoot?: string | null
  readonly targetPath?: string | null
  readonly globalRules?: string | null
  readonly globalRuleFiles?: readonly string[]
}

export interface EffectiveRulesDependencies {
  readonly listInstructions?: (
    workspaceRoot: string
  ) => Promise<ProjectInstructionTemplate[]>
}

type EffectiveRulesAppState = Pick<AppState, "config" | "settings">

export async function resolveEffectiveRules(
  input: ResolveEffectiveRulesInput,
  dependencies: EffectiveRulesDependencies = {}
): Promise<WorkspaceEffectiveRulesResult> {
  const candidates: RuleCandidate[] = []
  const seenKeys = new Set<string>()
  const target = input.workspaceRoot
    ? await resolveTarget(input.workspaceRoot, input.targetPath)
    : null

  for (const filePath of input.globalRuleFiles ?? []) {
    const read = await readRuleFile(filePath)
    if (!read) continue
    addCandidate(candidates, seenKeys, {
      key: canonicalPathKey(filePath),
      sourcePath: filePath,
      sourceKind: "global-file",
      scope: "global",
      scopePath: null,
      depth: 0,
      priority: 0,
      ...read,
    })
  }

  const globalRules = input.globalRules?.trim()
  if (globalRules) {
    addCandidate(candidates, seenKeys, {
      key: "settings.custom_rules",
      sourcePath: "settings.custom_rules",
      sourceKind: "global-setting",
      scope: "global",
      scopePath: null,
      depth: 0,
      priority: 50,
      content: globalRules,
      targetGlobs: [],
      truncated: false,
    })
  }

  if (target) {
    const chain = ruleDirectoryChain(target.root, target.targetDirectory)
    for (const [index, directory] of chain.entries()) {
      const scopePath = relativeWorkspacePath(target.root, directory)
      const definitions =
        index === 0 ? PROJECT_RULE_FILES : DIRECTORY_RULE_FILES
      for (const definition of definitions) {
        const absolutePath = path.join(directory, definition.relativePath)
        const read = await readRuleFile(absolutePath)
        if (!read) continue
        addCandidate(candidates, seenKeys, {
          key: canonicalPathKey(absolutePath),
          sourcePath: relativeWorkspacePath(target.root, absolutePath),
          sourceKind: index === 0 ? "project-file" : "directory-file",
          scope: index === 0 ? "project" : "directory",
          scopePath,
          depth: index,
          priority: definition.priority,
          ...read,
        })
      }

      for (const definition of TARGET_RULE_DIRECTORIES) {
        if (index > 0 && definition.relativePath !== ".betterc0de/rules") {
          continue
        }
        const ruleFiles = await listTargetRuleFiles(
          path.join(directory, definition.relativePath),
          definition.accepts
        )
        for (const absolutePath of ruleFiles) {
          const read = await readRuleFile(absolutePath)
          if (!read) continue
          addCandidate(candidates, seenKeys, {
            key: canonicalPathKey(absolutePath),
            sourcePath: relativeWorkspacePath(target.root, absolutePath),
            sourceKind: "target-file",
            scope: "target",
            scopePath,
            depth: index,
            priority: definition.priority,
            ...read,
          })
        }
      }
    }

    const configuredInstructions = await (
      dependencies.listInstructions ?? listProjectInstructions
    )(target.root).catch(() => [])
    for (const instruction of configuredInstructions) {
      const sourcePath = instruction.sourcePath.trim()
      if (!sourcePath) continue
      const absolutePath = instructionAbsolutePath(target.root, sourcePath)
      const document = parseRuleDocument(instruction.content)
      const remote = /^https?:\/\//i.test(sourcePath)
      const homeScoped = sourcePath === "~" || sourcePath.startsWith("~/")
      const outsideWorkspace =
        absolutePath !== null && !isPathInside(target.root, absolutePath)
      const targetScoped =
        document.targetGlobs.length > 0 || document.alwaysApply !== undefined
      addCandidate(candidates, seenKeys, {
        key: absolutePath
          ? canonicalPathKey(absolutePath)
          : `configured:${sourcePath}`,
        sourcePath,
        sourceKind: remote
          ? "remote-file"
          : outsideWorkspace || homeScoped
            ? "global-file"
            : "configured-file",
        scope: targetScoped
          ? "target"
          : outsideWorkspace || homeScoped
            ? "global"
            : "project",
        scopePath: outsideWorkspace || homeScoped ? null : ".",
        depth: 0,
        priority: outsideWorkspace || homeScoped ? 10 : 60,
        content: document.content,
        targetGlobs: document.targetGlobs,
        alwaysApply: document.alwaysApply,
        truncated: /\n\n\.\.\.\[(?:aggregate )?truncated\]\s*$/.test(
          instruction.content
        ),
      })
    }
  }

  const ordered = candidates.sort(compareCandidates)
  const decisions = ordered.map((candidate) =>
    decideCandidate(candidate, target)
  )
  suppressDuplicateRules(ordered, decisions)
  applyContextBudget(ordered, decisions)

  const sources = ordered.map((candidate, index) =>
    candidateToSource(candidate, decisions[index]!, index)
  )
  const content = renderEffectiveRuleSources(
    sources.filter((source) => source.applied)
  )
  const appliedCount = sources.filter((source) => source.applied).length
  const skippedCount = sources.length - appliedCount
  const targetPath = target?.targetPath ?? "."

  return workspaceEffectiveRulesResultSchema.parse({
    workspaceRoot: target?.root ?? null,
    targetPath,
    content,
    sources,
    explanation: {
      mergeOrder: "low-to-high",
      summary: `${appliedCount} rule source${appliedCount === 1 ? "" : "s"} applied and ${skippedCount} skipped for ${targetPath}. Later rendered sections take precedence when instructions conflict.`,
      precedence: [...PRECEDENCE_EXPLANATION],
    },
  })
}

export async function resolveAppEffectiveRules(
  state: EffectiveRulesAppState,
  input: {
    readonly workspaceRoot?: string | null
    readonly targetPath?: string | null
  },
  dependencies: EffectiveRulesDependencies = {}
): Promise<WorkspaceEffectiveRulesResult> {
  const settings = state.settings.get() as unknown as {
    custom_rules?: unknown
  }
  const runtimeRulesFile = runtimeRulesFileForDataDir(state.config.dataDir)
  return resolveEffectiveRules(
    {
      workspaceRoot: input.workspaceRoot,
      targetPath: input.targetPath,
      globalRules:
        typeof settings.custom_rules === "string" ? settings.custom_rules : "",
      globalRuleFiles: runtimeRulesFile ? [runtimeRulesFile] : [],
    },
    dependencies
  )
}

export async function resolveTurnSystemInstruction(
  state: EffectiveRulesAppState,
  input: {
    readonly workspaceRoot?: string | null
    readonly targetPath?: string | null
    readonly systemInstruction?: string | null
  }
): Promise<string | null> {
  try {
    const resolution = await resolveAppEffectiveRules(state, input)
    return mergeEffectiveRulesIntoSystemInstruction(
      input.systemInstruction,
      resolution
    )
  } catch (error) {
    // The turn still runs, but without CLAUDE.md/AGENTS.md and the other
    // rule files — never silently.
    logger.warn(
      {
        workspaceRoot: input.workspaceRoot ?? null,
        targetPath: input.targetPath ?? null,
        err: errorText(error),
      },
      "effective rules: resolution failed; turn runs without workspace rule files"
    )
    return normalizeSystemInstruction(input.systemInstruction)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function mergeEffectiveRulesIntoSystemInstruction(
  systemInstruction: string | null | undefined,
  resolution: WorkspaceEffectiveRulesResult
): string | null {
  const base = normalizeSystemInstruction(systemInstruction)
  const baseHasEffectiveRules = base?.includes(EFFECTIVE_RULES_MARKER) === true

  const missingSources = resolution.sources.filter(
    (source) =>
      source.applied &&
      source.content.trim().length > 0 &&
      !base?.includes(source.content.trim())
  )
  if (missingSources.length === 0) return base

  const rendered = renderEffectiveRuleSources(
    missingSources,
    !baseHasEffectiveRules
  )
  if (!rendered) return base
  if (!base) return rendered.slice(0, MAX_SYSTEM_INSTRUCTION_CHARS)

  const remaining = MAX_SYSTEM_INSTRUCTION_CHARS - base.length - 2
  if (remaining <= EFFECTIVE_RULES_MARKER.length) return base
  const appended =
    rendered.length <= remaining
      ? rendered
      : `${rendered.slice(
          0,
          Math.max(0, remaining - TRUNCATION_MARKER.length)
        )}${TRUNCATION_MARKER}`
  return `${base}\n\n${appended}`
}

export function runtimeRulesFileForDataDir(dataDir: string): string | null {
  const configuredHome = process.env.BETTERC0DE_HOME?.trim()
  if (configuredHome && path.isAbsolute(configuredHome)) {
    return path.join(path.resolve(configuredHome), "rules.md")
  }
  const resolved = path.resolve(dataDir)
  return path.basename(resolved).toLowerCase() === "userdata"
    ? path.join(path.dirname(resolved), "rules.md")
    : null
}

function addCandidate(
  candidates: RuleCandidate[],
  seenKeys: Set<string>,
  candidate: RuleCandidate
): void {
  if (!candidate.content.trim() || seenKeys.has(candidate.key)) return
  seenKeys.add(candidate.key)
  candidates.push(candidate)
}

async function resolveTarget(
  workspaceRoot: string,
  rawTargetPath: string | null | undefined
): Promise<ResolvedTarget> {
  const root = await fs.realpath(path.resolve(workspaceRoot)).catch((cause) => {
    throw Object.assign(new Error("workspace root is unavailable", { cause }), {
      statusCode: 403,
    })
  })
  const requested = rawTargetPath?.trim() || "."
  const targetAbsolutePath = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested)
  if (!isPathInside(root, targetAbsolutePath)) {
    throw Object.assign(new Error("rule target escapes workspace root"), {
      statusCode: 403,
    })
  }
  await assertExistingAncestorInside(root, targetAbsolutePath)

  const stat = await fs.stat(targetAbsolutePath).catch(() => null)
  const targetDirectory =
    stat?.isDirectory() || requested === "." || /[\\/]$/.test(requested)
      ? targetAbsolutePath
      : path.dirname(targetAbsolutePath)
  const targetPath = relativeWorkspacePath(root, targetAbsolutePath)
  return {
    root,
    targetPath,
    targetDirectory,
    targetSpecified: targetPath !== ".",
  }
}

async function assertExistingAncestorInside(
  root: string,
  target: string
): Promise<void> {
  let current = target
  while (true) {
    try {
      const canonical = await fs.realpath(current)
      if (!isPathInside(root, canonical)) {
        throw Object.assign(new Error("rule target escapes workspace root"), {
          statusCode: 403,
        })
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (current === root) return
    const parent = path.dirname(current)
    if (parent === current || !isPathInside(root, parent)) return
    current = parent
  }
}

function ruleDirectoryChain(root: string, targetDirectory: string): string[] {
  const relative = path.relative(root, targetDirectory)
  if (!relative) return [root]
  const segments = relative.split(path.sep).filter(Boolean)
  const chain = [root]
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    chain.push(current)
  }
  return chain
}

async function readRuleFile(absolutePath: string): Promise<
  | (RuleDocument & {
      readonly truncated: boolean
    })
  | null
> {
  let stat: import("node:fs").Stats
  try {
    stat = await fs.lstat(absolutePath)
  } catch (error) {
    // Absent is the normal case for most candidates; anything else means a
    // rule file the user wrote is being dropped, which they need to know.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        { path: absolutePath, err: errorText(error) },
        "effective rules: could not stat rule file; skipping it"
      )
    }
    return null
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null

  let handle: import("node:fs/promises").FileHandle | null = null
  try {
    handle = await fs.open(absolutePath, "r")
    const bytesToRead = Math.min(stat.size, MAX_RULE_FILE_BYTES)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    const truncated = stat.size > bytesRead
    const text = decodeUtf8Prefix(buffer.subarray(0, bytesRead))
    const parsed = parseRuleDocument(
      truncated ? `${text.trimEnd()}${TRUNCATION_MARKER}` : text
    )
    if (!parsed.content.trim()) return null
    return { ...parsed, truncated }
  } catch (error) {
    logger.warn(
      { path: absolutePath, err: errorText(error) },
      "effective rules: could not read rule file; skipping it"
    )
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parseRuleDocument(rawContent: string): RuleDocument {
  const normalized = rawContent.replace(/^\uFEFF/, "")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized)
  if (!match) {
    return { content: normalized.trim(), targetGlobs: [] }
  }

  const metadata = parseRuleFrontmatter(match[1] ?? "")
  return {
    content: (match[2] ?? "").trim(),
    targetGlobs: metadata.targetGlobs,
    ...(metadata.alwaysApply === undefined
      ? {}
      : { alwaysApply: metadata.alwaysApply }),
  }
}

function parseRuleFrontmatter(input: string): {
  targetGlobs: string[]
  alwaysApply?: boolean
} {
  const targetGlobs: string[] = []
  let alwaysApply: boolean | undefined
  let listKey: "globs" | "applyto" | null = null

  for (const line of input.split(/\r?\n/g)) {
    const listItem = /^\s*-\s*(.+?)\s*$/.exec(line)
    if (listItem && listKey) {
      targetGlobs.push(...parseGlobScalar(listItem[1] ?? ""))
      continue
    }
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (!field) continue
    const key = field[1]!.toLowerCase()
    const value = field[2] ?? ""
    listKey = key === "globs" || key === "applyto" ? key : null
    if (listKey && value.trim()) {
      targetGlobs.push(...parseGlobScalar(value))
    }
    if (key === "alwaysapply" || key === "always_apply") {
      alwaysApply = parseBoolean(value)
    }
  }

  return {
    targetGlobs: Array.from(
      new Set(targetGlobs.map(normalizeGlob).filter(Boolean))
    ),
    ...(alwaysApply === undefined ? {} : { alwaysApply }),
  }
}

function parseGlobScalar(value: string): string[] {
  const trimmed = stripScalarQuotes(value.trim())
  const body =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed
  return splitGlobList(body)
    .map((item) => stripScalarQuotes(item.trim()))
    .filter(Boolean)
}

function splitGlobList(value: string): string[] {
  const items: string[] = []
  let current = ""
  let braceDepth = 0
  let quote: "'" | '"' | null = null
  let escaped = false
  for (const char of value) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote === '"') {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === "{") braceDepth += 1
    if (char === "}" && braceDepth > 0) braceDepth -= 1
    if (char === "," && braceDepth === 0) {
      items.push(current)
      current = ""
      continue
    }
    current += char
  }
  items.push(current)
  return items
}

function stripScalarQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = stripScalarQuotes(value.trim()).toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

function normalizeGlob(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
}

async function listTargetRuleFiles(
  root: string,
  accepts: (name: string) => boolean
): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string, depth: number): Promise<void> {
    if (
      depth > MAX_RULE_DIRECTORY_DEPTH ||
      files.length >= MAX_TARGET_RULE_FILES
    ) {
      return
    }
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      })
    )
    for (const entry of entries) {
      if (files.length >= MAX_TARGET_RULE_FILES) return
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(absolutePath, depth + 1)
      } else if (entry.isFile() && accepts(entry.name)) {
        files.push(absolutePath)
      }
    }
  }

  await walk(root, 0)
  return files
}

function instructionAbsolutePath(
  workspaceRoot: string,
  sourcePath: string
): string | null {
  if (/^https?:\/\//i.test(sourcePath)) return null
  if (sourcePath === "~") return configuredHomeDirectory()
  if (sourcePath.startsWith("~/")) {
    return path.resolve(configuredHomeDirectory(), sourcePath.slice(2))
  }
  return path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(workspaceRoot, sourcePath)
}

function configuredHomeDirectory(): string {
  const configured = process.env.BetterC0de_TEST_HOME?.trim()
  if (!configured || configured === "~") return path.resolve(os.homedir())
  if (configured.startsWith("~/")) {
    return path.resolve(os.homedir(), configured.slice(2))
  }
  return path.resolve(configured)
}

function compareCandidates(left: RuleCandidate, right: RuleCandidate): number {
  const leftWeight = candidateWeight(left)
  const rightWeight = candidateWeight(right)
  if (leftWeight !== rightWeight) return leftWeight - rightWeight
  if (left.scope === "target" && right.scope === "target") {
    const leftSpecificity = globSpecificity(left.targetGlobs)
    const rightSpecificity = globSpecificity(right.targetGlobs)
    if (leftSpecificity !== rightSpecificity) {
      return leftSpecificity - rightSpecificity
    }
  }
  if (left.priority !== right.priority) return left.priority - right.priority
  return compareStableSourcePaths(left.sourcePath, right.sourcePath)
}

function compareStableSourcePaths(left: string, right: string): number {
  const normalizedLeft = left.replace(/\\/g, "/")
  const normalizedRight = right.replace(/\\/g, "/")
  const foldedLeft = normalizedLeft.toLowerCase()
  const foldedRight = normalizedRight.toLowerCase()
  if (foldedLeft < foldedRight) return -1
  if (foldedLeft > foldedRight) return 1
  if (normalizedLeft < normalizedRight) return -1
  if (normalizedLeft > normalizedRight) return 1
  return 0
}

function candidateWeight(candidate: RuleCandidate): number {
  switch (candidate.scope) {
    case "global":
      return 0
    case "project":
      return 1_000
    case "directory":
      return 2_000 + candidate.depth * 100
    case "target":
      return 10_000 + candidate.depth * 100
  }
}

function globSpecificity(globs: readonly string[]): number {
  return globs.reduce((best, glob) => {
    const positive = glob.startsWith("!") ? glob.slice(1) : glob
    const literalCharacters = positive.replace(/[*?[\]{}]/g, "").length
    const pathSegments = positive.split("/").length
    return Math.max(best, literalCharacters + pathSegments * 10)
  }, 0)
}

function decideCandidate(
  candidate: RuleCandidate,
  target: ResolvedTarget | null
): RuleDecision {
  if (candidate.scope !== "target") {
    return {
      applied: true,
      reason:
        candidate.scope === "global"
          ? "Applies globally."
          : candidate.scope === "project"
            ? "Applies to the whole workspace."
            : `Applies beneath ${candidate.scopePath ?? "."}.`,
      content: candidate.content,
      truncated: candidate.truncated,
    }
  }

  if (candidate.alwaysApply === true) {
    return {
      applied: true,
      reason: "Applied because alwaysApply is true.",
      content: candidate.content,
      truncated: candidate.truncated,
    }
  }
  if (candidate.targetGlobs.length === 0) {
    return {
      applied: candidate.alwaysApply !== false,
      reason:
        candidate.alwaysApply === false
          ? "Skipped because alwaysApply is false and no target globs were declared."
          : "Applied because the target rule has no restricting globs.",
      content: candidate.content,
      truncated: candidate.truncated,
    }
  }
  if (!target?.targetSpecified) {
    return {
      applied: false,
      reason: `Skipped until a target path is provided (${candidate.targetGlobs.join(", ")}).`,
      content: candidate.content,
      truncated: candidate.truncated,
    }
  }

  const matches = targetMatchesGlobs(
    target.targetPath,
    candidate.scopePath,
    candidate.targetGlobs
  )
  return {
    applied: matches,
    reason: matches
      ? `Target ${target.targetPath} matches ${candidate.targetGlobs.join(", ")}.`
      : `Target ${target.targetPath} does not match ${candidate.targetGlobs.join(", ")}.`,
    content: candidate.content,
    truncated: candidate.truncated,
  }
}

function targetMatchesGlobs(
  targetPath: string,
  scopePath: string | null,
  globs: readonly string[]
): boolean {
  const normalizedTarget = normalizeGlob(targetPath)
  const normalizedScope = normalizeGlob(scopePath ?? ".")
  const relativeToScope =
    normalizedScope === "." || !normalizedScope
      ? normalizedTarget
      : path.posix.relative(normalizedScope, normalizedTarget)
  if (relativeToScope.startsWith("../")) return false

  const positive = globs.filter((glob) => !glob.startsWith("!"))
  const negative = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => glob.slice(1))
  const candidates = new Set([
    normalizedTarget,
    relativeToScope,
    path.posix.basename(normalizedTarget),
  ])
  const matchesAny = (patterns: readonly string[]) =>
    patterns.some((pattern) => {
      const matches = compileRuleGlob(pattern)
      return Array.from(candidates).some(matches)
    })

  return (
    (positive.length === 0 || matchesAny(positive)) && !matchesAny(negative)
  )
}

function compileRuleGlob(rawPattern: string): (candidate: string) => boolean {
  const pattern = normalizeGlob(rawPattern).replace(/^\/+/, "")
  const alternatives = expandGlobBraces(pattern).map((alternative) =>
    compileBoundedGlob(alternative, {
      caseInsensitive: process.platform === "win32",
    })
  )
  return (candidate) => alternatives.some((matches) => matches(candidate))
}

function expandGlobBraces(pattern: string, limit = 32): string[] {
  const open = pattern.indexOf("{")
  if (open < 0) return [pattern]

  let depth = 0
  let close = -1
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close < 0) return [pattern]

  const choices = splitGlobList(pattern.slice(open + 1, close))
  if (choices.length < 2) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const expanded: string[] = []
  for (const choice of choices) {
    for (const nested of expandGlobBraces(
      `${prefix}${choice}${suffix}`,
      limit - expanded.length
    )) {
      expanded.push(nested)
      if (expanded.length >= limit) return expanded
    }
  }
  return expanded
}

function suppressDuplicateRules(
  ordered: readonly RuleCandidate[],
  decisions: RuleDecision[]
): void {
  const seenContent = new Map<string, string>()
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!
    if (!decision.applied) continue
    const contentKey = ordered[index]!.content.trim()
    const winningSource = seenContent.get(contentKey)
    if (winningSource) {
      decision.applied = false
      decision.reason = `Skipped because the same content is supplied by higher-precedence ${winningSource}.`
      decision.content = ""
      continue
    }
    seenContent.set(contentKey, ordered[index]!.sourcePath)
  }
}

function applyContextBudget(
  ordered: readonly RuleCandidate[],
  decisions: RuleDecision[]
): void {
  let remaining = MAX_EFFECTIVE_RULE_BYTES
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!
    if (!decision.applied) {
      decision.content = ""
      continue
    }
    const allowed = Math.min(remaining, MAX_EFFECTIVE_RULE_SOURCE_BYTES)
    if (allowed <= Buffer.byteLength(TRUNCATION_MARKER, "utf8")) {
      decision.applied = false
      decision.reason =
        "Skipped because higher-precedence rules exhausted the context budget."
      decision.content = ""
      continue
    }
    const clipped = truncateUtf8(decision.content, allowed)
    decision.truncated ||= clipped.truncated
    decision.content = clipped.value
    remaining -= Buffer.byteLength(clipped.value, "utf8")
  }
}

function candidateToSource(
  candidate: RuleCandidate,
  decision: RuleDecision,
  precedence: number
): WorkspaceEffectiveRuleSource {
  const visibleContent = decision.applied
    ? { value: decision.content, truncated: decision.truncated }
    : truncateUtf8(candidate.content, MAX_PROVENANCE_RULE_SOURCE_BYTES)
  return {
    id: createHash("sha256")
      .update(
        `${candidate.sourceKind}\0${candidate.sourcePath}\0${candidate.scopePath ?? ""}`
      )
      .digest("hex")
      .slice(0, 24),
    sourcePath: candidate.sourcePath,
    sourceKind: candidate.sourceKind,
    scope: candidate.scope,
    scopePath: candidate.scopePath,
    targetGlobs: candidate.targetGlobs,
    precedence,
    applied: decision.applied,
    reason: decision.reason,
    content: visibleContent.value,
    truncated: decision.truncated || visibleContent.truncated,
  }
}

function renderEffectiveRuleSources(
  sources: readonly WorkspaceEffectiveRuleSource[],
  includePreamble = true
): string {
  if (sources.length === 0) return ""
  const sections = sources.flatMap((source, index) => [
    `### ${index + 1}. ${ruleScopeLabel(source.scope)} — ${sanitizeHeading(source.sourcePath)}`,
    "",
    source.content.trim(),
    "",
  ])
  return (
    includePreamble
      ? [
          EFFECTIVE_RULES_MARKER,
          "## Effective BetterC0de Rules",
          "",
          "Sources are ordered from broadest to most specific. When instructions conflict, later sections take precedence.",
          "",
          ...sections,
        ]
      : sections
  )
    .join("\n")
    .trimEnd()
}

function ruleScopeLabel(scope: WorkspaceEffectiveRuleScope): string {
  switch (scope) {
    case "global":
      return "Global"
    case "project":
      return "Project"
    case "directory":
      return "Directory"
    case "target":
      return "Target"
  }
}

function sanitizeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim()
}

function truncateUtf8(
  value: string,
  maxBytes: number
): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8")
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false }
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8")
  const prefix = decodeUtf8Prefix(
    encoded.subarray(0, Math.max(0, maxBytes - markerBytes))
  ).trimEnd()
  return {
    value: `${prefix}${TRUNCATION_MARKER}`,
    truncated: true,
  }
}

function decodeUtf8Prefix(buffer: Buffer): string {
  let end = buffer.byteLength
  let decoded = buffer.subarray(0, end).toString("utf8")
  while (end > 0 && decoded.endsWith("\uFFFD")) {
    end -= 1
    decoded = buffer.subarray(0, end).toString("utf8")
  }
  return decoded
}

function canonicalPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function relativeWorkspacePath(root: string, value: string): string {
  const relative = path.relative(root, value).replace(/\\/g, "/")
  return relative || "."
}

function isPathInside(root: string, value: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

function normalizeSystemInstruction(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
