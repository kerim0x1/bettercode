import { useChatStore } from "@/lib/chat-store"
import { stringifyCliArgs } from "@/lib/cli-parse"
import { useEditorStore } from "@/lib/editor-store"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  buildOpenEditorWorkspaceSymbolSourcesFromTabs,
  buildWorkspaceSymbols,
} from "@/lib/workspace-symbols"
import { gitDiff, gitDiffStaged, gitStatus } from "@/services/backend/gitApi"
import { loadThreadDiffs } from "@/services/backend/coreApi"
import {
  quickOpenFiles,
  searchContentDetailed,
  type WorkspaceContentSearchResult,
  type WorkspaceQuickOpenFile,
} from "@/services/backend/workspaceApi"
import { type GitStatus } from "@betterc0de/schema"
import { errorMessage } from "./input-context"
import { formatDebugPathCell } from "./lsp-commands"
import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  type ActiveThreadRef,
} from "./provider-config"
import {
  extractDebugRgOptions,
  readDebugStatusFileList,
  withSearchTruncationNote,
  type SearchOutputTruncation,
} from "./runtime-commands"
import {
  buildThreadDiffMarkdown,
  countUnifiedDiffStats,
  truncateDiffPreview,
} from "./thread-export"

export async function buildDiffThreadOutput(
  threadId: string | null,
  args: readonly string[]
): Promise<string> {
  if (!threadId) return "# Session Diff\n\n> No active chat is selected."

  const store = useChatStore.getState()
  await store.ensureFullThreadMessages(threadId)
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return "# Session Diff\n\n> The active chat could not be found."
  }

  const diffs = await loadThreadDiffs(threadId)
  return buildThreadDiffMarkdown(thread, diffs, {
    full: args.includes("--full"),
  })
}

export async function buildVcsOutput(
  command: string,
  args: readonly string[],
  activeThread: ActiveThreadRef
): Promise<string> {
  const cwd = resolveThreadRuntimePath(activeThread)
  if (!cwd) {
    return [
      "# VCS",
      "",
      "> Open a workspace folder before running BetterC0de-compatible VCS commands.",
    ].join("\n")
  }

  const request = resolveVcsRequest(command, args)
  if (request.mode === "apply") {
    return buildVcsApplyOutput(cwd, args)
  }
  if (request.mode === "status") {
    try {
      const status = await gitStatus(cwd)
      return buildVcsStatusOutput(cwd, status)
    } catch (error) {
      return [
        "# VCS Status",
        "",
        "Compatibility reference: `vcs.status`.",
        "",
        `Workspace: ${formatDebugPathCell(cwd)}`,
        "",
        `> Failed to read VCS status: ${escapeMarkdownTableCell(errorMessage(error))}`,
      ].join("\n")
    }
  }

  try {
    const diff = request.staged ? await gitDiffStaged(cwd) : await gitDiff(cwd)
    return buildVcsDiffOutput(cwd, diff.diff, request)
  } catch (error) {
    return [
      request.raw ? "# VCS Diff Raw" : "# VCS Diff",
      "",
      `Compatibility reference: \`${request.raw ? "vcs.diff.raw" : "vcs.diff"}\`.`,
      "",
      `Workspace: ${formatDebugPathCell(cwd)}`,
      "",
      `> Failed to read VCS diff: ${escapeMarkdownTableCell(errorMessage(error))}`,
    ].join("\n")
  }
}

function resolveVcsRequest(
  command: string,
  args: readonly string[]
): { mode: "status" | "diff" | "apply"; raw: boolean; staged: boolean } {
  const normalized = command.toLowerCase().replace(/^\//, "")
  const lowerArgs = args.map((arg) => arg.toLowerCase())
  const first = lowerArgs[0]
  const explicitApply = isVcsApplyCommand(command, args)
  const explicitDiff =
    normalized === "vcs.diff" || normalized === "vcs-diff" || first === "diff"
  const explicitRaw =
    normalized === "vcs.diff.raw" ||
    normalized === "vcs-diff-raw" ||
    lowerArgs.includes("raw") ||
    lowerArgs.includes("--raw")
  const explicitStatus =
    normalized === "vcs.status" ||
    normalized === "vcs-status" ||
    first === "status"
  return {
    mode: explicitApply
      ? "apply"
      : explicitDiff || explicitRaw
        ? "diff"
        : explicitStatus
          ? "status"
          : "status",
    raw: explicitRaw,
    staged: lowerArgs.includes("--staged") || lowerArgs.includes("--cached"),
  }
}

export function isVcsApplyCommand(
  command: string,
  args: readonly string[]
): boolean {
  const normalized = command.toLowerCase().replace(/^\//, "")
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.toLowerCase()
  return (
    normalized === "vcs.apply" ||
    normalized === "vcs-apply" ||
    first === "apply"
  )
}

export function buildVcsApplyTerminalCommand(args: readonly string[]): {
  command: string
  shouldOpen: boolean
} {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args).filter(
    (arg, index) => !(index === 0 && arg.toLowerCase() === "apply")
  )
  return {
    command: ["git apply", stringifyCliArgs(cleanArgs)]
      .filter(Boolean)
      .join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

export function buildVcsApplyOutput(
  cwd: string,
  args: readonly string[]
): string {
  const terminalCommand = buildVcsApplyTerminalCommand(args)
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args).filter(
    (arg, index) => !(index === 0 && arg.toLowerCase() === "apply")
  )
  return [
    "# VCS Apply",
    "",
    "Compatibility reference: `vcs.apply` / `POST /vcs/apply`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    "",
    cleanArgs.length > 0
      ? `Terminal handoff: \`${terminalCommand.command}\``
      : "Terminal handoff: `git apply <patch-file>`",
    "",
    "> BetterC0de does not apply raw patches directly from chat. Use the diff/editor UI for reviewed changes, or add `--terminal` to open the integrated terminal with the explicit `git apply` command prefilled.",
    terminalCommand.shouldOpen
      ? "> Opened the terminal panel with this VCS apply command prefilled. Press Enter there to run it intentionally."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildVcsStatusOutput(
  cwd: string,
  // Accepts the typed wire shape and stays defensive for the untyped
  // records the tests feed in (malformed-response coverage).
  status: GitStatus | Record<string, unknown>
): string {
  const branch = typeof status.branch === "string" ? status.branch : ""
  const staged = readDebugStatusFileList(status.staged)
  const modified = readDebugStatusFileList(status.modified)
  const untracked = readDebugStatusFileList(status.untracked)
  const changed = [
    ...staged.map((file) => ({ state: "staged", file })),
    ...modified.map((file) => ({ state: "modified", file })),
    ...untracked.map((file) => ({ state: "untracked", file })),
  ]

  return [
    "# VCS Status",
    "",
    "Compatibility reference: `vcs.status`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Branch | ${escapeMarkdownTableCell(branch || "-")} |`,
    `| Clean | ${status.is_clean === true ? "yes" : "no"} |`,
    `| Staged | ${staged.length.toLocaleString()} |`,
    `| Modified | ${modified.length.toLocaleString()} |`,
    `| Untracked | ${untracked.length.toLocaleString()} |`,
    typeof status.ahead === "number"
      ? `| Ahead | ${status.ahead.toLocaleString()} |`
      : "",
    typeof status.behind === "number"
      ? `| Behind | ${status.behind.toLocaleString()} |`
      : "",
    typeof status.upstream === "string" && status.upstream
      ? `| Upstream | ${escapeMarkdownTableCell(status.upstream)} |`
      : "",
    "",
    changed.length > 0
      ? [
          "| # | Status | File |",
          "|:--|:-------|:-----|",
          ...changed.map(
            (entry, index) =>
              `| ${index + 1} | ${entry.state} | \`${escapeMarkdownTableCell(escapeInlineCode(entry.file))}\` |`
          ),
        ].join("\n")
      : "> Working tree is clean.",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildVcsDiffOutput(
  cwd: string,
  diffText: string,
  request: { raw: boolean; staged: boolean }
): string {
  const stats = countUnifiedDiffStats(diffText)
  const title = request.raw ? "# VCS Diff Raw" : "# VCS Diff"
  const equivalent = request.raw ? "vcs.diff.raw" : "vcs.diff"
  const visibleDiff = truncateDiffPreview(diffText.trim())
  return [
    title,
    "",
    `Compatibility reference: \`${equivalent}\`.`,
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    `Source: ${request.staged ? "staged changes" : "working tree changes"}`,
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Files changed | ${stats.filesChanged.toLocaleString()} |`,
    `| Insertions | ${stats.insertions.toLocaleString()} |`,
    `| Deletions | ${stats.deletions.toLocaleString()} |`,
    "",
    visibleDiff
      ? ["```diff", visibleDiff, "```"].join("\n")
      : "> No diff output for the selected source.",
  ].join("\n")
}

type FindMode = "text" | "file" | "symbol"

export async function buildFindOutput(
  command: string,
  args: readonly string[],
  activeThread: ActiveThreadRef
): Promise<string> {
  const cwd = resolveThreadRuntimePath(activeThread)
  if (!cwd) {
    return [
      "# Find",
      "",
      "> Open a workspace folder before running BetterC0de-compatible find commands.",
    ].join("\n")
  }

  const request = resolveFindRequest(command, args)
  const query = request.args.join(" ").trim()
  if (!query) return buildFindUsageOutput(request.mode)

  if (request.mode === "file") {
    const files = await quickOpenFiles(cwd, query, request.limit)
    return buildFindFilesOutput(cwd, query, files)
  }

  if (request.mode === "symbol") {
    return buildFindSymbolsOutput(cwd, query)
  }

  const search = await searchContentDetailed(cwd, query, {
    limit: request.limit,
  })
  return buildFindTextOutput(cwd, query, search.results, search)
}

function resolveFindRequest(
  command: string,
  args: readonly string[]
): { mode: FindMode; args: string[]; limit: number } {
  const parsed = extractDebugRgOptions(args)
  const normalized = command.toLowerCase().replace(/^\//, "")
  const commandMode = findModeFromToken(normalized)
  const first = parsed.args[0]?.toLowerCase()
  const argMode = findModeFromToken(first ?? "")
  return {
    mode: commandMode ?? argMode ?? "text",
    args: argMode ? parsed.args.slice(1) : parsed.args,
    limit: parsed.limit,
  }
}

function findModeFromToken(value: string): FindMode | null {
  switch (value) {
    case "find.text":
    case "find-text":
    case "text":
    case "search":
    case "grep":
      return "text"
    case "find.file":
    case "find-file":
    case "find.files":
    case "find-files":
    case "file":
    case "files":
      return "file"
    case "find.symbol":
    case "find-symbol":
    case "find.symbols":
    case "find-symbols":
    case "symbol":
    case "symbols":
      return "symbol"
    default:
      return null
  }
}

function buildFindUsageOutput(mode: FindMode): string {
  const command =
    mode === "file"
      ? "/find.file <query>"
      : mode === "symbol"
        ? "/find.symbol <query>"
        : "/find <pattern>"
  const equivalent =
    mode === "file"
      ? "find.files"
      : mode === "symbol"
        ? "find.symbols"
        : "find.text"
  return [
    `# ${findHeading(mode)}`,
    "",
    `Compatibility reference: \`${equivalent}\`.`,
    "",
    `> Provide a query, for example \`${command}\`.`,
  ].join("\n")
}

export function buildFindTextOutput(
  cwd: string,
  query: string,
  results: ReadonlyArray<WorkspaceContentSearchResult>,
  truncation?: SearchOutputTruncation
): string {
  const rows = results
    .flatMap((result) =>
      result.matches.slice(0, 3).map((match) => ({
        path: result.path,
        line: match.line,
        column: match.column,
        preview: match.preview.trim(),
      }))
    )
    .slice(0, 80)

  const body = [
    "# Find Text",
    "",
    "Compatibility reference: `find.text`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    `Pattern: \`${escapeInlineCode(query)}\``,
    "",
    rows.length > 0
      ? [
          "| # | Location | Preview |",
          "|:--|:---------|:--------|",
          ...rows.map(
            (row, index) =>
              `| ${index + 1} | \`${escapeMarkdownTableCell(escapeInlineCode(`${row.path}:${row.line}:${row.column}`))}\` | ${escapeMarkdownTableCell(row.preview)} |`
          ),
        ].join("\n")
      : "> No text matches found.",
  ].join("\n")
  return withSearchTruncationNote(
    body,
    truncation,
    "narrow the query to see the rest"
  )
}

export function buildFindFilesOutput(
  cwd: string,
  query: string,
  files: ReadonlyArray<WorkspaceQuickOpenFile>
): string {
  return [
    "# Find Files",
    "",
    "Compatibility reference: `find.files`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    `Query: \`${escapeInlineCode(query)}\``,
    "",
    files.length > 0
      ? [
          "| # | File |",
          "|:--|:-----|",
          ...files
            .slice(0, 80)
            .map(
              (file, index) =>
                `| ${index + 1} | \`${escapeMarkdownTableCell(escapeInlineCode(file.path))}\` |`
            ),
        ].join("\n")
      : "> No files matched.",
  ].join("\n")
}

function buildFindSymbolsOutput(cwd: string, query: string): string {
  const tabs = useEditorStore.getState().tabs
  const sources = buildOpenEditorWorkspaceSymbolSourcesFromTabs({
    projectPath: cwd,
    tabs,
  }).sources
  const symbols = buildWorkspaceSymbols(sources, query)
  return [
    "# Find Symbols",
    "",
    "Compatibility reference: `find.symbols`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    `Query: \`${escapeInlineCode(query)}\``,
    "",
    sources.length === 0
      ? "> No open editor tabs are available for BetterC0de's local symbol index."
      : symbols.length > 0
        ? [
            "| # | Symbol | Kind | Location | Detail |",
            "|:--|:-------|:-----|:---------|:-------|",
            ...symbols
              .slice(0, 80)
              .map(
                (symbol, index) =>
                  `| ${index + 1} | **${escapeMarkdownTableCell(symbol.name)}** | ${escapeMarkdownTableCell(symbol.kind)} | \`${escapeMarkdownTableCell(`${symbol.relativePath}:${symbol.line}:${symbol.column}`)}\` | ${escapeMarkdownTableCell(symbol.detail ?? "-")} |`
              ),
          ].join("\n")
        : "> No open-editor symbols matched.",
  ].join("\n")
}

function findHeading(mode: FindMode): string {
  if (mode === "file") return "Find Files"
  if (mode === "symbol") return "Find Symbols"
  return "Find Text"
}
