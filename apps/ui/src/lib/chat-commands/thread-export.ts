import { copyText } from "@/lib/clipboard"
import { betterC0deShareModeFromProjectSettings } from "@/lib/betterc0de-share-policy"
import {
  useChatStore,
  type ChatMessage,
  type ChatThread,
} from "@/lib/chat-store"
import { stringifyCliArgs } from "@/lib/cli-parse"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { buildThreadShareMarkdown, markThreadShared } from "@/lib/thread-share"
import {
  listProjectConfigSettings,
  readFile,
  writeFile,
} from "@/services/backend/workspaceApi"
import { loadThreadDiffs } from "@/services/backend/coreApi"
import { errorMessage } from "./input-context"
import {
  buildMcpTerminalSection,
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  type ActiveThreadRef,
} from "./provider-config"
import { formatSessionTime } from "./session-commands"

export async function buildShareThreadOutput(
  threadId: string | null
): Promise<string> {
  if (!threadId) {
    return "# Share Session\n\n> No active chat to share yet."
  }

  const store = useChatStore.getState()
  await store.ensureFullThreadMessages(threadId)
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return "# Share Session\n\n> The active chat could not be found."
  }

  const shareMode = await resolveBetterC0deShareModeForThread(thread)
  if (shareMode === "disabled") {
    return [
      "# Share Session\n",
      "> Sharing is disabled by this workspace's BetterC0de compatibility config.",
      "",
      "Set `share` to `manual` or `auto` in `betterc0de.json(c)` to allow `/share`.",
    ].join("\n")
  }

  const transcript = buildThreadShareMarkdown(thread)
  const hasUsefulContent = thread.messages.some(
    (message) =>
      message.content.trim() ||
      message.reasoning?.trim() ||
      message.toolCalls?.length ||
      message.diffs?.length
  )
  if (!hasUsefulContent) {
    return "# Share Session\n\n> This chat has no useful content to export yet."
  }

  const copied = await copyTextToClipboard(transcript)
  const record = markThreadShared({
    threadId,
    title: thread.title,
    messageCount: thread.messages.length,
    transcript,
  })

  return [
    "# Share Session\n",
    copied
      ? "Copied a local markdown export of this chat to the clipboard."
      : "Created a local share marker, but clipboard copy was unavailable.",
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| **Thread** | \`${threadId.slice(0, 8)}\` |`,
    `| **Messages** | ${record.messageCount} |`,
    `| **Fingerprint** | \`${record.transcriptFingerprint}\` |`,
    "",
    "> This is a local export, not a public cloud URL. Use `/unshare` to remove the local share marker.",
  ].join("\n")
}

export function buildBetterC0deSessionIoTerminalCommand(
  mode: "export" | "import",
  args: readonly string[]
): { command: string; shouldOpen: boolean } {
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  return {
    command: ["betterc0de", mode, stringifyCliArgs(cleanArgs)]
      .filter(Boolean)
      .join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

export async function buildExportThreadOutput(
  threadId: string | null,
  args: readonly string[],
  options: { betterC0deMode?: boolean } = {}
): Promise<string> {
  const terminalCommand = buildBetterC0deSessionIoTerminalCommand(
    "export",
    args
  )
  if (terminalCommand.shouldOpen) {
    return [
      "# Export Session",
      "",
      "Compatibility reference: `betterc0de export [sessionID]`.",
      "",
      buildMcpTerminalSection(terminalCommand.command),
      "",
      "> Opened the terminal panel with this BetterC0de export command prefilled. BetterC0de did not write a local export file in terminal mode.",
    ].join("\n")
  }

  const exportOptions = parseThreadExportArgs(args, {
    defaultFormat: options.betterC0deMode ? "json" : "markdown",
    positionalMode: options.betterC0deMode ? "sessionId" : "filename",
  })
  const targetThreadId = exportOptions.sessionId || threadId
  const loaded = await loadThreadTranscript(targetThreadId, "Export Session")
  if (typeof loaded === "string") return loaded

  const runtimePath = resolveThreadRuntimePath(loaded.thread)
  if (!runtimePath) {
    return "# Export Session\n\n> Open a workspace folder before exporting a transcript file."
  }

  const relativePath =
    exportOptions.format === "json"
      ? sanitizeJsonExportFilename(
          exportOptions.filename ||
            `betterc0de-session-${loaded.thread.id.slice(0, 8)}.json`
        )
      : sanitizeTranscriptExportFilename(
          exportOptions.filename ||
            `betterc0de-session-${loaded.thread.id.slice(0, 8)}.md`
        )
  const content =
    exportOptions.format === "json"
      ? JSON.stringify(
          buildThreadJsonExportPayload(loaded.thread, {
            sanitize: exportOptions.sanitize,
          }),
          null,
          2
        )
      : loaded.transcript
  await writeFile(runtimePath, relativePath, content)

  return [
    "# Export Session\n",
    exportOptions.format === "json"
      ? `Exported this chat as BetterC0de-compatible JSON to \`${relativePath}\`.`
      : `Exported this chat transcript to \`${relativePath}\`.`,
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| **Thread** | \`${loaded.thread.id.slice(0, 8)}\` |`,
    `| **Messages** | ${loaded.thread.messages.length} |`,
    `| **Format** | ${exportOptions.format === "json" ? "JSON" : "Markdown"} |`,
    exportOptions.format === "json"
      ? `| **Sanitized** | ${exportOptions.sanitize ? "Yes" : "No"} |`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export async function buildImportThreadOutput(
  args: readonly string[],
  activeThread: ActiveThreadRef
): Promise<string> {
  const terminalCommand = buildBetterC0deSessionIoTerminalCommand(
    "import",
    args
  )
  if (terminalCommand.shouldOpen) {
    return [
      "# Import Session",
      "",
      "Compatibility reference: `betterc0de import <file-or-share-url>`.",
      "",
      buildMcpTerminalSection(terminalCommand.command),
      "",
      "> Opened the terminal panel with this BetterC0de import command prefilled. BetterC0de did not import or mutate chat history in terminal mode.",
    ].join("\n")
  }

  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Import Session\n\n> Open a workspace folder before importing a session file."
  }

  const requestedPath = args
    .filter((arg) => !arg.startsWith("--"))
    .join(" ")
    .trim()
  if (!requestedPath) {
    return [
      "# Import Session",
      "",
      "Compatibility reference: `betterc0de import <file-or-share-url>`.",
      "",
      "> Usage: `/import <file.json|https://.../share/...|https://.../s/...>`",
    ].join("\n")
  }

  let parsed: unknown
  try {
    parsed = isHttpUrl(requestedPath)
      ? await fetchBetterC0deImportPayload(requestedPath)
      : JSON.parse((await readFile(`${runtimePath}/${requestedPath}`)).content)
  } catch (err) {
    return `# Import Session\n\n> Failed to import \`${escapeMarkdownTableCell(requestedPath)}\`: ${escapeMarkdownTableCell(errorMessage(err))}`
  }

  const imported = buildThreadImportDraftFromJsonPayload(parsed, {
    idPrefix: `import-${Date.now().toString(36)}`,
    projectName: "Imported",
    projectPath: runtimePath,
  })
  if (!imported || imported.messages.length === 0) {
    return [
      "# Import Session",
      "",
      "> No supported session messages found.",
      "",
      "Expected a BetterC0de JSON export (`{ info, messages }`), an BetterC0de-compatible session export (`{ info, messages: [{ info, parts }] }`), or BetterC0de share API data (`[{ type, data }]`).",
    ].join("\n")
  }

  const store = useChatStore.getState()
  const newThreadId = store.createThread(
    imported.title,
    imported.projectName,
    imported.projectPath
  )
  for (const message of imported.messages) {
    store.addMessage(newThreadId, message)
  }
  store.updateThreadTitle(newThreadId, imported.title)
  store.setActiveThread(newThreadId)

  return [
    "# Import Session",
    "",
    `Imported \`${escapeMarkdownTableCell(requestedPath)}\` into a new chat.`,
    "",
    "Compatibility reference: `betterc0de import <file-or-share-url>`.",
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| **Thread** | \`${newThreadId.slice(0, 8)}\` |`,
    `| **Title** | ${escapeMarkdownTableCell(imported.title)} |`,
    `| **Messages** | ${imported.messages.length} |`,
  ].join("\n")
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

async function fetchBetterC0deImportPayload(
  inputUrl: string
): Promise<unknown> {
  const candidates = betterC0deImportUrlCandidates(inputUrl)
  const errors: string[] = []

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate)
      if (!response.ok) {
        errors.push(`${candidate}: ${response.status} ${response.statusText}`)
        continue
      }
      return await response.json()
    } catch (err) {
      errors.push(`${candidate}: ${errorMessage(err)}`)
    }
  }

  throw new Error(errors.join("; ") || "Unable to fetch import URL")
}

export function betterC0deImportUrlCandidates(inputUrl: string): string[] {
  const out = [inputUrl]
  try {
    const url = new URL(inputUrl)
    const parts = url.pathname.split("/").filter(Boolean)
    const shareIndex = parts.findIndex(
      (part) => part === "share" || part === "s"
    )
    const slug = shareIndex >= 0 ? parts[shareIndex + 1] : undefined
    if (slug) {
      out.push(`${url.origin}/api/share/${encodeURIComponent(slug)}/data`)
      out.push(`${url.origin}/api/shares/${encodeURIComponent(slug)}/data`)
    }
  } catch {
    // The caller already validated this as http(s); keep the original URL only.
  }
  return [...new Set(out)]
}

type ThreadDiffBundle = Awaited<ReturnType<typeof loadThreadDiffs>>

export function buildThreadDiffMarkdown(
  thread: ChatThread,
  diffs: ThreadDiffBundle,
  options: { full?: boolean } = {}
): string {
  const messageDiffRows = thread.messages.flatMap((message, messageIndex) =>
    (message.diffs ?? []).map((diff) => ({
      ordinal: messageIndex + 1,
      ...diff,
    }))
  )
  const checkpointStats = diffs.checkpointDiffs.map((diff) => ({
    ...diff,
    stats: countUnifiedDiffStats(diff.diffContent),
  }))
  const totalFiles =
    diffs.turnDiffs.reduce((sum, diff) => sum + diff.filesChanged, 0) +
    checkpointStats.reduce((sum, diff) => sum + diff.stats.filesChanged, 0) +
    messageDiffRows.length
  const totalInsertions =
    diffs.turnDiffs.reduce((sum, diff) => sum + diff.insertions, 0) +
    checkpointStats.reduce((sum, diff) => sum + diff.stats.insertions, 0) +
    messageDiffRows.reduce((sum, diff) => sum + diff.additions, 0)
  const totalDeletions =
    diffs.turnDiffs.reduce((sum, diff) => sum + diff.deletions, 0) +
    checkpointStats.reduce((sum, diff) => sum + diff.stats.deletions, 0) +
    messageDiffRows.reduce((sum, diff) => sum + diff.deletions, 0)

  if (
    diffs.turnDiffs.length === 0 &&
    diffs.checkpointDiffs.length === 0 &&
    messageDiffRows.length === 0
  ) {
    return "# Session Diff\n\n> No diff data is available for this chat yet."
  }

  const sections = [
    "# Session Diff\n",
    "Compatibility reference: `session.diff`.",
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| Thread | \`${escapeMarkdownTableCell(thread.id.slice(0, 8))}\` ${escapeMarkdownTableCell(thread.title || "Untitled")} |`,
    `| Turn diffs | ${diffs.turnDiffs.length} |`,
    `| Checkpoint diffs | ${diffs.checkpointDiffs.length} |`,
    `| Message diffs | ${messageDiffRows.length} |`,
    `| Files changed | ${totalFiles} |`,
    `| Insertions / deletions | +${totalInsertions} / -${totalDeletions} |`,
  ]

  if (diffs.turnDiffs.length > 0) {
    sections.push(
      "",
      "## Turn Diffs\n",
      "| Turn | Files | + | - | Created |",
      "|:-----|:------|:--|:--|:--------|",
      ...diffs.turnDiffs.map(
        (diff) =>
          `| ${diff.turnIndex} | ${diff.filesChanged} | ${diff.insertions} | ${diff.deletions} | ${formatSessionTime(diff.createdAt)} |`
      )
    )
  }

  if (checkpointStats.length > 0) {
    sections.push(
      "",
      "## Checkpoint Diffs\n",
      "| Checkpoint | Files | + | - | Created |",
      "|:-----------|:------|:--|:--|:--------|",
      ...checkpointStats.map(
        (diff) =>
          `| \`${escapeMarkdownTableCell(shortCheckpointRef(diff.checkpointRef))}\` | ${diff.stats.filesChanged} | ${diff.stats.insertions} | ${diff.stats.deletions} | ${formatSessionTime(diff.createdAt)} |`
      )
    )
  }

  if (messageDiffRows.length > 0) {
    sections.push(
      "",
      "## Message Diffs\n",
      "| Message | File | + | - | Type |",
      "|:--------|:-----|:--|:--|:-----|",
      ...messageDiffRows.map(
        (diff) =>
          `| ${diff.ordinal} | \`${escapeMarkdownTableCell(diff.path)}\` | ${diff.additions} | ${diff.deletions} | ${diff.isNew ? "New" : "Modified"} |`
      )
    )
  }

  if (options.full) {
    const previews = [
      ...diffs.turnDiffs.map((diff) => ({
        title: `Turn ${diff.turnIndex}`,
        text: diff.diffText,
      })),
      ...diffs.checkpointDiffs.map((diff) => ({
        title: `Checkpoint ${shortCheckpointRef(diff.checkpointRef)}`,
        text: diff.diffContent,
      })),
    ].filter((item) => item.text.trim())

    if (previews.length > 0) {
      sections.push("", "## Diff Preview")
      for (const preview of previews.slice(0, 8)) {
        sections.push(
          "",
          `### ${preview.title}`,
          "",
          "```diff",
          truncateDiffPreview(preview.text),
          "```"
        )
      }
    }
  } else {
    sections.push("", "> Use `/diff --full` to include diff previews.")
  }

  return sections.join("\n")
}

export function buildDebugSnapshotMarkdown(
  threadId: string,
  diffs: ThreadDiffBundle,
  command = "/debug-snapshot",
  args: readonly string[] = []
): string {
  const request = resolveDebugSnapshotRequest(command, args)
  const snapshots = diffs.checkpointDiffs.map((diff) => ({
    ...diff,
    shortRef: shortCheckpointRef(diff.checkpointRef),
    stats: countUnifiedDiffStats(diff.diffContent),
  }))

  if (request.mode === "patch" || request.mode === "diff") {
    if (!request.target) {
      return [
        "# Debug Snapshot",
        "",
        `Compatibility reference: \`betterc0de debug snapshot ${request.mode} <hash>\`.`,
        "",
        "> Provide a checkpoint ref/hash, for example `/debug-snapshot diff turn/3`.",
      ].join("\n")
    }
    const matched = snapshots.find((snapshot) =>
      [snapshot.shortRef, snapshot.checkpointRef, String(snapshot.id)].some(
        (value) => value === request.target || value.includes(request.target!)
      )
    )
    if (!matched) {
      return [
        "# Debug Snapshot",
        "",
        `Compatibility reference: \`betterc0de debug snapshot ${request.mode} <hash>\`.`,
        "",
        `> No BetterC0de checkpoint matched \`${escapeInlineCode(request.target)}\`.`,
        "",
        snapshots.length > 0
          ? `Known checkpoints: ${snapshots.map((item) => `\`${escapeInlineCode(item.shortRef)}\``).join(", ")}`
          : "No checkpoints are available for this chat yet.",
      ].join("\n")
    }

    return [
      "# Debug Snapshot",
      "",
      `Compatibility reference: \`betterc0de debug snapshot ${request.mode} <hash>\`.`,
      "",
      "| Field | Value |",
      "|:------|:------|",
      `| Thread | \`${escapeMarkdownTableCell(threadId.slice(0, 8))}\` |`,
      `| Checkpoint | \`${escapeMarkdownTableCell(matched.shortRef)}\` |`,
      `| Ref | \`${escapeMarkdownTableCell(matched.checkpointRef)}\` |`,
      `| Files / + / - | ${matched.stats.filesChanged} / ${matched.stats.insertions} / ${matched.stats.deletions} |`,
      `| Created | ${formatSessionTime(matched.createdAt)} |`,
      "",
      "```diff",
      truncateDiffPreview(matched.diffContent || "(empty diff)"),
      "```",
      "",
      "> BetterC0de maps BetterC0de snapshot debugging to its git-backed checkpoint diffs. BetterC0de snapshot hashes and BetterC0de checkpoint refs are not identical.",
    ].join("\n")
  }

  return [
    "# Debug Snapshot",
    "",
    "Compatibility reference: `betterc0de debug snapshot track`.",
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Thread | \`${escapeMarkdownTableCell(threadId.slice(0, 8))}\` |`,
    `| Turn diffs | ${diffs.turnDiffs.length} |`,
    `| Checkpoint diffs | ${snapshots.length} |`,
    "",
    snapshots.length > 0
      ? [
          "| Checkpoint | Files | + | - | Created | Ref |",
          "|:-----------|:------|:--|:--|:--------|:----|",
          ...snapshots.map(
            (snapshot) =>
              `| \`${escapeMarkdownTableCell(snapshot.shortRef)}\` | ${snapshot.stats.filesChanged} | ${snapshot.stats.insertions} | ${snapshot.stats.deletions} | ${formatSessionTime(snapshot.createdAt)} | \`${escapeMarkdownTableCell(snapshot.checkpointRef)}\` |`
          ),
        ].join("\n")
      : "> No checkpoints are available for this chat yet.",
    "",
    "> Use `/debug-snapshot diff <checkpoint>` or `/debug-snapshot patch <checkpoint>` to inspect a stored checkpoint diff.",
  ].join("\n")
}

function resolveDebugSnapshotRequest(
  command: string,
  args: readonly string[]
): { mode: "track" | "patch" | "diff"; target?: string } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const commandMode = normalized.includes("patch")
    ? "patch"
    : normalized.includes("diff")
      ? "diff"
      : normalized.includes("track")
        ? "track"
        : null
  const [head, ...rest] = args
  const argMode =
    head === "patch" || head === "diff" || head === "track" ? head : null
  const mode = commandMode ?? argMode ?? "track"
  const targetArgs = argMode ? rest : args
  return {
    mode,
    target: targetArgs.join(" ").trim() || undefined,
  }
}

export function countUnifiedDiffStats(text: string): {
  filesChanged: number
  insertions: number
  deletions: number
} {
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) filesChanged += 1
    if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { filesChanged, insertions, deletions }
}

function shortCheckpointRef(value: string): string {
  const parts = value.split("/").filter(Boolean)
  return parts.at(-1) ?? value
}

export function truncateDiffPreview(value: string): string {
  return value.length > 8_000 ? `${value.slice(0, 8_000)}\n...` : value
}

export async function loadThreadTranscript(
  threadId: string | null,
  heading: string
): Promise<{ thread: ChatThread; transcript: string } | string> {
  if (!threadId) return `# ${heading}\n\n> No active chat is selected.`

  const store = useChatStore.getState()
  await store.ensureFullThreadMessages(threadId)
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) return `# ${heading}\n\n> The active chat could not be found.`

  const hasUsefulContent = thread.messages.some(
    (message) =>
      message.content.trim() ||
      message.reasoning?.trim() ||
      message.toolCalls?.length ||
      message.diffs?.length
  )
  if (!hasUsefulContent) {
    return `# ${heading}\n\n> This chat has no useful content to export yet.`
  }

  return { thread, transcript: buildThreadShareMarkdown(thread) }
}

function sanitizeTranscriptExportFilename(input: string): string {
  const basename = input
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.trim()
  const safe = (basename || "betterc0de-session.md")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const withExtension = safe.toLowerCase().endsWith(".md") ? safe : `${safe}.md`
  return withExtension || "betterc0de-session.md"
}

function sanitizeJsonExportFilename(input: string): string {
  const basename = input
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.trim()
  const safe = (basename || "betterc0de-session.json")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const withExtension = safe.toLowerCase().endsWith(".json")
    ? safe
    : `${safe}.json`
  return withExtension || "betterc0de-session.json"
}

interface ThreadExportOptions {
  format: "markdown" | "json"
  sanitize: boolean
  filename: string
  sessionId: string
}

function parseThreadExportArgs(
  args: readonly string[],
  options: {
    defaultFormat?: ThreadExportOptions["format"]
    positionalMode?: "filename" | "sessionId"
  } = {}
): ThreadExportOptions {
  const filenameParts: string[] = []
  const positionalMode = options.positionalMode ?? "filename"
  let format: ThreadExportOptions["format"] =
    options.defaultFormat ?? "markdown"
  let sessionId = ""
  let sanitize = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (arg === "--json" || arg === "--format=json") {
      format = "json"
      continue
    }
    if (arg === "--markdown" || arg === "--format=markdown") {
      format = "markdown"
      continue
    }
    if (arg === "--format") {
      const next = args[index + 1]?.toLowerCase()
      if (next === "json" || next === "markdown") {
        format = next
        index += 1
      }
      continue
    }
    if (arg === "--sanitize" || arg === "--redact") {
      sanitize = true
      continue
    }
    if (arg === "--output" || arg === "--file" || arg === "-o") {
      const next = args[index + 1]
      if (next) {
        filenameParts.push(next)
        index += 1
      }
      continue
    }
    if (positionalMode === "sessionId" && !sessionId && !arg.startsWith("-")) {
      sessionId = arg
      continue
    }
    filenameParts.push(arg)
  }
  const filename = filenameParts.join(" ").trim()
  if (filename.toLowerCase().endsWith(".json")) format = "json"
  if (filename.toLowerCase().endsWith(".md")) format = "markdown"
  return { format, sanitize, filename, sessionId }
}

export function buildThreadJsonExportPayload(
  thread: ChatThread,
  options: { sanitize?: boolean } = {}
): Record<string, unknown> {
  const sanitize = options.sanitize ?? false
  return {
    info: {
      id: thread.id,
      title: sanitize ? redactExportText("title", thread.id) : thread.title,
      projectName: thread.projectName,
      projectPath: sanitize
        ? redactExportText("project-path", thread.id)
        : thread.projectPath,
      envMode: thread.envMode ?? null,
      branch: thread.branch ?? null,
      worktreePath: sanitize
        ? redactNullableExportText(
            "worktree-path",
            thread.id,
            thread.worktreePath
          )
        : (thread.worktreePath ?? null),
      baseBranch: thread.baseBranch ?? null,
      worktreeState: thread.worktreeState ?? null,
      parentThreadId: thread.parentThreadId ?? null,
      codexThreadId: thread.codexThreadId ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      session: thread.session ?? null,
      usage: thread.usage ?? null,
    },
    messages: thread.messages.map((message) =>
      sanitize ? sanitizeMessageForJsonExport(message) : message
    ),
  }
}

export interface ThreadImportDraft {
  title: string
  projectName: string
  projectPath: string
  messages: ChatMessage[]
}

export function buildThreadImportDraftFromJsonPayload(
  input: unknown,
  defaults: {
    idPrefix?: string
    projectName?: string
    projectPath?: string
    now?: string
  } = {}
): ThreadImportDraft | null {
  const root = importRecord(normalizeBetterC0deImportPayload(input))
  const info = importRecord(root.info)
  const rawMessages = Array.isArray(root.messages) ? root.messages : []
  if (rawMessages.length === 0) return null

  const idPrefix = defaults.idPrefix ?? `import-${Date.now().toString(36)}`
  const now = defaults.now ?? new Date().toISOString()
  const messages = rawMessages
    .map((message, index) =>
      importMessageFromJsonPayload(message, {
        index,
        idPrefix,
        now,
      })
    )
    .filter((message): message is ChatMessage => Boolean(message))

  if (messages.length === 0) return null

  return {
    title:
      importString(info.title) ??
      importString(info.summary) ??
      "Imported Session",
    projectName:
      importString(info.projectName) ??
      importString(info.projectID) ??
      defaults.projectName ??
      "Imported",
    projectPath:
      importString(info.projectPath) ??
      importString(info.directory) ??
      defaults.projectPath ??
      "",
    messages,
  }
}

function normalizeBetterC0deImportPayload(input: unknown): unknown {
  return transformBetterC0deShareDataPayload(input) ?? input
}

function transformBetterC0deShareDataPayload(input: unknown): unknown | null {
  if (!Array.isArray(input)) return null

  const entries = input.map(importRecord)
  const sessionEntry = entries.find(
    (entry) => importString(entry.type) === "session"
  )
  const sessionInfo = importRecord(sessionEntry?.data)
  if (Object.keys(sessionInfo).length === 0) return null

  const partEntries = entries.filter(
    (entry) => importString(entry.type) === "part"
  )
  const partsByMessage = new Map<string, unknown[]>()
  for (const entry of partEntries) {
    const part = importRecord(entry.data)
    const messageId =
      importString(part.messageID) ??
      importString(part.messageId) ??
      importString(part.message_id)
    if (!messageId) continue
    const bucket = partsByMessage.get(messageId) ?? []
    bucket.push(part)
    partsByMessage.set(messageId, bucket)
  }

  const messages = entries
    .filter((entry) => importString(entry.type) === "message")
    .map((entry) => importRecord(entry.data))
    .map((message) => {
      const messageId =
        importString(message.id) ??
        importString(message.messageID) ??
        importString(message.messageId)
      return {
        info: message,
        parts: messageId ? (partsByMessage.get(messageId) ?? []) : [],
      }
    })

  return {
    info: sessionInfo,
    messages,
  }
}

function sanitizeMessageForJsonExport(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: redactExportText("message", message.id),
    reasoning: message.reasoning
      ? redactExportText("reasoning", message.id)
      : message.reasoning,
    toolCalls: message.toolCalls?.map((toolCall) => ({
      ...toolCall,
      input: redactExportValue("tool-input", toolCall.id),
      output:
        toolCall.output === undefined
          ? undefined
          : redactExportValue("tool-output", toolCall.id),
      outputPreview: toolCall.outputPreview
        ? redactExportText("tool-output-preview", toolCall.id)
        : toolCall.outputPreview,
      error: toolCall.error
        ? redactExportText("tool-error", toolCall.id)
        : toolCall.error,
    })),
    diffs: message.diffs?.map((diff, index) => ({
      ...diff,
      path: redactExportText("diff-path", `${message.id}-${index}`),
      oldText: redactExportText("diff-old", `${message.id}-${index}`),
      newText: redactExportText("diff-new", `${message.id}-${index}`),
    })),
    attachments: message.attachments?.map((attachment, index) => ({
      ...attachment,
      filename:
        "filename" in attachment && typeof attachment.filename === "string"
          ? redactExportText("attachment-name", `${message.id}-${index}`)
          : attachment.filename,
      url:
        "url" in attachment && typeof attachment.url === "string"
          ? redactExportText("attachment-url", `${message.id}-${index}`)
          : attachment.url,
    })),
  }
}

function redactNullableExportText(
  kind: string,
  id: string,
  value: string | null | undefined
): string | null {
  return value ? redactExportText(kind, id) : null
}

function redactExportText(kind: string, id: string): string {
  return `[redacted:${kind}:${id}]`
}

function redactExportValue(kind: string, id: string): Record<string, string> {
  return { redacted: `${kind}:${id}` }
}

function importMessageFromJsonPayload(
  input: unknown,
  options: { index: number; idPrefix: string; now: string }
): ChatMessage | null {
  const record = importRecord(input)
  if (record.info || record.parts) {
    return importBetterC0deSdkMessage(record, options)
  }
  return importBetterC0deMessage(record, options)
}

function importBetterC0deMessage(
  record: Record<string, unknown>,
  options: { index: number; idPrefix: string; now: string }
): ChatMessage | null {
  const role = importRole(record.role)
  if (!role) return null
  const id = `${options.idPrefix}-${options.index + 1}`
  const message: ChatMessage = {
    id,
    role,
    content: importString(record.content) ?? "",
    createdAt: importIsoDate(record.createdAt, options.now),
  }
  const turnId = importString(record.turnId)
  if (turnId) message.turnId = turnId
  const reasoning = importString(record.reasoning)
  if (reasoning) message.reasoning = reasoning
  const modelId = importString(record.modelId)
  if (modelId) message.modelId = modelId
  const usage = importRecordOrNull(record.usage)
  if (usage) message.usage = usage as ChatMessage["usage"]
  if (Array.isArray(record.toolCalls)) {
    message.toolCalls = record.toolCalls
      .map((toolCall, index) =>
        importToolCall(toolCall, `${id}-tool-${index + 1}`)
      )
      .filter(
        (toolCall): toolCall is NonNullable<ChatMessage["toolCalls"]>[number] =>
          Boolean(toolCall)
      )
  }
  if (Array.isArray(record.diffs)) {
    message.diffs = cloneImportJson(record.diffs) as ChatMessage["diffs"]
  }
  if (Array.isArray(record.attachments)) {
    message.attachments = cloneImportJson(
      record.attachments
    ) as ChatMessage["attachments"]
  }
  return message
}

function importBetterC0deSdkMessage(
  record: Record<string, unknown>,
  options: { index: number; idPrefix: string; now: string }
): ChatMessage | null {
  const info = importRecord(record.info)
  const parts = Array.isArray(record.parts)
    ? record.parts.map(importRecord)
    : []
  const role = importRole(info.role) ?? "assistant"
  const id = `${options.idPrefix}-${options.index + 1}`
  const text = parts
    .filter((part) => importString(part.type) === "text")
    .map((part) => importString(part.text) ?? importString(part.content) ?? "")
    .filter(Boolean)
    .join("\n\n")
  const reasoning = parts
    .filter((part) => importString(part.type) === "reasoning")
    .map((part) => importString(part.text) ?? "")
    .filter(Boolean)
    .join("\n\n")
  const message: ChatMessage = {
    id,
    role,
    content: text || importString(info.content) || "",
    createdAt: importIsoDate(
      importRecord(info.time).created ?? info.createdAt,
      options.now
    ),
  }
  const providerId =
    importString(info.providerID) ?? importString(info.providerId)
  const modelId = importString(info.modelID) ?? importString(info.modelId)
  if (providerId && modelId) message.modelId = `${providerId}/${modelId}`
  else if (modelId) message.modelId = modelId
  if (reasoning) message.reasoning = reasoning
  const usage = importBetterC0deUsage(importRecord(info.tokens))
  if (usage) message.usage = usage
  const toolCalls = parts
    .filter((part) => importString(part.type) === "tool")
    .map((part, index) =>
      importBetterC0deToolPart(part, `${id}-tool-${index + 1}`)
    )
    .filter(
      (toolCall): toolCall is NonNullable<ChatMessage["toolCalls"]>[number] =>
        Boolean(toolCall)
    )
  if (toolCalls.length > 0) message.toolCalls = toolCalls
  return message
}

function importToolCall(
  input: unknown,
  fallbackId: string
): NonNullable<ChatMessage["toolCalls"]>[number] | null {
  const record = importRecord(input)
  const name = importString(record.name)
  if (!name) return null
  const id = importString(record.id) ?? fallbackId
  return {
    id,
    name,
    input: record.input ?? {},
    output: record.output,
    state: importToolState(record.state, record.output),
  }
}

function importBetterC0deToolPart(
  part: Record<string, unknown>,
  fallbackId: string
): NonNullable<ChatMessage["toolCalls"]>[number] | null {
  const state = importRecord(part.state)
  const name =
    importString(part.tool) ??
    importString(part.name) ??
    importString(state.title) ??
    importString(part.id)
  if (!name) return null
  const id = importString(part.id) ?? fallbackId
  return {
    id,
    name,
    input: state.input ?? {},
    output: state.output,
    state: importToolState(state.status, state.output),
    outputPreview: importString(state.title) ?? undefined,
  }
}

function importBetterC0deUsage(
  tokens: Record<string, unknown>
): ChatMessage["usage"] | undefined {
  if (Object.keys(tokens).length === 0) return undefined
  const cache = importRecord(tokens.cache)
  return {
    inputTokens: importNumber(tokens.input) ?? 0,
    outputTokens: importNumber(tokens.output) ?? 0,
    reasoningOutputTokens: importNumber(tokens.reasoning) ?? 0,
    cachedInputTokens:
      (importNumber(cache.read) ?? 0) + (importNumber(cache.write) ?? 0),
  } as ChatMessage["usage"]
}

function importToolState(
  state: unknown,
  output: unknown
): NonNullable<ChatMessage["toolCalls"]>[number]["state"] {
  const value = importString(state)
  if (value === "error" || value === "failed") return "output-error"
  if (value === "completed" || value === "output-available") {
    return "output-available"
  }
  return output === undefined ? "input-available" : "output-available"
}

function importRole(value: unknown): ChatMessage["role"] | null {
  return value === "user" || value === "assistant" || value === "system"
    ? value
    : null
}

function importIsoDate(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return fallback
}

function importRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function importRecordOrNull(value: unknown): Record<string, unknown> | null {
  const record = importRecord(value)
  return Object.keys(record).length > 0 ? record : null
}

function importString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function importNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function cloneImportJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function resolveBetterC0deShareModeForThread(
  thread: ChatThread
): Promise<"manual" | "auto" | "disabled" | null> {
  const runtimePath = resolveThreadRuntimePath(thread)
  if (!runtimePath) return null
  try {
    return betterC0deShareModeFromProjectSettings(
      await listProjectConfigSettings(runtimePath)
    )
  } catch {
    return null
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  return copyText(text)
}
