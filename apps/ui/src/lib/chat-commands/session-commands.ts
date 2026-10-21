import {
  type ChatThread,
  type ThreadActivity,
  type ThreadStreamState,
} from "@/lib/chat-store"
import { slugifyRuntimeId } from "@/lib/cli-parse"
import type { ThreadUsageStats } from "@/services/backend/coreApi"
import {
  derivePendingRequests,
  type PendingProviderRequest,
} from "@betterc0de/schema/pending-requests"
import { escapeInlineCode, escapeMarkdownTableCell } from "./provider-config"

type SlashSessionThread = {
  id: string
  title: string
  projectName?: string | null
  projectPath?: string | null
  parentThreadId?: string | null
  createdAt?: string | null
  updatedAt: string
}

export interface SessionListOptions {
  format: "table" | "json"
  maxCount?: number
  order?: "asc" | "desc"
  search?: string
  path?: string
  roots?: boolean
  start?: number
  cursor?: string
}

type SessionUpdateArgs = {
  title?: string
  archived?: boolean
  permission?: string
}

export function parseSessionUpdateArgs(
  args: readonly string[]
): SessionUpdateArgs {
  const out: SessionUpdateArgs = {}
  const readValue = (index: number): string | undefined => {
    const value = args[index + 1]
    return value && !value.startsWith("-") ? value.trim() : undefined
  }
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]?.trim()
    if (!raw) continue
    const normalized = raw.toLowerCase()
    if (normalized === "--title" || normalized === "title") {
      const value = readValue(index)
      if (value) {
        out.title = value
        index += 1
      }
      continue
    }
    if (normalized.startsWith("--title=")) {
      out.title = raw.slice("--title=".length).trim()
      continue
    }
    if (normalized.startsWith("title=")) {
      out.title = raw.slice("title=".length).trim()
      continue
    }
    if (
      normalized === "--archive" ||
      normalized === "--archived" ||
      normalized === "--time.archived"
    ) {
      const value = readValue(index)
      if (value && ["true", "false"].includes(value.toLowerCase())) {
        out.archived = value.toLowerCase() === "true"
        index += 1
      } else {
        out.archived = true
      }
      continue
    }
    if (normalized === "--unarchive" || normalized === "--no-archive") {
      out.archived = false
      continue
    }
    if (
      normalized.startsWith("--archive=") ||
      normalized.startsWith("--archived=") ||
      normalized.startsWith("--time.archived=")
    ) {
      const value = normalized.slice(normalized.indexOf("=") + 1)
      if (value === "true" || value === "false") out.archived = value === "true"
      continue
    }
    if (normalized === "--permission") {
      const value = readValue(index)
      if (value) {
        out.permission = value
        index += 1
      }
      continue
    }
    if (normalized.startsWith("--permission=")) {
      out.permission = raw.slice("--permission=".length).trim()
    }
  }
  return out
}

export function buildSessionsOutput(
  threads: ReadonlyArray<SlashSessionThread>,
  activeThreadId: string | null,
  options: SessionListOptions = { format: "table" }
): string {
  const filteredThreads = filterSessionThreads(threads, options)
  const filterSummary = sessionListFilterSummary(options)
  if (filteredThreads.length === 0) {
    if (options.format === "json") {
      return [
        "# Sessions",
        "",
        "Compatibility reference: `betterc0de session list --format json`.",
        filterSummary ? `Filters: ${filterSummary}` : "",
        options.cursor
          ? "> BetterC0de lists local sessions directly; BetterC0de opaque cursors are accepted for compatibility but not replayed."
          : "",
        "",
        "```json",
        "[]",
        "```",
      ].join("\n")
    }
    return [
      "# Sessions\n",
      filterSummary ? `Filters: ${filterSummary}\n` : "",
      threads.length === 0
        ? "> No chat sessions yet. Use `/new` to start one."
        : "> No chat sessions matched the current filters.",
      options.cursor
        ? "\n> BetterC0de lists local sessions directly; BetterC0de opaque cursors are accepted for compatibility but not replayed."
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  const visibleThreads = filteredThreads.slice(
    0,
    options.maxCount ?? (options.format === "table" ? 12 : threads.length)
  )

  if (options.format === "json") {
    const payload = visibleThreads.map((thread) => ({
      id: thread.id,
      title: thread.title || "Untitled",
      updated: thread.updatedAt,
      created: thread.createdAt ?? thread.updatedAt,
      projectId: thread.projectName ?? null,
      directory: thread.projectPath ?? null,
      parentId: thread.parentThreadId ?? null,
    }))
    return [
      "# Sessions",
      "",
      "Compatibility reference: `betterc0de session list --format json`.",
      options.maxCount ? `Max count: ${options.maxCount.toLocaleString()}` : "",
      filterSummary ? `Filters: ${filterSummary}` : "",
      options.cursor
        ? "> BetterC0de lists local sessions directly; BetterC0de opaque cursors are accepted for compatibility but not replayed."
        : "",
      "",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
    ]
      .filter(Boolean)
      .join("\n")
  }

  const rows = visibleThreads.map((thread) => {
    const marker = thread.id === activeThreadId ? "Active" : ""
    const shortId = thread.id.slice(0, 8)
    const title = escapeMarkdownTableCell(thread.title || "Untitled")
    const project = escapeMarkdownTableCell(
      thread.projectName || thread.projectPath || "BetterC0de"
    )
    return `| \`${shortId}\` | ${title} | ${project} | ${formatSessionTime(thread.updatedAt)} | ${marker} |`
  })
  return [
    "# Sessions\n",
    "Compatibility reference: `betterc0de session list`.",
    "Recent chats. Use `/resume <id>` or `/continue <title>` to switch.",
    "",
    filterSummary ? `Filters: ${filterSummary}` : "",
    options.cursor
      ? "> BetterC0de lists local sessions directly; BetterC0de opaque cursors are accepted for compatibility but not replayed."
      : "",
    filterSummary || options.cursor ? "" : "",
    options.maxCount
      ? `Showing up to ${options.maxCount.toLocaleString()} sessions.`
      : "Showing the 12 most recent sessions. Use `/sessions --max-count 50` or `/sessions --format json` for more.",
    "",
    "| ID | Title | Project | Updated | |",
    "|:---|:------|:--------|:--------|:--|",
    ...rows,
  ].join("\n")
}

function filterSessionThreads(
  threads: ReadonlyArray<SlashSessionThread>,
  options: SessionListOptions
): SlashSessionThread[] {
  const search = options.search?.trim().toLowerCase()
  const pathFilter = options.path?.trim().toLowerCase()
  const start = options.start
  return [...threads]
    .filter((thread) => {
      if (search) {
        const haystack = [
          thread.id,
          thread.title,
          thread.projectName ?? "",
          thread.projectPath ?? "",
        ]
          .join("\n")
          .toLowerCase()
        if (!haystack.includes(search)) return false
      }
      if (pathFilter) {
        const projectPath = (thread.projectPath ?? "").toLowerCase()
        if (!projectPath.includes(pathFilter)) return false
      }
      if (options.roots === true && thread.parentThreadId) return false
      if (options.roots === false && !thread.parentThreadId) return false
      if (typeof start === "number") {
        const updated = Date.parse(thread.updatedAt)
        if (!Number.isFinite(updated) || updated < start) return false
      }
      return true
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt)
      const rightTime = Date.parse(right.updatedAt)
      const diff =
        (Number.isFinite(leftTime) ? leftTime : 0) -
        (Number.isFinite(rightTime) ? rightTime : 0)
      return options.order === "asc" ? diff : -diff
    })
}

function sessionListFilterSummary(options: SessionListOptions): string {
  const filters = [
    options.order ? `order=${options.order}` : "",
    options.search ? `search=${options.search}` : "",
    options.path ? `path=${options.path}` : "",
    options.roots !== undefined ? `roots=${String(options.roots)}` : "",
    typeof options.start === "number" ? `start=${options.start}` : "",
  ].filter(Boolean)
  return filters.join(", ")
}

export interface ChatPendingApproval {
  requestId: string
  providerKind: string
  providerInstanceId?: string
  pluginId?: string
  toolName?: string
  requestKind?: string
  input?: unknown
  createdAt?: string
}

/**
 * Open tool approvals of a chat. Which requests are open is derived by the
 * shared `derivePendingRequests` (also used by the approval cards and the
 * phone); this only maps them to what the slash commands show.
 */
export function deriveChatPendingApprovals(
  activities: ReadonlyArray<ThreadActivity>
): ChatPendingApproval[] {
  return derivePendingRequests(activities, { kinds: ["approval"] }).map(
    (request) => {
      const { payload } = request
      return {
        requestId: request.requestId,
        providerKind: request.providerKind ?? "claude",
        providerInstanceId: request.providerInstanceId,
        pluginId: approvalStringFrom(payload.pluginId),
        toolName:
          approvalStringFrom(payload.toolName) ??
          approvalStringFrom(payload.tool_name) ??
          approvalStringFrom(payload.tool),
        requestKind: approvalStringFrom(payload.requestKind),
        input: inputFromApprovalPayload(payload),
        createdAt: request.createdAt,
      }
    }
  )
}

export interface ChatPendingUserInputQuestion {
  id: string
  header?: string
  text: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

export interface ChatPendingUserInput {
  requestId: string
  providerKind: string
  providerInstanceId?: string
  questions: ChatPendingUserInputQuestion[]
  createdAt?: string
}

/**
 * Open provider questions (`user_input` requests) of a chat, derived by the
 * shared `derivePendingRequests` like the questions panel and the phone.
 */
export function deriveChatPendingUserInputs(
  activities: ReadonlyArray<ThreadActivity>
): ChatPendingUserInput[] {
  return derivePendingRequests(activities, { kinds: ["user-input"] }).map(
    (request) => ({
      requestId: request.requestId,
      providerKind: request.providerKind ?? "claude",
      providerInstanceId: request.providerInstanceId,
      questions: pendingUserInputQuestions(request),
      createdAt: request.createdAt,
    })
  )
}

/**
 * The request's questions. A request that carries none still waits for an
 * answer, so it asks for one free-text answer keyed by the request id, as the
 * questions panel and the phone do.
 */
function pendingUserInputQuestions(
  request: PendingProviderRequest
): ChatPendingUserInputQuestion[] {
  const { payload } = request
  const questions = Array.isArray(payload.questions)
    ? payload.questions
        .map((question, index) =>
          normalizePendingUserInputQuestion(question, index)
        )
        .filter(
          (question): question is ChatPendingUserInputQuestion =>
            question !== null
        )
    : []
  if (questions.length > 0) return questions
  return [
    {
      id: request.requestId,
      text:
        approvalStringFrom(payload.description) ??
        approvalStringFrom(payload.detail) ??
        approvalStringFrom(request.activity.summary) ??
        "Enter answer",
      options: [],
    },
  ]
}

function normalizePendingUserInputQuestion(
  raw: unknown,
  index: number
): ChatPendingUserInputQuestion | null {
  const record = approvalRecord(raw)
  const text =
    approvalStringFrom(record.question) ??
    approvalStringFrom(record.text) ??
    approvalStringFrom(record.header) ??
    `Question ${index + 1}`
  const id =
    approvalStringFrom(record.id) ??
    slugifyRuntimeId(approvalStringFrom(record.header) ?? text) ??
    `question-${index + 1}`
  const header = approvalStringFrom(record.header)
  const options = Array.isArray(record.options)
    ? record.options
        .map(normalizePendingUserInputOption)
        .filter(
          (option): option is { label: string; description?: string } =>
            option !== null
        )
    : []
  return {
    id,
    ...(header ? { header } : {}),
    text,
    options,
    ...(record.multiSelect === true ? { multiSelect: true } : {}),
  }
}

function normalizePendingUserInputOption(
  raw: unknown
): { label: string; description?: string } | null {
  if (typeof raw === "string" && raw.trim()) return { label: raw.trim() }
  const record = approvalRecord(raw)
  const label = approvalStringFrom(record.label)
  if (!label) return null
  const description = approvalStringFrom(record.description)
  return description ? { label, description } : { label }
}

export function approvalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function approvalStringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined
}

function inputFromApprovalPayload(
  payload: Record<string, unknown>
): unknown | undefined {
  if (payload.input !== undefined) return payload.input
  const item = approvalRecord(payload.item)
  if (item.input !== undefined) return item.input
  const data = approvalRecord(payload.data)
  if (data.input !== undefined) return data.input
  const itemData = approvalRecord(item.data)
  if (itemData.input !== undefined) return itemData.input
  return undefined
}

export function shortApprovalId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}...` : value
}

export function compareThreadActivities(
  a: ThreadActivity,
  b: ThreadActivity
): number {
  const aSeq =
    typeof a.sequence === "number" ? a.sequence : Number.NEGATIVE_INFINITY
  const bSeq =
    typeof b.sequence === "number" ? b.sequence : Number.NEGATIVE_INFINITY
  if (aSeq !== bSeq) return aSeq - bSeq
  const created = a.createdAt.localeCompare(b.createdAt)
  if (created !== 0) return created
  return a.id.localeCompare(b.id)
}

export interface ChatTodoItem {
  text: string
  status: string
}

export function deriveChatTodosFromActivities(
  activities: ReadonlyArray<ThreadActivity>
): ChatTodoItem[] {
  const latestPlan = [...activities]
    .sort(compareThreadActivities)
    .filter(
      (activity) =>
        activity.kind === "turn.plan.updated" ||
        activity.kind === "turn_plan_updated"
    )
    .at(-1)
  if (!latestPlan) return []
  return todoItemsFromPlan(approvalRecord(latestPlan.payload).plan)
}

export interface ChatSessionStatusSnapshot {
  thread: ChatThread | null
  activities?: ReadonlyArray<ThreadActivity>
  stream?: ThreadStreamState | null
}

export function buildSessionStatusOutputFromSnapshot(
  snapshot: ChatSessionStatusSnapshot
): string {
  const { thread } = snapshot
  if (!thread) {
    return [
      "# Session Status\n",
      "Compatibility reference: `session.status`.",
      "",
      "> No active chat is open.",
    ].join("\n")
  }

  const activities = snapshot.activities ?? []
  const stream = snapshot.stream ?? null
  const approvals = deriveChatPendingApprovals(activities)
  const questions = deriveChatPendingUserInputs(activities)
  const streamTodos = todoItemsFromStreamingTasks(stream?.streamingTasks)
  const todos =
    streamTodos.length > 0
      ? streamTodos
      : deriveChatTodosFromActivities(activities)
  const userMessages = thread.messages.filter(
    (message) => message.role === "user"
  )
  const assistantMessages = thread.messages.filter(
    (message) => message.role === "assistant"
  )
  const pendingInlineQuestions = stream?.pendingQuestions?.length ?? 0

  const rows = [
    ["Thread", sessionStatusCodeCell(thread.id)],
    ["Title", sessionStatusTextCell(thread.title || "Untitled")],
    ["Project", sessionStatusTextCell(thread.projectName || "-")],
    [
      "Workspace",
      sessionStatusCodeCell(thread.worktreePath ?? thread.projectPath ?? null),
    ],
    ["Branch", sessionStatusCodeCell(thread.branch ?? null)],
    ["State", sessionStatusTextCell(formatSessionStreamingState(stream))],
    ["Active turn", sessionStatusCodeCell(stream?.activeTurnId ?? null)],
    [
      "Streaming model",
      sessionStatusCodeCell(stream?.streamingModelId ?? null),
    ],
    ["Messages", String(thread.messages.length)],
    ["User messages", String(userMessages.length)],
    ["Assistant messages", String(assistantMessages.length)],
    ["Activities", String(activities.length)],
    ["Pending approvals", String(approvals.length)],
    ["Pending questions", String(questions.length)],
    ["Inline questions", String(pendingInlineQuestions)],
    ["Todos", String(todos.length)],
    ["Streaming tools", String(stream?.streamingTools?.length ?? 0)],
    ["Streaming tasks", String(stream?.streamingTasks?.length ?? 0)],
    ["Streaming diffs", String(stream?.streamingDiffs?.length ?? 0)],
    ["Text chars", String(stream?.streamingText?.length ?? 0)],
    ["Reasoning chars", String(stream?.reasoningText?.length ?? 0)],
    ["Updated", sessionStatusCodeCell(thread.updatedAt ?? null)],
  ]

  const lines = [
    "# Session Status\n",
    "Compatibility reference: `session.status`.",
    "",
    "| Field | Value |",
    "|:------|:------|",
    ...rows.map(([field, value]) => `| ${field} | ${value} |`),
  ]

  if (approvals.length > 0 || questions.length > 0 || todos.length > 0) {
    lines.push("", "## Active Work")
    if (approvals.length > 0) {
      lines.push(
        `- Approvals: ${approvals
          .map(
            (approval) =>
              `\`${escapeInlineCode(shortApprovalId(approval.requestId))}\``
          )
          .join(", ")}`
      )
    }
    if (questions.length > 0) {
      lines.push(
        `- Questions: ${questions
          .map(
            (input) =>
              `\`${escapeInlineCode(shortApprovalId(input.requestId))}\``
          )
          .join(", ")}`
      )
    }
    if (todos.length > 0) {
      lines.push(
        `- Todos: ${todos
          .slice(0, 3)
          .map((todo) => `${formatTodoStatus(todo.status)} - ${todo.text}`)
          .join("; ")}${todos.length > 3 ? `; +${todos.length - 3} more` : ""}`
      )
    }
  }

  return lines.join("\n")
}

export function formatSessionStreamingState(
  stream: ThreadStreamState | null | undefined
): string {
  if (!stream?.isStreaming) return "idle"
  if (stream.isPlanStreaming) return "planning"
  if (stream.isReasoning) return "reasoning"
  return "streaming"
}

function sessionStatusCodeCell(value: string | null | undefined): string {
  if (!value) return "-"
  return `\`${escapeMarkdownTableCell(escapeInlineCode(value))}\``
}

function sessionStatusTextCell(value: string): string {
  return escapeMarkdownTableCell(value)
}

function todoItemsFromPlan(plan: unknown): ChatTodoItem[] {
  if (!Array.isArray(plan)) return []
  return plan.flatMap((item) => {
    const record = approvalRecord(item)
    const text =
      approvalStringFrom(record.step) ??
      approvalStringFrom(record.content) ??
      approvalStringFrom(record.text) ??
      approvalStringFrom(record.title)
    if (!text) return []
    return [
      {
        text,
        status:
          approvalStringFrom(record.status) ??
          approvalStringFrom(record.state) ??
          "pending",
      },
    ]
  })
}

export function todoItemsFromStreamingTasks(
  tasks: { text: string; completed: boolean }[] | undefined
): ChatTodoItem[] {
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((task) => {
    if (!task.text) return []
    return [
      { text: task.text, status: task.completed ? "completed" : "pending" },
    ]
  })
}

export function formatTodoStatus(status: string): string {
  const normalized = status.toLowerCase().replace(/[_\s-]+/g, "-")
  if (normalized === "completed" || normalized === "done") return "Done"
  if (normalized === "in-progress" || normalized === "running") {
    return "In progress"
  }
  if (normalized === "cancelled" || normalized === "canceled") return "Canceled"
  return status ? status[0]!.toUpperCase() + status.slice(1) : "Pending"
}

export interface StatsCommandOptions {
  days?: number
  projectPath?: string | null
  toolLimit?: number
  modelLimit?: number
  terminalCommand?: string
  validation?: string[]
}

export function buildThreadStatsOutput(
  stats: ThreadUsageStats,
  options: StatsCommandOptions = {}
): string {
  if ((options.validation?.length ?? 0) > 0) {
    return [
      "# Usage Stats",
      "",
      "Compatibility reference: `betterc0de stats`.",
      "",
      "## Validation",
      "",
      ...(options.validation ?? []).map((item) => `- ${item}`),
      options.terminalCommand
        ? [
            "",
            "## Terminal",
            "",
            "```sh",
            options.terminalCommand,
            "```",
            "",
            "> Opened the terminal panel with this BetterC0de stats command prefilled.",
          ].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (stats.totalSessions === 0) {
    return [
      "# Usage Stats",
      "",
      "Compatibility reference: `betterc0de stats`.",
      "",
      "> No persisted chat sessions matched this stats query.",
    ].join("\n")
  }

  const modelRows = Object.entries(stats.modelUsage)
    .sort(([, left], [, right]) => right.messages - left.messages)
    .slice(0, statsDisplayLimit(options.modelLimit, 0))
    .map(([model, usage]) => {
      const tokens =
        usage.tokens.input +
        usage.tokens.output +
        usage.tokens.reasoning +
        usage.tokens.cache.read +
        usage.tokens.cache.write
      return `| \`${escapeMarkdownTableCell(model)}\` | ${usage.messages.toLocaleString()} | ${formatStatsNumber(tokens)} | ${formatStatsCost(usage.cost)} |`
    })

  const toolRows = Object.entries(stats.toolUsage)
    .sort(([, left], [, right]) => right - left)
    .slice(0, statsDisplayLimit(options.toolLimit, Number.MAX_SAFE_INTEGER))
    .map(
      ([tool, count]) =>
        `| \`${escapeMarkdownTableCell(tool)}\` | ${count.toLocaleString()} |`
    )

  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write

  return [
    "# Usage Stats",
    "",
    "Compatibility reference: `betterc0de stats`.",
    "",
    options.days !== undefined
      ? `Window: **${options.days <= 0 ? "today" : `${options.days} day${options.days === 1 ? "" : "s"}`}**`
      : "Window: **all persisted sessions**",
    options.projectPath
      ? `Project: \`${escapeMarkdownTableCell(options.projectPath)}\``
      : "",
    options.modelLimit !== undefined
      ? `Models: **${formatStatsLimit(options.modelLimit)}**`
      : "",
    options.toolLimit !== undefined
      ? `Tools: **${formatStatsLimit(options.toolLimit)}**`
      : "",
    "",
    "| Overview | Value |",
    "|:---------|------:|",
    `| Sessions | ${stats.totalSessions.toLocaleString()} |`,
    `| Messages | ${stats.totalMessages.toLocaleString()} |`,
    `| Days | ${stats.days.toLocaleString()} |`,
    stats.dateRange.earliest
      ? `| First session | ${formatStatsDate(stats.dateRange.earliest)} |`
      : "",
    stats.dateRange.latest
      ? `| Last session | ${formatStatsDate(stats.dateRange.latest)} |`
      : "",
    "",
    "| Cost & Tokens | Value |",
    "|:--------------|------:|",
    `| Total cost | ${formatStatsCost(stats.totalCost)} |`,
    `| Avg cost/day | ${formatStatsCost(stats.costPerDay)} |`,
    `| Total tokens | ${formatStatsNumber(totalTokens)} |`,
    `| Avg tokens/session | ${formatStatsNumber(Math.round(stats.tokensPerSession))} |`,
    `| Median tokens/session | ${formatStatsNumber(Math.round(stats.medianTokensPerSession))} |`,
    `| Input | ${formatStatsNumber(stats.totalTokens.input)} |`,
    `| Output | ${formatStatsNumber(stats.totalTokens.output)} |`,
    `| Reasoning | ${formatStatsNumber(stats.totalTokens.reasoning)} |`,
    `| Cache read | ${formatStatsNumber(stats.totalTokens.cache.read)} |`,
    `| Cache write | ${formatStatsNumber(stats.totalTokens.cache.write)} |`,
    "",
    "## Model Usage",
    options.modelLimit === undefined
      ? "> Model usage is hidden by default for a compact BetterC0de view. Use `/stats --models` or `/stats --models <n>` to show it."
      : modelRows.length > 0
        ? [
            "| Model | Messages | Tokens | Cost |",
            "|:------|---------:|-------:|-----:|",
            ...modelRows,
          ].join("\n")
        : "> No per-model usage recorded yet.",
    "",
    "## Tool Usage",
    toolRows.length > 0
      ? ["| Tool | Calls |", "|:-----|------:|", ...toolRows].join("\n")
      : "> No tool usage recorded yet.",
    options.terminalCommand
      ? [
          "",
          "## Terminal",
          "",
          "```sh",
          options.terminalCommand,
          "```",
          "",
          "> Opened the terminal panel with this BetterC0de stats command prefilled.",
        ].join("\n")
      : "",
    "",
    "> Use `/stats --days 7`, `/stats --today`, `/stats --current-project`, `/stats --tools 5`, or `/stats --models 10` to filter.",
  ]
    .filter(Boolean)
    .join("\n")
}

function statsDisplayLimit(
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER
  return Math.max(0, Math.floor(value))
}

function formatStatsLimit(value: number): string {
  if (!Number.isFinite(value)) return "all"
  return Math.max(0, Math.floor(value)).toLocaleString("en-US")
}

function formatStatsCost(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00"
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

function formatStatsNumber(value: number): string {
  if (!Number.isFinite(value)) return "0"
  return Math.round(value).toLocaleString("en-US")
}

function formatStatsDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function formatSessionTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}
