import type {
  ChatThread,
  ThreadActivity,
  ThreadStreamState,
} from "@/lib/chat-store"
import { stripBetterC0deRuntimeUiFlags } from "./mcp-commands"
import { escapeMarkdownTableCell } from "./provider-config"
import { compareThreadActivities } from "./session-commands"

export interface BetterC0deSyncRouteSnapshot {
  threads: ReadonlyArray<ChatThread>
  activeThreadId: string | null
  activitiesByThread?: Record<string, ReadonlyArray<ThreadActivity>>
  streamingByThread?: Record<string, ThreadStreamState>
  activeThread?: {
    projectPath?: string | null
    worktreePath?: string | null
    envMode?: string | null
  } | null
}

export function buildBetterC0deSyncRouteOutput(
  command: string,
  args: ReadonlyArray<string>,
  snapshot: BetterC0deSyncRouteSnapshot
): string {
  const parsed = parseBetterC0deSyncRouteCommand(command, args)
  const route = parsed.route
  const routeArgs = parsed.args
  if (route === "sync.history.list") {
    return buildBetterC0deSyncHistoryOutput(routeArgs, snapshot)
  }
  if (route === "sync.start") {
    return buildBetterC0deSyncStartOutput(snapshot)
  }
  if (route === "sync.replay") {
    return buildBetterC0deSyncReplayOutput(routeArgs)
  }
  if (route === "sync.steal") {
    return buildBetterC0deSyncStealOutput(routeArgs, snapshot)
  }
  return [
    "# BetterC0de Sync",
    "",
    "Compatibility references: `sync.history.list`, `sync.start`, `sync.replay`, `sync.steal`.",
    "",
    "> Usage: `/betterc0de-sync history`, `/betterc0de-sync start`, `/betterc0de-sync replay { ... }`, or `/betterc0de-sync steal <sessionID>`.",
  ].join("\n")
}

export interface BetterC0deWorkspaceRouteSnapshot {
  threads: ReadonlyArray<ChatThread>
  activeThreadId: string | null
  activeThread?: {
    projectPath?: string | null
    worktreePath?: string | null
    envMode?: string | null
  } | null
}

export function buildBetterC0deWorkspaceRouteOutput(
  command: string,
  args: ReadonlyArray<string>,
  snapshot: BetterC0deWorkspaceRouteSnapshot
): string {
  const route = resolveBetterC0deWorkspaceRoute(command, args)
  if (route === "experimental.workspace.warp") {
    return buildBetterC0deWorkspaceWarpOutput(args, snapshot)
  }
  return buildBetterC0deWorkspaceSyncListOutput(snapshot)
}

type BetterC0deSyncRoute =
  | "sync.history.list"
  | "sync.start"
  | "sync.replay"
  | "sync.steal"
  | "sync"

function parseBetterC0deSyncRouteCommand(
  command: string,
  args: ReadonlyArray<string>
): { route: BetterC0deSyncRoute; args: string[] } {
  const normalized = command.replace(/^\//, "").replace(/-/g, ".")
  if (
    normalized === "sync.history.list" ||
    normalized === "sync.start" ||
    normalized === "sync.replay" ||
    normalized === "sync.steal"
  ) {
    return { route: normalized, args: [...args] }
  }

  const firstIndex = args.findIndex((arg) => arg && !arg.startsWith("--"))
  const first = firstIndex >= 0 ? args[firstIndex]!.toLowerCase() : ""
  const rest =
    firstIndex >= 0
      ? args.filter((_, index) => index !== firstIndex)
      : [...args]
  if (["history", "history.list", "list"].includes(first)) {
    return { route: "sync.history.list", args: rest }
  }
  if (first === "start") return { route: "sync.start", args: rest }
  if (first === "replay") return { route: "sync.replay", args: rest }
  if (first === "steal") return { route: "sync.steal", args: rest }
  return { route: "sync", args: [...args] }
}

function buildBetterC0deSyncHistoryOutput(
  args: ReadonlyArray<string>,
  snapshot: BetterC0deSyncRouteSnapshot
): string {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const json =
    cleanArgs.includes("--json") || cleanArgs.includes("--format=json")
  const cursor = parseBetterC0deSyncHistoryCursor(cleanArgs)
  const validation = cursor.error ? [cursor.error] : []
  const events = filterBetterC0deSyncEventsByCursor(
    localBetterC0deSyncEvents(snapshot),
    cursor.value
  ).slice(-80)

  if (json) {
    return [
      "# BetterC0de Sync History",
      "",
      "Compatibility reference: `sync.history.list` / `POST /sync/history`.",
      validation.length ? "\n## Validation\n" : "",
      ...validation.map((item) => `- ${item}`),
      "",
      "```json",
      JSON.stringify(events, null, 2),
      "```",
      "",
      "> BetterC0de returns a local compatibility snapshot built from thread metadata and thread activities. No external runtime process is required.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  return [
    "# BetterC0de Sync History",
    "",
    "Compatibility reference: `sync.history.list` / `POST /sync/history`.",
    validation.length ? "\n## Validation\n" : "",
    ...validation.map((item) => `- ${item}`),
    validation.length ? "" : "",
    cursor.value
      ? `Cursor aggregates: ${Object.keys(cursor.value).length.toLocaleString()}`
      : "Cursor aggregates: none",
    "",
    events.length === 0
      ? "> No local BetterC0de sync-compatible events matched this cursor."
      : "| # | Aggregate | Seq | Type | Data |",
    events.length === 0 ? "" : "|:--|:----------|:----|:-----|:-----|",
    ...events.map(
      (event, index) =>
        `| ${index + 1} | \`${escapeMarkdownTableCell(event.aggregate_id)}\` | ${event.seq} | \`${escapeMarkdownTableCell(event.type)}\` | \`${escapeMarkdownTableCell(JSON.stringify(event.data))}\` |`
    ),
    events.length === 0 ? "" : "",
    "> Use `/events` for the active thread event view, `/sessions --json` for local session metadata, or `/export` for a portable thread snapshot.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function buildBetterC0deSyncStartOutput(
  snapshot: BetterC0deSyncRouteSnapshot
): string {
  const activeDirectory = resolveBetterC0deSyncActiveDirectory(snapshot)
  const workspaceThreads = activeDirectory
    ? snapshot.threads.filter(
        (thread) =>
          thread.worktreePath === activeDirectory ||
          thread.projectPath === activeDirectory
      )
    : snapshot.threads
  const active = snapshot.threads.find(
    (thread) => thread.id === snapshot.activeThreadId
  )

  return [
    "# BetterC0de Sync Start",
    "",
    "Compatibility reference: `sync.start` / `POST /sync/start`.",
    "",
    `Active directory: ${activeDirectory ? `\`${escapeMarkdownTableCell(activeDirectory)}\`` : "_none_"}`,
    `Active session: ${active ? `\`${escapeMarkdownTableCell(active.id)}\` ${escapeMarkdownTableCell(active.title || "Untitled")}` : "_none_"}`,
    `Workspace sessions: ${workspaceThreads.length.toLocaleString()}`,
    "",
    "> BetterC0de keeps thread state in its local store/backend and does not need to start external websocket sync loops from chat. Use `/sessions`, `/events`, `/export`, and `/import` for the safe equivalents.",
  ].join("\n")
}

function buildBetterC0deSyncReplayOutput(args: ReadonlyArray<string>): string {
  const parsed = parseBetterC0deSyncReplayPayload(args)
  const validation = parsed.validation
  const payload = parsed.payload
  return [
    "# BetterC0de Sync Replay",
    "",
    "Compatibility reference: `sync.replay` / `POST /sync/replay`.",
    "",
    payload
      ? `Directory: \`${escapeMarkdownTableCell(payload.directory)}\`\nEvents: ${payload.events.length.toLocaleString()}`
      : "Payload: _not provided_",
    validation.length ? "\n## Validation\n" : "",
    ...validation.map((item) => `- ${item}`),
    validation.length ? "" : "",
    "> BetterC0de does not replay raw compatibility events directly into chat state. Export the replay data to a file and use `/import <file>` when you want an auditable import path.",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildBetterC0deSyncStealOutput(
  args: ReadonlyArray<string>,
  snapshot: BetterC0deSyncRouteSnapshot
): string {
  const sessionID = parseBetterC0deSyncSessionId(args)
  const matched = sessionID
    ? snapshot.threads.find(
        (thread) =>
          thread.id === sessionID ||
          thread.codexThreadId === sessionID ||
          thread.id.startsWith(sessionID)
      )
    : null

  return [
    "# BetterC0de Sync Steal",
    "",
    "Compatibility reference: `sync.steal` / `POST /sync/steal`.",
    "",
    `Requested session: ${sessionID ? `\`${escapeMarkdownTableCell(sessionID)}\`` : "_missing_"}`,
    matched
      ? `Matched BetterC0de thread: \`${escapeMarkdownTableCell(matched.id)}\` ${escapeMarkdownTableCell(matched.title || "Untitled")}`
      : "",
    "",
    !sessionID ? "## Validation\n\n- Missing `sessionID`." : "",
    sessionID && !matched
      ? "> No local BetterC0de thread matched this session id. Use `/sessions` to inspect local ids."
      : "",
    matched
      ? "> BetterC0de does not silently reassign a session to the current workspace from this compatibility route. Use `/resume`, `/workspace-new`, or explicit import/export flows so workspace moves stay auditable."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

type LocalBetterC0deSyncEvent = {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: Record<string, unknown>
}

function localBetterC0deSyncEvents(
  snapshot: BetterC0deSyncRouteSnapshot
): LocalBetterC0deSyncEvent[] {
  const events: LocalBetterC0deSyncEvent[] = []
  for (const thread of [...snapshot.threads].sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt)
  )) {
    const aggregate = thread.id
    events.push({
      id: `thread:${thread.id}:meta`,
      aggregate_id: aggregate,
      seq: 1,
      type: "session.updated",
      data: {
        title: thread.title,
        directory: thread.worktreePath || thread.projectPath || null,
        updatedAt: thread.updatedAt,
        messageCount: thread.messageCount ?? thread.messages.length,
      },
    })
    const activities = snapshot.activitiesByThread?.[thread.id] ?? []
    for (const [index, activity] of [...activities]
      .sort(compareThreadActivities)
      .entries()) {
      events.push({
        id: activity.id,
        aggregate_id: aggregate,
        seq: index + 2,
        type: `activity.${activity.kind}`,
        data: {
          tone: activity.tone,
          summary: activity.summary,
          createdAt: activity.createdAt,
        },
      })
    }
    const stream = snapshot.streamingByThread?.[thread.id]
    if (stream?.isStreaming) {
      events.push({
        id: `thread:${thread.id}:stream`,
        aggregate_id: aggregate,
        seq: activities.length + 2,
        type: "session.status",
        data: {
          status: "streaming",
          model: stream.streamingModelId,
        },
      })
    }
  }
  return events
}

function filterBetterC0deSyncEventsByCursor(
  events: ReadonlyArray<LocalBetterC0deSyncEvent>,
  cursor: Record<string, number> | null
): LocalBetterC0deSyncEvent[] {
  if (!cursor) return [...events]
  return events.filter((event) => event.seq > (cursor[event.aggregate_id] ?? 0))
}

function parseBetterC0deSyncHistoryCursor(args: ReadonlyArray<string>): {
  value: Record<string, number> | null
  error?: string
} {
  const raw = args.join(" ").trim()
  if (!raw || !raw.startsWith("{")) return { value: null }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        value: null,
        error: "Sync history cursor must be a JSON object.",
      }
    }
    const value: Record<string, number> = {}
    for (const [key, rawValue] of Object.entries(parsed)) {
      const numeric = Number(rawValue)
      if (!Number.isInteger(numeric) || numeric < 0) {
        return {
          value: null,
          error: "Sync history cursor values must be non-negative integers.",
        }
      }
      value[key] = numeric
    }
    return { value }
  } catch (error) {
    return {
      value: null,
      error: `Invalid sync history cursor JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
    }
  }
}

function parseBetterC0deSyncReplayPayload(args: ReadonlyArray<string>): {
  payload: { directory: string; events: unknown[] } | null
  validation: string[]
} {
  const raw = args.join(" ").trim()
  if (!raw || !raw.startsWith("{")) {
    return {
      payload: null,
      validation: ["Provide the BetterC0de replay payload as JSON."],
    }
  }
  try {
    const parsed = JSON.parse(raw) as {
      directory?: unknown
      events?: unknown
    }
    const validation: string[] = []
    if (typeof parsed.directory !== "string" || !parsed.directory.trim()) {
      validation.push("Replay payload requires a non-empty `directory` string.")
    }
    if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
      validation.push("Replay payload requires a non-empty `events` array.")
    }
    return {
      payload:
        validation.length === 0
          ? {
              directory: parsed.directory as string,
              events: parsed.events as unknown[],
            }
          : null,
      validation,
    }
  } catch (error) {
    return {
      payload: null,
      validation: [
        `Invalid replay JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
      ],
    }
  }
}

function parseBetterC0deSyncSessionId(
  args: ReadonlyArray<string>
): string | null {
  const raw = args.join(" ").trim()
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { sessionID?: unknown }
      return typeof parsed.sessionID === "string" && parsed.sessionID.trim()
        ? parsed.sessionID.trim()
        : null
    } catch {
      return null
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (
      arg === "--sessionID" ||
      arg === "--session-id" ||
      arg === "--session"
    ) {
      return args[index + 1]?.trim() || null
    }
    if (arg.startsWith("--sessionID=")) {
      return arg.slice("--sessionID=".length).trim() || null
    }
    if (arg.startsWith("--session-id=")) {
      return arg.slice("--session-id=".length).trim() || null
    }
    if (!arg.startsWith("-")) return arg.trim() || null
  }
  return null
}

function resolveBetterC0deSyncActiveDirectory(
  snapshot: BetterC0deSyncRouteSnapshot
): string | null {
  const activeThread = snapshot.threads.find(
    (thread) => thread.id === snapshot.activeThreadId
  )
  return (
    snapshot.activeThread?.worktreePath ||
    snapshot.activeThread?.projectPath ||
    activeThread?.worktreePath ||
    activeThread?.projectPath ||
    null
  )
}

function resolveBetterC0deWorkspaceRoute(
  command: string,
  args: ReadonlyArray<string>
): "experimental.workspace.syncList" | "experimental.workspace.warp" {
  const normalized = command.replace(/^\//, "").replace(/-/g, ".")
  if (normalized === "experimental.workspace.warp") {
    return "experimental.workspace.warp"
  }
  const first = args.find((arg) => arg && !arg.startsWith("--"))?.toLowerCase()
  if (first === "warp") return "experimental.workspace.warp"
  return "experimental.workspace.syncList"
}

function buildBetterC0deWorkspaceSyncListOutput(
  snapshot: BetterC0deWorkspaceRouteSnapshot
): string {
  const activeDirectory = resolveBetterC0deWorkspaceActiveDirectory(snapshot)
  const workspaceMap = new Map<
    string,
    { path: string; project: string; threadCount: number; active: boolean }
  >()
  for (const thread of snapshot.threads) {
    const path = thread.worktreePath || thread.projectPath
    if (!path) continue
    const existing = workspaceMap.get(path)
    if (existing) {
      existing.threadCount += 1
      existing.active = existing.active || path === activeDirectory
      continue
    }
    workspaceMap.set(path, {
      path,
      project: thread.projectName || path.split("/").pop() || "Workspace",
      threadCount: 1,
      active: path === activeDirectory,
    })
  }
  const workspaceRows = [...workspaceMap.values()]

  return [
    "# BetterC0de Workspace Sync List",
    "",
    "Compatibility reference: `experimental.workspace.syncList` / `POST /experimental/workspace/sync-list`.",
    "",
    workspaceRows.length === 0
      ? "> No local BetterC0de workspaces are represented by recent chats."
      : "| Active | Project | Path | Threads |",
    workspaceRows.length === 0 ? "" : "|:-------|:--------|:-----|:--------|",
    ...workspaceRows.map(
      (row) =>
        `| ${row.active ? "Yes" : ""} | ${escapeMarkdownTableCell(row.project)} | \`${escapeMarkdownTableCell(row.path)}\` | ${row.threadCount} |`
    ),
    workspaceRows.length === 0 ? "" : "",
    "> BetterC0de tracks workspaces through thread context, worktrees, and `/workspace-list`; this view only mirrors compatibility sync-list semantics.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function buildBetterC0deWorkspaceWarpOutput(
  args: ReadonlyArray<string>,
  snapshot: BetterC0deWorkspaceRouteSnapshot
): string {
  const request = parseBetterC0deWorkspaceWarpRequest(args)
  const sessionID = request.sessionID
  const matched = sessionID
    ? snapshot.threads.find(
        (thread) =>
          thread.id === sessionID ||
          thread.codexThreadId === sessionID ||
          thread.id.startsWith(sessionID)
      )
    : null

  return [
    "# BetterC0de Workspace Warp",
    "",
    "Compatibility reference: `experimental.workspace.warp` / `POST /experimental/workspace/warp`.",
    "",
    `Workspace id: ${request.id === null ? "`null` (detach to local project)" : request.id ? `\`${escapeMarkdownTableCell(request.id)}\`` : "_missing_"}`,
    `Session id: ${request.sessionID ? `\`${escapeMarkdownTableCell(request.sessionID)}\`` : "_missing_"}`,
    `Copy changes: ${typeof request.copyChanges === "boolean" ? String(request.copyChanges) : "_not specified_"}`,
    matched
      ? `Matched BetterC0de thread: \`${escapeMarkdownTableCell(matched.id)}\` ${escapeMarkdownTableCell(matched.title || "Untitled")}`
      : "",
    request.validation.length ? "\n## Validation\n" : "",
    ...request.validation.map((item) => `- ${item}`),
    request.validation.length ? "" : "",
    "> BetterC0de does not silently move sync history between workspaces from this route. Use `/warp <folder>` to change the active folder, `/workspace-new` for an isolated worktree, or `/resume <thread>` to switch sessions.",
  ]
    .filter(Boolean)
    .join("\n")
}

function parseBetterC0deWorkspaceWarpRequest(args: ReadonlyArray<string>): {
  id?: string | null
  sessionID?: string
  copyChanges?: boolean
  validation: string[]
} {
  const raw = args.join(" ").trim()
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        id?: unknown
        sessionID?: unknown
        copyChanges?: unknown
      }
      return validateBetterC0deWorkspaceWarpRequest({
        id:
          typeof parsed.id === "string" || parsed.id === null
            ? parsed.id
            : undefined,
        sessionID:
          typeof parsed.sessionID === "string" ? parsed.sessionID : undefined,
        copyChanges:
          typeof parsed.copyChanges === "boolean"
            ? parsed.copyChanges
            : undefined,
      })
    } catch (error) {
      return {
        validation: [
          `Invalid workspace warp JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
        ],
      }
    }
  }

  return validateBetterC0deWorkspaceWarpRequest({
    id: readBetterC0deRouteOption(args, "id", "workspace", "workspace-id"),
    sessionID:
      readBetterC0deRouteOption(args, "sessionID", "session-id", "session") ??
      args.find((arg) => arg && !arg.startsWith("--")),
    copyChanges: readBetterC0deRouteBoolean(
      args,
      "copyChanges",
      "copy-changes"
    ),
  })
}

function validateBetterC0deWorkspaceWarpRequest(input: {
  id?: string | null
  sessionID?: string
  copyChanges?: boolean
}): {
  id?: string | null
  sessionID?: string
  copyChanges?: boolean
  validation: string[]
} {
  const validation: string[] = []
  if (input.id !== null && (!input.id || !input.id.trim())) {
    validation.push("Workspace warp requires `id` or explicit `id: null`.")
  }
  if (!input.sessionID?.trim()) {
    validation.push("Workspace warp requires `sessionID`.")
  }
  return { ...input, validation }
}

function resolveBetterC0deWorkspaceActiveDirectory(
  snapshot: BetterC0deWorkspaceRouteSnapshot
): string | null {
  const activeThread = snapshot.threads.find(
    (thread) => thread.id === snapshot.activeThreadId
  )
  return (
    snapshot.activeThread?.worktreePath ||
    snapshot.activeThread?.projectPath ||
    activeThread?.worktreePath ||
    activeThread?.projectPath ||
    null
  )
}

function readBetterC0deRouteOption(
  args: ReadonlyArray<string>,
  ...names: string[]
): string | null {
  const flags = new Set(names.map((name) => `--${name}`))
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    for (const flag of flags) {
      if (arg === flag) return args[index + 1]?.trim() || null
      if (arg.startsWith(`${flag}=`)) {
        return arg.slice(flag.length + 1).trim() || null
      }
    }
  }
  return null
}

function readBetterC0deRouteBoolean(
  args: ReadonlyArray<string>,
  ...names: string[]
): boolean | undefined {
  const raw = readBetterC0deRouteOption(args, ...names)
  if (!raw) return undefined
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") {
    return true
  }
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") {
    return false
  }
  return undefined
}
