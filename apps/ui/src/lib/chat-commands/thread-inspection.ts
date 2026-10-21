import { activeContextMessages } from "@/lib/chat-context"
import {
  useChatStore,
  type ChatMessage,
  type ChatThread,
  type ThreadActivity,
  type ThreadStreamState,
} from "@/lib/chat-store"
import { requestIdFromActivity } from "@/lib/pending-provider-requests"
import type { UiProvider } from "@/lib/provider-types"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { loadThreadDiffs } from "@/services/backend/coreApi"
import { escapeInlineCode, escapeMarkdownTableCell } from "./provider-config"
import {
  approvalRecord,
  approvalStringFrom,
  compareThreadActivities,
  formatSessionStreamingState,
  formatSessionTime,
} from "./session-commands"
import { buildDebugSnapshotMarkdown } from "./thread-export"

export async function buildDebugSnapshotOutput(
  threadId: string | null,
  command: string,
  args: readonly string[]
): Promise<string> {
  if (!threadId) return "# Debug Snapshot\n\n> No active chat is selected."
  const diffs = await loadThreadDiffs(threadId)
  return buildDebugSnapshotMarkdown(threadId, diffs, command, args)
}

export async function buildTimelineThreadOutput(
  threadId: string | null
): Promise<string> {
  if (!threadId) return "# Session Timeline\n\n> No active chat is selected."

  const store = useChatStore.getState()
  await store.ensureFullThreadMessages(threadId)
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return "# Session Timeline\n\n> The active chat could not be found."
  }

  return buildThreadTimelineMarkdown(thread)
}

export async function buildEventsThreadOutput(
  threadId: string | null
): Promise<string> {
  if (!threadId) return buildThreadEventsOutputFromSnapshot({ thread: null })

  const store = useChatStore.getState()
  if (!store.activitiesLoadedByThread[threadId]) {
    await store.hydrateThreadActivities(threadId).catch(() => undefined)
  }
  const current = useChatStore.getState()
  const thread = current.threads.find((candidate) => candidate.id === threadId)
  if (!thread) return buildThreadEventsOutputFromSnapshot({ thread: null })

  return buildThreadEventsOutputFromSnapshot({
    thread,
    activities: current.activitiesByThread[threadId] ?? [],
    stream: current.streamingByThread[threadId] ?? null,
  })
}

export async function buildMessagesThreadOutput(
  threadId: string | null,
  args: readonly string[]
): Promise<string> {
  if (!threadId) return "# Session Messages\n\n> No active chat is selected."

  const store = useChatStore.getState()
  await store.ensureFullThreadMessages(threadId)
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return "# Session Messages\n\n> The active chat could not be found."
  }

  return buildThreadMessagesMarkdown(thread, parseMessageListArgs(args))
}

export async function buildContextThreadOutput(
  threadId: string | null,
  options: Omit<ThreadContextMarkdownOptions, "thread">
): Promise<string> {
  if (!threadId) return "# Session Context\n\n> No active chat is selected."

  const store = useChatStore.getState()
  await store.ensureFullThreadMessages(threadId)
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return "# Session Context\n\n> The active chat could not be found."
  }

  return buildThreadContextMarkdown({ ...options, thread })
}

const MAX_TIMELINE_MESSAGES = 80

const MAX_CONTEXT_PREVIEW_MESSAGES = 24

const DEFAULT_MESSAGE_LIST_LIMIT = 20

const MAX_MESSAGE_LIST_LIMIT = 100

export function buildThreadTimelineMarkdown(thread: ChatThread): string {
  if (thread.messages.length === 0) {
    return "# Session Timeline\n\n> This chat has no messages yet."
  }

  const omitted = Math.max(0, thread.messages.length - MAX_TIMELINE_MESSAGES)
  const messages = thread.messages.slice(omitted)
  const rows = messages.map((message, index) => {
    const ordinal = omitted + index + 1
    return `| ${ordinal} | ${formatSessionTime(message.createdAt)} | ${formatTimelineRole(message.role)} | ${escapeMarkdownTableCell(formatTimelinePreview(message))} | ${escapeMarkdownTableCell(formatTimelineSignals(message))} |`
  })

  return [
    "# Session Timeline\n",
    `Thread: **${thread.title || "Untitled"}**`,
    "",
    omitted > 0
      ? `> Showing the last ${messages.length} of ${thread.messages.length} messages.`
      : `> ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"} recorded.`,
    "",
    "| # | Time | Role | Summary | Signals |",
    "|:--|:-----|:-----|:--------|:--------|",
    ...rows,
  ].join("\n")
}

export interface ChatThreadEventsSnapshot {
  thread: ChatThread | null
  activities?: ReadonlyArray<ThreadActivity>
  stream?: ThreadStreamState | null
}

export function buildThreadEventsOutputFromSnapshot(
  snapshot: ChatThreadEventsSnapshot
): string {
  const { thread } = snapshot
  if (!thread) {
    return [
      "# Session Events\n",
      "Compatibility reference: `event.subscribe`.",
      "",
      "> No active chat is open.",
    ].join("\n")
  }

  const activities = [...(snapshot.activities ?? [])].sort(
    compareThreadActivities
  )
  const streamEvents = sessionStreamEvents(snapshot.stream)
  const eventRows = [
    ...activities.map((activity) => ({
      time: activity.createdAt,
      type: activity.kind,
      summary: activity.summary || "-",
      detail: activityDetail(activity),
    })),
    ...streamEvents,
  ].slice(-80)

  if (eventRows.length === 0) {
    return [
      "# Session Events\n",
      "Compatibility reference: `event.subscribe`.",
      "",
      `Thread: **${thread.title || "Untitled"}**`,
      "",
      "> No local events have been recorded for this chat yet.",
    ].join("\n")
  }

  return [
    "# Session Events\n",
    "Compatibility reference: `event.subscribe`.",
    "",
    `Thread: **${thread.title || "Untitled"}**`,
    "",
    "> Snapshot of BetterC0de's local thread activity log; the BetterC0de route is a live SSE stream.",
    "",
    "| # | Time | Type | Summary | Detail |",
    "|:--|:-----|:-----|:--------|:-------|",
    ...eventRows.map(
      (event, index) =>
        `| ${index + 1} | ${formatSessionTime(event.time)} | \`${escapeMarkdownTableCell(escapeInlineCode(event.type))}\` | ${escapeMarkdownTableCell(event.summary)} | ${escapeMarkdownTableCell(event.detail)} |`
    ),
  ].join("\n")
}

function sessionStreamEvents(
  stream: ThreadStreamState | null | undefined
): { time: string; type: string; summary: string; detail: string }[] {
  if (!stream) return []
  const now = new Date().toISOString()
  const events: {
    time: string
    type: string
    summary: string
    detail: string
  }[] = []
  if (stream.isStreaming) {
    events.push({
      time: now,
      type: "session.status",
      summary: formatSessionStreamingState(stream),
      detail: [
        stream.activeTurnId ? `turn=${stream.activeTurnId}` : "",
        stream.streamingModelId ? `model=${stream.streamingModelId}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    })
  }
  if (stream.streamingTools.length > 0) {
    events.push({
      time: now,
      type: "message.part.updated",
      summary: `${stream.streamingTools.length} streaming tool call${stream.streamingTools.length === 1 ? "" : "s"}`,
      detail: stream.streamingTools
        .slice(0, 3)
        .map((tool) => tool.name)
        .join(", "),
    })
  }
  if (stream.streamingDiffs.length > 0) {
    events.push({
      time: now,
      type: "session.diff",
      summary: `${stream.streamingDiffs.length} streaming diff${stream.streamingDiffs.length === 1 ? "" : "s"}`,
      detail: stream.streamingDiffs
        .slice(0, 3)
        .map((diff) => diff.path)
        .join(", "),
    })
  }
  if (stream.streamingTasks.length > 0) {
    events.push({
      time: now,
      type: "session.todo",
      summary: `${stream.streamingTasks.length} streaming task${stream.streamingTasks.length === 1 ? "" : "s"}`,
      detail: stream.streamingTasks
        .slice(0, 3)
        .map((task) => task.text)
        .join("; "),
    })
  }
  return events
}

function activityDetail(activity: ThreadActivity): string {
  const requestId = requestIdFromActivity(activity)
  const payload = approvalRecord(activity.payload)
  const provider =
    approvalStringFrom(payload.providerKind) ??
    approvalStringFrom(payload.provider_kind) ??
    approvalStringFrom(payload.provider)
  return [
    requestId ? `request=${requestId}` : "",
    provider ? `provider=${provider}` : "",
  ]
    .filter(Boolean)
    .join(" ")
}

export type MessageListOrder = "asc" | "desc"

export interface MessageListOptions {
  limit: number
  order: MessageListOrder
  cursor: number | null
}

type MessageListRow = {
  message: ChatMessage
  ordinal: number
}

export function parseMessageListArgs(
  args: readonly string[]
): MessageListOptions {
  let limit = DEFAULT_MESSAGE_LIST_LIMIT
  let order: MessageListOrder = "desc"
  let cursor: number | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue

    const readValue = (prefix: string) =>
      arg.startsWith(`${prefix}=`)
        ? arg.slice(prefix.length + 1)
        : args[index + 1]

    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = Number(readValue("--limit"))
      if (Number.isInteger(parsed) && parsed > 0) {
        limit = Math.min(parsed, MAX_MESSAGE_LIST_LIMIT)
      }
      if (arg === "--limit") index += 1
      continue
    }

    if (arg === "--order" || arg.startsWith("--order=")) {
      const value = readValue("--order")?.toLowerCase()
      if (value === "asc" || value === "desc") order = value
      if (arg === "--order") index += 1
      continue
    }

    if (arg === "--cursor" || arg.startsWith("--cursor=")) {
      const parsed = Number(readValue("--cursor"))
      if (Number.isInteger(parsed) && parsed > 0) cursor = parsed
      if (arg === "--cursor") index += 1
      continue
    }

    if (/^\d+$/.test(arg) && cursor === null) {
      cursor = Number(arg)
    }
  }

  return { limit, order, cursor }
}

export function buildThreadMessagesMarkdown(
  thread: ChatThread,
  options: MessageListOptions = {
    limit: DEFAULT_MESSAGE_LIST_LIMIT,
    order: "desc",
    cursor: null,
  }
): string {
  if (thread.messages.length === 0) {
    return "# Session Messages\n\n> This chat has no messages yet."
  }

  const rows = pageThreadMessages(thread.messages, options)
  const nextCursor = nextMessageCursor(thread.messages.length, rows, options)
  const range = rows.length
    ? `${rows.at(0)!.ordinal}-${rows.at(-1)!.ordinal}`
    : "-"

  return [
    "# Session Messages\n",
    "Compatibility reference: `session.message.list`.",
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| Thread | \`${escapeMarkdownTableCell(thread.id.slice(0, 8))}\` ${escapeMarkdownTableCell(thread.title || "Untitled")} |`,
    `| Total messages | ${thread.messages.length} |`,
    `| Order | ${options.order} |`,
    `| Limit | ${options.limit} |`,
    `| Cursor | ${options.cursor ?? "-"} |`,
    `| Returned range | ${range} |`,
    "",
    "| # | Time | Role | Preview | Signals |",
    "|:--|:-----|:-----|:--------|:--------|",
    ...rows.map(
      ({ message, ordinal }) =>
        `| ${ordinal} | ${formatSessionTime(message.createdAt)} | ${formatTimelineRole(message.role)} | ${escapeMarkdownTableCell(formatTimelinePreview(message))} | ${escapeMarkdownTableCell(formatTimelineSignals(message))} |`
    ),
    "",
    nextCursor
      ? `Next page: \`/messages --order ${options.order} --limit ${options.limit} --cursor ${nextCursor}\``
      : "> End of message list.",
  ].join("\n")
}

function pageThreadMessages(
  messages: ReadonlyArray<ChatMessage>,
  options: MessageListOptions
): MessageListRow[] {
  if (options.order === "asc") {
    const start = clampMessageCursor(options.cursor ?? 1, messages.length)
    return messages
      .slice(start - 1, start - 1 + options.limit)
      .map((message, index) => ({ message, ordinal: start + index }))
  }

  const start = clampMessageCursor(
    options.cursor ?? messages.length,
    messages.length
  )
  const rows: MessageListRow[] = []
  for (
    let ordinal = start;
    ordinal >= 1 && rows.length < options.limit;
    ordinal -= 1
  ) {
    const message = messages[ordinal - 1]
    if (message) rows.push({ message, ordinal })
  }
  return rows
}

function nextMessageCursor(
  total: number,
  rows: ReadonlyArray<MessageListRow>,
  options: MessageListOptions
): number | null {
  if (rows.length === 0) return null
  const last = rows.at(-1)!.ordinal
  if (options.order === "asc") return last < total ? last + 1 : null
  return last > 1 ? last - 1 : null
}

function clampMessageCursor(cursor: number, total: number): number {
  if (total <= 0) return 1
  return Math.min(Math.max(cursor, 1), total)
}

export interface ThreadContextSlice {
  messages: ChatMessage[]
  compactionIndex: number | null
}

export interface ThreadContextMarkdownOptions {
  thread: ChatThread
  selectedProvider?: UiProvider
  selectedModel?: string
  chatMode?: string
  permissionLevel?: string
  contextWindow?: string
  full?: boolean
}

export function activeContextMessagesFromThread(
  thread: Pick<ChatThread, "messages">
): ThreadContextSlice {
  return activeContextMessages(thread.messages)
}

export function buildThreadContextMarkdown(
  options: ThreadContextMarkdownOptions
): string {
  const { thread } = options
  if (thread.messages.length === 0) {
    return "# Session Context\n\n> This chat has no messages yet."
  }

  const context = activeContextMessagesFromThread(thread)
  const omitted = options.full
    ? 0
    : Math.max(0, context.messages.length - MAX_CONTEXT_PREVIEW_MESSAGES)
  const visibleMessages = context.messages.slice(omitted)
  const contextChars = context.messages.reduce(
    (total, message) => total + message.content.length,
    0
  )
  const estimatedTokens = Math.ceil(contextChars / 4)
  const runtimePath = resolveThreadRuntimePath(thread)
  const compactionLabel =
    context.compactionIndex === null
      ? "No compaction boundary"
      : `Message ${context.compactionIndex + 1}`

  return [
    "# Session Context\n",
    "Compatibility reference: `session.context`.",
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| Thread | \`${escapeMarkdownTableCell(thread.id.slice(0, 8))}\` ${escapeMarkdownTableCell(thread.title || "Untitled")} |`,
    `| Workspace | ${runtimePath ? `\`${escapeMarkdownTableCell(runtimePath)}\`` : "No folder"} |`,
    `| Mode | ${escapeMarkdownTableCell(options.chatMode ?? "-")} |`,
    `| Provider / Model | ${escapeMarkdownTableCell(formatContextProviderModel(options.selectedProvider, options.selectedModel))} |`,
    `| Permission | ${escapeMarkdownTableCell(options.permissionLevel ?? "-")} |`,
    `| Context Window | ${escapeMarkdownTableCell(options.contextWindow ?? "-")} |`,
    `| Messages in active context | ${context.messages.length} of ${thread.messages.length} |`,
    `| Compaction boundary | ${escapeMarkdownTableCell(compactionLabel)} |`,
    `| Estimated context tokens | ~${estimatedTokens.toLocaleString()} |`,
    formatThreadUsageRow(thread),
    "",
    omitted > 0
      ? `> Showing the last ${visibleMessages.length} active-context messages. Use \`/context --full\` to list every active-context message.`
      : `> Showing ${visibleMessages.length} active-context message${visibleMessages.length === 1 ? "" : "s"}.`,
    "",
    "| # | Time | Role | Preview | Signals |",
    "|:--|:-----|:-----|:--------|:--------|",
    ...visibleMessages.map((message, index) => {
      const ordinal =
        (context.compactionIndex === null ? 0 : context.compactionIndex) +
        omitted +
        index +
        1
      return `| ${ordinal} | ${formatSessionTime(message.createdAt)} | ${formatTimelineRole(message.role)} | ${escapeMarkdownTableCell(formatTimelinePreview(message))} | ${escapeMarkdownTableCell(formatTimelineSignals(message))} |`
    }),
  ]
    .filter(Boolean)
    .join("\n")
}

function formatContextProviderModel(
  provider: UiProvider | undefined,
  model: string | undefined
): string {
  if (!provider && !model) return "-"
  return [provider?.name, model ? `\`${model}\`` : null]
    .filter(Boolean)
    .join(" / ")
}

function formatThreadUsageRow(thread: ChatThread): string {
  const usage = thread.usage as
    | (Record<string, number | undefined> & {
        usedTokens?: number
        maxTokens?: number
      })
    | undefined
  if (!usage) return ""
  const used =
    usage.usedTokens ?? usage.inputTokens ?? usage.totalProcessedTokens
  const max = usage.maxTokens
  if (typeof used !== "number" && typeof max !== "number") return ""
  const label =
    typeof used === "number" && typeof max === "number"
      ? `${used.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`
      : typeof used === "number"
        ? used.toLocaleString("en-US")
        : `max ${max?.toLocaleString("en-US")}`
  return `| Provider token usage | ${label} |`
}

function formatTimelineRole(role: ChatMessage["role"]): string {
  if (role === "assistant") return "Assistant"
  if (role === "system") return "System"
  return "User"
}

function formatTimelinePreview(message: ChatMessage): string {
  const base =
    message.content.trim() ||
    message.reasoning?.trim() ||
    (message.toolCalls?.length ? "Tool activity" : "") ||
    (message.diffs?.length ? "File changes" : "") ||
    "(empty)"
  const compact = base.replace(/\s+/g, " ").trim()
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact
}

function formatTimelineSignals(message: ChatMessage): string {
  const signals: string[] = []
  if (message.reasoning?.trim()) signals.push("thinking")
  if (message.toolCalls?.length) {
    signals.push(
      `${message.toolCalls.length} tool${message.toolCalls.length === 1 ? "" : "s"}`
    )
  }
  if (message.diffs?.length) {
    signals.push(
      `${message.diffs.length} diff${message.diffs.length === 1 ? "" : "s"}`
    )
  }
  if (message.questions?.length) {
    signals.push(
      `${message.questions.length} question${message.questions.length === 1 ? "" : "s"}`
    )
  }
  if (message.answeredQuestions?.length) {
    signals.push(
      `${message.answeredQuestions.length} answer${message.answeredQuestions.length === 1 ? "" : "s"}`
    )
  }
  return signals.length ? signals.join(", ") : "-"
}
