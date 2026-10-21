/**
 * Tool executor for the in-house agent loop.
 *
 * Maps the canonical tool names from `tool-catalog.ts` onto the existing
 * backend service primitives (`services/shell`, `services/workspace`). File
 * primitives are confined to the project root by the workspace service. Bash
 * is process-supervised and starts in that root, but it is not an OS sandbox:
 * an approved command can still address paths outside the workspace.
 *
 * Contract: `executeTool` never throws — failures come back as
 * `{ output, error }` so the loop can feed the error string back to the model
 * (which can then recover) and the UI can render the failed state. A non-zero
 * shell exit is NOT treated as an error (the model should see stderr + code).
 */

import { createHash } from "node:crypto"
import {
  preferredAgentShell,
  type ShellCommandRunner,
} from "../../services/shell"
import {
  readFile,
  writeFile,
  searchEntriesDetailed,
  searchContentDetailed,
} from "../../services/workspace"
import { DIRECT_TOOL_TIMEOUT_MS, validateToolInput } from "./tool-catalog"

export interface ToolExecLimits {
  maxLines: number
  maxBytes: number
}

export interface ToolExecContext {
  /** Project root the tools operate inside. Empty ⇒ no folder attached. */
  cwd: string
  /** Stable id correlating tool_call ↔ tool_result; also the shell sessionId. */
  toolId: string
  /** Output caps (from `getProjectToolOutputLimits`). */
  limits: ToolExecLimits
  /** Turn cancellation propagated by the owning direct-provider adapter. */
  signal?: AbortSignal
  /** Per-call ceiling, clamped to `DIRECT_TOOL_TIMEOUT_MS`. */
  timeoutMs?: number
  /**
   * The backend's shell sessions (`AppState.shellSessions`), which Bash runs
   * its command in. Bootstrap hands them to every direct-provider adapter;
   * without them Bash fails instead of starting an untracked process.
   */
  shell?: ShellCommandRunner
}

export type ToolExecTerminationStatus = "cancelled" | "timed_out"

export interface ToolExecResult {
  output: string
  /** Set only on an executor-level failure (renders as a red error band). */
  error?: string
  /** Machine-readable distinction between user cancellation and timeout. */
  status?: ToolExecTerminationStatus
  /** Structured optimistic edit evidence for canonical diff projection. */
  mutation?: ToolMutationArtifact
}

export interface ToolMutationArtifact {
  path: string
  operation: "write" | "edit"
  preimageHash: string | null
  resultHash: string
  unifiedDiff: string
  additions: number
  deletions: number
  isNew: boolean
  patchComplete: boolean
}

const NO_FOLDER = "No project folder is attached."
const NO_SHELL = "No shell is available to run this command."
const MAX_STRUCTURED_EDIT_CHARACTERS = 2_000_000
const MAX_STRUCTURED_PATCH_BYTES = 512 * 1024

interface ActiveToolExecContext extends ToolExecContext {
  signal: AbortSignal
  timeoutMs: number
}

type ToolOperationOutcome =
  | { kind: "completed"; result: ToolExecResult }
  | { kind: "failed"; error: unknown }

interface ToolTerminationOutcome {
  kind: "terminated"
  status: ToolExecTerminationStatus
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolExecContext
): Promise<ToolExecResult> {
  const validation = validateToolInput(
    name,
    normalizeLegacyToolInput(name, input)
  )
  if (!validation.ok) return fail(validation.error)
  const args = validation.value
  const contextCeilingMs = normalizeTimeoutMs(ctx.timeoutMs)
  const requestedTimeoutMs =
    name === "Bash" && typeof args.timeout_ms === "number"
      ? args.timeout_ms
      : contextCeilingMs
  const scope = createExecutionScope({
    ...ctx,
    timeoutMs: Math.min(requestedTimeoutMs, contextCeilingMs),
  })
  try {
    const initialTermination = scope.status()
    if (initialTermination) return terminated(initialTermination, ctx.limits)

    const activeContext: ActiveToolExecContext = {
      ...ctx,
      signal: scope.signal,
      timeoutMs: scope.timeoutMs,
    }
    const operation: Promise<ToolOperationOutcome> = dispatchTool(
      name,
      args,
      activeContext
    ).then(
      (result) => ({ kind: "completed", result }),
      (error: unknown) => ({ kind: "failed", error })
    )
    const outcome = await Promise.race<
      ToolOperationOutcome | ToolTerminationOutcome
    >([operation, scope.termination])

    if (outcome.kind === "terminated") {
      // Bash and mutating workspace tools must quiesce before a terminal
      // result is published: Bash owns a child-process tree, while a detached
      // Write/Edit could otherwise commit after the caller was told the tool
      // had stopped. Read-only workspace primitives have no retained process
      // or late mutation and their handled promises may settle in the
      // background after the bounded result is returned.
      if (name === "Bash" || name === "Write" || name === "Edit") {
        const settled = await operation
        if (name === "Bash" && settled.kind === "failed") {
          return normalizeFailure(settled.error)
        }
      }
      return terminated(outcome.status, ctx.limits)
    }
    return outcome.kind === "failed"
      ? normalizeFailure(outcome.error)
      : outcome.result
  } finally {
    scope.dispose()
  }
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ActiveToolExecContext
): Promise<ToolExecResult> {
  switch (name) {
    case "Read":
      return await execRead(args, ctx)
    case "Write":
      return await execWrite(args, ctx)
    case "Edit":
      return await execEdit(args, ctx)
    case "Bash":
      return await execBash(args, ctx)
    case "Glob":
      return await execGlob(args, ctx)
    case "Grep":
      return await execGrep(args, ctx)
    default:
      return fail(`Unknown tool "${name}".`)
  }
}

function createExecutionScope(ctx: ToolExecContext): {
  signal: AbortSignal
  timeoutMs: number
  termination: Promise<ToolTerminationOutcome>
  status: () => ToolExecTerminationStatus | null
  dispose: () => void
} {
  const controller = new AbortController()
  const timeoutMs = normalizeTimeoutMs(ctx.timeoutMs)
  let currentStatus: ToolExecTerminationStatus | null = null
  let resolveTermination!: (outcome: ToolTerminationOutcome) => void
  const termination = new Promise<ToolTerminationOutcome>((resolve) => {
    resolveTermination = resolve
  })
  const terminate = (status: ToolExecTerminationStatus) => {
    if (currentStatus) return
    currentStatus = status
    controller.abort(status)
    resolveTermination({ kind: "terminated", status })
  }
  const onAbort = () => terminate("cancelled")
  ctx.signal?.addEventListener("abort", onAbort, { once: true })
  if (ctx.signal?.aborted) onAbort()

  const timer =
    currentStatus === null
      ? setTimeout(() => terminate("timed_out"), timeoutMs)
      : undefined
  timer?.unref?.()

  return {
    signal: controller.signal,
    timeoutMs,
    termination,
    status: () => currentStatus,
    dispose: () => {
      if (timer) clearTimeout(timer)
      ctx.signal?.removeEventListener("abort", onAbort)
    },
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DIRECT_TOOL_TIMEOUT_MS
  }
  return Math.min(Math.max(Math.trunc(value), 1), DIRECT_TOOL_TIMEOUT_MS)
}

function normalizeFailure(err: unknown): ToolExecResult {
  const record =
    err && typeof err === "object"
      ? (err as { statusCode?: unknown; code?: unknown })
      : null
  if (record?.code === "SHELL_PROCESS_TREE_INCOMPLETE") {
    return fail("Tool process cleanup failed.")
  }
  if (record?.statusCode === 409 && record.code === "WORKSPACE_PATH_CHANGED") {
    return fail(
      "The file changed after it was read. Read the latest contents and retry the edit."
    )
  }
  return fail(
    record?.statusCode === 403
      ? "Tool access was denied."
      : "Tool execution failed."
  )
}

function normalizeLegacyToolInput(name: string, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const value = { ...(input as Record<string, unknown>) }
  const promote = (target: string, aliases: readonly string[]) => {
    if (!(target in value)) {
      const alias = aliases.find((candidate) => candidate in value)
      if (alias) value[target] = value[alias]
    }
    for (const alias of aliases) delete value[alias]
  }
  if (name === "Read") promote("path", ["file_path", "relative_path"])
  if (name === "Write" || name === "Edit") promote("path", ["file_path"])
  if (name === "Glob" || name === "Grep") promote("pattern", ["query"])
  return value
}

async function execRead(
  args: Record<string, unknown>,
  ctx: ActiveToolExecContext
): Promise<ToolExecResult> {
  const path = asString(args.path ?? args.file_path ?? args.relative_path)
  if (!path) return fail("Read requires a 'path' string.")
  if (!ctx.cwd) return fail(NO_FOLDER)
  throwIfTerminated(ctx)
  const { content } = await readFile({ cwd: ctx.cwd, relative_path: path })
  throwIfTerminated(ctx)
  return ok(truncate(content, ctx.limits))
}

async function execWrite(
  args: Record<string, unknown>,
  ctx: ActiveToolExecContext
): Promise<ToolExecResult> {
  const path = asString(args.path ?? args.file_path)
  if (!path) return fail("Write requires a 'path' string.")
  if (!ctx.cwd) return fail(NO_FOLDER)
  // Never default a missing body to "": a tool call cut off at the output
  // token limit arrives without `content`, and writing "" would empty the file.
  if (typeof args.content !== "string") {
    return fail("Write requires a 'content' string.")
  }
  const content = args.content
  throwIfTerminated(ctx)
  const previous = await readOptionalTextFile(ctx.cwd, path)
  throwIfTerminated(ctx)
  const preimageHash = previous === null ? null : contentHash(previous)
  await writeFile(ctx.cwd, path, content, {
    expectedContentHash: preimageHash,
  })
  throwIfTerminated(ctx)
  return ok(
    `Wrote ${content.length} characters to ${path}.`,
    buildMutationArtifact(path, "write", previous, content)
  )
}

async function execEdit(
  args: Record<string, unknown>,
  ctx: ActiveToolExecContext
): Promise<ToolExecResult> {
  const path = asString(args.path ?? args.file_path)
  if (!path) return fail("Edit requires a 'path' string.")
  if (!ctx.cwd) return fail(NO_FOLDER)
  const oldString = asString(args.old_string)
  if (!oldString) return fail("Edit requires a non-empty 'old_string'.")
  // A missing `new_string` must not turn the edit into a deletion.
  if (typeof args.new_string !== "string") {
    return fail("Edit requires a 'new_string' string.")
  }
  const newString = args.new_string
  const replaceAll = args.replace_all === true

  throwIfTerminated(ctx)
  const { content } = await readFile({ cwd: ctx.cwd, relative_path: path })
  throwIfTerminated(ctx)
  const count = countOccurrences(content, oldString)
  if (count === 0) return fail(`old_string was not found in ${path}.`)
  if (count > 1 && !replaceAll) {
    return fail(
      `old_string is not unique in ${path} (${count} matches). Add surrounding context or set replace_all=true.`
    )
  }

  // split/join (not String.replace) so `$`-sequences in new_string are literal.
  let next: string
  if (replaceAll) {
    next = content.split(oldString).join(newString)
  } else {
    const idx = content.indexOf(oldString)
    next =
      content.slice(0, idx) + newString + content.slice(idx + oldString.length)
  }
  throwIfTerminated(ctx)
  const preimageHash = contentHash(content)
  await writeFile(ctx.cwd, path, next, {
    expectedContentHash: preimageHash,
  })
  throwIfTerminated(ctx)
  const n = replaceAll ? count : 1
  return ok(
    `Edited ${path} (${n} replacement${n === 1 ? "" : "s"}).`,
    buildMutationArtifact(path, "edit", content, next)
  )
}

async function execBash(
  args: Record<string, unknown>,
  ctx: ActiveToolExecContext
): Promise<ToolExecResult> {
  const command = asString(args.command)
  if (!command) return fail("Bash requires a 'command' string.")
  if (!ctx.cwd) return fail(NO_FOLDER)
  if (!ctx.shell) return fail(NO_SHELL)
  throwIfTerminated(ctx)
  const requestedTimeoutMs =
    typeof args.timeout_ms === "number" ? args.timeout_ms : ctx.timeoutMs
  const timeoutMs = Math.min(requestedTimeoutMs, ctx.timeoutMs)
  // The tool is advertised as Bash: on Windows run it under Git Bash when it
  // is installed instead of cmd.exe, which would misread POSIX commands.
  const shell = preferredAgentShell()
  const res = await ctx.shell.runCommand({
    command,
    cwd: ctx.cwd,
    timeoutMs,
    sessionId: ctx.toolId,
    signal: ctx.signal,
    ...(shell ? { shell } : {}),
  })
  if (res.timedOut) {
    return terminated("timed_out", ctx.limits, res.combined)
  }
  if (res.aborted) {
    return terminated("cancelled", ctx.limits, res.combined)
  }
  const parts: string[] = []
  if (res.combined) parts.push(res.combined)
  if (!res.success) parts.push(`[exit code ${res.exitCode ?? "?"}]`)
  const body = parts.join("\n").trim() || "(no output)"
  return ok(truncate(body, ctx.limits))
}

async function execGlob(
  args: Record<string, unknown>,
  ctx: ActiveToolExecContext
): Promise<ToolExecResult> {
  if (!ctx.cwd) return fail(NO_FOLDER)
  const pattern = asString(args.pattern ?? args.query) ?? ""
  throwIfTerminated(ctx)
  const search = await searchEntriesDetailed(ctx.cwd, pattern)
  throwIfTerminated(ctx)
  const entries = search.entries
  const lines =
    entries.length === 0
      ? [`No files match "${pattern}".`]
      : entries.map((e) => (e.is_dir ? `${e.path}/` : e.path))
  if (search.truncated) {
    // The agent must not mistake a partial listing for the whole tree.
    lines.push(
      `[results truncated (${search.truncatedReason ?? "limit"}); narrow the pattern to see the rest]`
    )
  }
  return ok(truncate(lines.join("\n"), ctx.limits))
}

async function execGrep(
  args: Record<string, unknown>,
  ctx: ActiveToolExecContext
): Promise<ToolExecResult> {
  const pattern = asString(args.pattern ?? args.query)
  if (!pattern) return fail("Grep requires a 'pattern' string.")
  if (!ctx.cwd) return fail(NO_FOLDER)
  throwIfTerminated(ctx)
  const search = await searchContentDetailed(ctx.cwd, pattern, {
    regex: args.regex === true,
    caseSensitive: args.case_sensitive === true,
    include: asString(args.include),
    exclude: asString(args.exclude),
  })
  throwIfTerminated(ctx)
  const results = search.results
  const lines: string[] =
    results.length === 0 ? [`No matches for "${pattern}".`] : []
  for (const r of results) {
    for (const m of r.matches) {
      lines.push(`${r.path}:${m.line}: ${m.preview.trim()}`)
    }
  }
  if (search.truncated) {
    lines.push(
      `[matches truncated (${search.truncatedReason ?? "limit"}); narrow the pattern or add include/exclude to see the rest]`
    )
  }
  return ok(truncate(lines.join("\n"), ctx.limits))
}

// ── helpers ──────────────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return undefined
}

function ok(output: string, mutation?: ToolMutationArtifact): ToolExecResult {
  return { output, ...(mutation ? { mutation } : {}) }
}

function fail(message: string): ToolExecResult {
  return { output: `Error: ${message}`, error: message }
}

function terminated(
  status: ToolExecTerminationStatus,
  limits: ToolExecLimits,
  partialOutput?: string
): ToolExecResult {
  const message =
    status === "cancelled"
      ? "Tool execution was cancelled."
      : "Tool execution timed out."
  const output = truncate(
    partialOutput?.trim()
      ? `Error: ${message}\nPartial output:\n${partialOutput.trim()}`
      : `Error: ${message}`,
    limits
  )
  return { output, error: message, status }
}

function throwIfTerminated(ctx: ActiveToolExecContext): void {
  if (!ctx.signal.aborted) return
  throw Object.assign(new Error("Tool execution terminated."), {
    code: "TOOL_EXECUTION_TERMINATED",
  })
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

async function readOptionalTextFile(
  cwd: string,
  relativePath: string
): Promise<string | null> {
  try {
    return (await readFile({ cwd, relative_path: relativePath })).content
  } catch (error) {
    const record =
      error && typeof error === "object"
        ? (error as { statusCode?: unknown })
        : null
    if (record?.statusCode === 404) return null
    throw error
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function buildMutationArtifact(
  path: string,
  operation: ToolMutationArtifact["operation"],
  before: string | null,
  after: string
): ToolMutationArtifact | undefined {
  if (before === after) return undefined
  const beforeLines = patchLines(before ?? "")
  const afterLines = patchLines(after)
  const preimageHash = before === null ? null : contentHash(before)
  const resultHash = contentHash(after)

  if ((before?.length ?? 0) + after.length > MAX_STRUCTURED_EDIT_CHARACTERS) {
    return {
      path,
      operation,
      preimageHash,
      resultHash,
      unifiedDiff: "",
      additions: countLineChanges(afterLines, beforeLines),
      deletions: countLineChanges(beforeLines, afterLines),
      isNew: before === null,
      patchComplete: false,
    }
  }

  const rendered = renderUnifiedEdit(path, before, beforeLines, afterLines)
  const patchComplete =
    Buffer.byteLength(rendered.patch, "utf8") <= MAX_STRUCTURED_PATCH_BYTES
  return {
    path,
    operation,
    preimageHash,
    resultHash,
    unifiedDiff: patchComplete ? rendered.patch : "",
    additions: rendered.additions,
    deletions: rendered.deletions,
    isNew: before === null,
    patchComplete,
  }
}

function renderUnifiedEdit(
  path: string,
  before: string | null,
  beforeLines: string[],
  afterLines: string[]
): { patch: string; additions: number; deletions: number } {
  const normalizedPath = path.replace(/\\/g, "/")
  const oldHeader = before === null ? "/dev/null" : `a/${normalizedPath}`
  const newHeader = `b/${normalizedPath}`
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }
  if (
    before !== null &&
    prefix === beforeLines.length &&
    prefix === afterLines.length
  ) {
    // The only change is the final-newline state. Re-emit the last logical
    // line so the patch remains inspectable and its counts remain explicit.
    prefix = Math.max(0, prefix - 1)
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldChangeEnd = beforeLines.length - suffix
  const newChangeEnd = afterLines.length - suffix
  const contextStart = Math.max(0, prefix - 3)
  const oldContextEnd = Math.min(beforeLines.length, oldChangeEnd + 3)
  const newContextEnd = Math.min(afterLines.length, newChangeEnd + 3)
  const oldCount = oldContextEnd - contextStart
  const newCount = newContextEnd - contextStart
  const removed = beforeLines.slice(prefix, oldChangeEnd)
  const added = afterLines.slice(prefix, newChangeEnd)
  const body = [
    ...beforeLines.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...beforeLines.slice(oldChangeEnd, oldContextEnd).map((line) => ` ${line}`),
  ]
  const lines = [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    ...(before === null ? ["new file mode 100644"] : []),
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
    `@@ -${before === null ? 0 : contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`,
    ...body,
  ]
  return {
    patch: `${lines.join("\n")}\n`,
    additions: added.length,
    deletions: removed.length,
  }
}

function patchLines(content: string): string[] {
  if (!content) return []
  const normalized = content.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  if (normalized.endsWith("\n")) lines.pop()
  return lines
}

function countLineChanges(
  candidate: readonly string[],
  baseline: readonly string[]
): number {
  let prefix = 0
  while (
    prefix < candidate.length &&
    prefix < baseline.length &&
    candidate[prefix] === baseline[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < candidate.length - prefix &&
    suffix < baseline.length - prefix &&
    candidate[candidate.length - 1 - suffix] ===
      baseline[baseline.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return Math.max(0, candidate.length - prefix - suffix)
}

function truncate(text: string, limits: ToolExecLimits): string {
  let out = text
  let truncated = false
  const marker = "\n… [output truncated]"

  const lines = out.split("\n")
  if (lines.length > limits.maxLines) {
    out = lines.slice(0, limits.maxLines).join("\n")
    truncated = true
  }
  const markerBytes = Buffer.byteLength(marker, "utf8")
  const contentBudget = Math.max(
    0,
    limits.maxBytes - (truncated ? markerBytes : 0)
  )
  if (Buffer.byteLength(out, "utf8") > contentBudget) {
    truncated = true
    out = utf8Prefix(out, Math.max(0, limits.maxBytes - markerBytes))
  } else if (truncated) {
    out = utf8Prefix(out, contentBudget)
  }
  if (!truncated) return out
  if (limits.maxBytes <= markerBytes) {
    return utf8Prefix(marker.trimStart(), limits.maxBytes)
  }
  return `${out}${marker}`
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  let bytes = 0
  let out = ""
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8")
    if (bytes + codePointBytes > maxBytes) break
    out += codePoint
    bytes += codePointBytes
  }
  return out
}
