import type { CodexNativeEvent } from "../CodexSessionRuntime"
import type { ProviderRuntimeEvent } from "../../contracts"
import { randomUUID } from "node:crypto"

/**
 * Field readers, normalisers and the event `base()` every translator family
 * shares. Nothing here decides what a Codex notification *means*.
 */
export function readStringField(
  value: unknown,
  keys: readonly string[],
  depth = 0
): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || depth > 4) return ""
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const direct = record[key]
    if (typeof direct === "string") return direct
  }
  for (const key of keys) {
    const nested = readStringField(record[key], keys, depth + 1)
    if (nested) return nested
  }
  return ""
}

export function readOptionalString(
  value: unknown,
  keys: readonly string[]
): string | undefined {
  const text = readStringField(value, keys).trim()
  return text.length > 0 ? text : undefined
}

export function readOptionalNumber(
  value: unknown,
  keys: readonly string[]
): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const direct = record[key]
    if (typeof direct === "number" && Number.isFinite(direct)) return direct
  }
  return undefined
}

export function readOptionalBoolean(
  value: unknown,
  keys: readonly string[]
): boolean | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const direct = record[key]
    if (typeof direct === "boolean") return direct
  }
  return undefined
}

export function readNumberFromRecord(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

export function readDelta(params: unknown): string {
  const deltaKeys = [
    "delta",
    "textDelta",
    "text",
    "thinking",
    "summary",
    "content",
    "output",
  ] as const
  const direct = readStringField(params, deltaKeys)
  if (direct) return direct
  const event = (params as { event?: unknown } | null)?.event
  const fromEvent = readStringField(event, deltaKeys)
  if (fromEvent) return fromEvent
  return ""
}

export function readBase64Text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return ""
  try {
    return Buffer.from(value, "base64").toString("utf8")
  } catch {
    return ""
  }
}

export function readItemKind(params: unknown): string {
  if (!params || typeof params !== "object") return ""
  const record = params as Record<string, unknown>
  const direct = record.type ?? record.kind ?? record.itemType
  if (typeof direct === "string") return direct
  const item = record.item
  if (item && typeof item === "object") {
    const itemType = (item as Record<string, unknown>).type
    if (typeof itemType === "string") return itemType
  }
  return ""
}

export function isReasoningDeltaNotification(
  method: string,
  params: unknown
): boolean {
  const lowered = method.toLowerCase()
  if (!lowered.includes("delta")) return false
  if (lowered.includes("reasoning")) return true
  return readItemKind(params).toLowerCase().includes("reasoning")
}

export function reasoningStreamKind(
  method: string,
  params: unknown
): "reasoning_text" | "reasoning_summary_text" {
  const lowered = method.toLowerCase()
  if (lowered.includes("summary")) return "reasoning_summary_text"
  if (params && typeof params === "object" && "summaryIndex" in params)
    return "reasoning_summary_text"
  return "reasoning_text"
}

export function readItemText(item: Record<string, unknown>): string {
  for (const key of ["text", "message", "content", "aggregatedText"]) {
    const v = item[key]
    if (typeof v === "string" && v.trim()) return v
  }
  const msg = item.message
  if (msg && typeof msg === "object") {
    const r = msg as Record<string, unknown>
    if (typeof r.text === "string" && r.text.trim()) return r.text
  }
  return ""
}

export function readReasoningSummary(summary: unknown): string {
  if (typeof summary === "string") return summary.trim()
  if (!Array.isArray(summary)) return ""
  return summary
    .map((e) => {
      if (typeof e === "string") return e
      if (
        e &&
        typeof e === "object" &&
        typeof (e as { text?: unknown }).text === "string"
      ) {
        return (e as { text: string }).text
      }
      return ""
    })
    .join("\n")
    .trim()
}

export function base(threadId: string): {
  threadId: string
  providerKind: "codex"
  eventId: string
  at: number
} {
  return {
    threadId,
    providerKind: "codex",
    eventId: randomUUID(),
    at: Date.now(),
  }
}

export function isTraceEnabled(): boolean {
  return process.env.BETTERC0DE_TRACE_PROVIDER_EVENTS === "1"
}

export function _logXlat(
  native: CodexNativeEvent,
  out: ProviderRuntimeEvent[]
): void {
  if (!isTraceEnabled()) return
  // [REASON-TRACE:CODEX-XLAT-OUT]
  const label = native.method ?? native.kind
  const produced = out.map((e) => e.type).join("|") || "DROPPED"
  console.log(
    `[REASON-TRACE:CODEX-XLAT-OUT] method=${label} producedTypes=${produced}`
  )
}

export function readToolId(item: Record<string, unknown>): string {
  return findToolId(item, 0) ?? randomUUID()
}

function findToolId(
  item: Record<string, unknown>,
  depth: number
): string | undefined {
  // Native notifications are untrusted JSON; nested aliases must have a bound.
  if (depth > 8) return undefined
  for (const key of [
    "id",
    "itemId",
    "item_id",
    "toolCallId",
    "tool_call_id",
    "callId",
    "call_id",
  ]) {
    const value = item[key]
    if (typeof value === "string" && value) return value
  }
  for (const key of ["item", "tool", "call"]) {
    const nested = item[key]
    if (nested && typeof nested === "object") {
      const id = findToolId(nested as Record<string, unknown>, depth + 1)
      if (id) return id
    }
  }
  return undefined
}

export function readItemId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of ["itemId", "item_id", "id"]) {
    const value = record[key]
    if (typeof value === "string" && value) return value
  }
  const item = record.item
  if (item && typeof item === "object") {
    const id = (item as Record<string, unknown>).id
    if (typeof id === "string" && id) return id
  }
  return undefined
}

export function readTurnId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of ["turnId", "turn_id"]) {
    const direct = record[key]
    if (typeof direct === "string" && direct) return direct
  }
  const turn = record.turn
  if (turn && typeof turn === "object") {
    const id = (turn as Record<string, unknown>).id
    if (typeof id === "string" && id) return id
  }
  return undefined
}

export function normalizeThreadState(method: string, params: unknown): string {
  if (method === "thread/archived") return "archived"
  if (method === "thread/closed") return "closed"
  if (method === "thread/compacted") return "compacted"
  const status = readOptionalString(params, ["status", "state"])
  return status ?? "active"
}

export function normalizeUsageSnapshot(
  raw: unknown
): Record<string, unknown> | null {
  const usage =
    raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).usage ??
        (raw as Record<string, unknown>).tokenUsage ??
        raw)
      : raw
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null
  const record = usage as Record<string, unknown>
  const inputTokens = readNumberFromRecord(
    record,
    "inputTokens",
    "input_tokens"
  )
  const outputTokens = readNumberFromRecord(
    record,
    "outputTokens",
    "output_tokens"
  )
  const usedTokens =
    readNumberFromRecord(
      record,
      "usedTokens",
      "used_tokens",
      "totalTokens",
      "total_tokens"
    ) ?? (inputTokens ?? 0) + (outputTokens ?? 0)
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return null
  const out: Record<string, unknown> = { usedTokens }
  const fields: Array<[string, string[]]> = [
    [
      "totalProcessedTokens",
      ["totalProcessedTokens", "total_processed_tokens"],
    ],
    ["maxTokens", ["maxTokens", "max_tokens"]],
    ["inputTokens", ["inputTokens", "input_tokens"]],
    ["cachedInputTokens", ["cachedInputTokens", "cached_input_tokens"]],
    ["outputTokens", ["outputTokens", "output_tokens"]],
    [
      "reasoningOutputTokens",
      ["reasoningOutputTokens", "reasoning_output_tokens"],
    ],
    ["lastUsedTokens", ["lastUsedTokens", "last_used_tokens"]],
    ["lastInputTokens", ["lastInputTokens", "last_input_tokens"]],
    [
      "lastCachedInputTokens",
      ["lastCachedInputTokens", "last_cached_input_tokens"],
    ],
    ["lastOutputTokens", ["lastOutputTokens", "last_output_tokens"]],
    [
      "lastReasoningOutputTokens",
      ["lastReasoningOutputTokens", "last_reasoning_output_tokens"],
    ],
    ["toolUses", ["toolUses", "tool_uses"]],
    ["durationMs", ["durationMs", "duration_ms"]],
    [
      "totalCostUsd",
      ["totalCostUsd", "total_cost_usd", "totalCost", "total_cost", "cost"],
    ],
  ]
  for (const [target, keys] of fields) {
    const value = readNumberFromRecord(record, ...keys)
    if (value !== undefined) out[target] = value
  }
  const compactsAutomatically =
    record.compactsAutomatically ?? record.compacts_automatically
  if (typeof compactsAutomatically === "boolean")
    out.compactsAutomatically = compactsAutomatically
  return out
}

export function normalizePlanSteps(
  raw: unknown
): Array<{ step: string; status: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null
      const record = entry as Record<string, unknown>
      const step = readOptionalString(record, ["step", "text", "description"])
      if (!step) return null
      const status = readOptionalString(record, ["status"]) ?? "pending"
      return { step, status: status === "inProgress" ? "in_progress" : status }
    })
    .filter(
      (entry): entry is { step: string; status: string } => entry !== null
    )
}

export function normalizeCodexToolName(item: Record<string, unknown>): string {
  for (const key of ["tool", "name", "toolName", "tool_name", "kind"]) {
    const value = item[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  const type = normalizeCodexItemType(item.type ?? item.itemType)
  if (type.includes("command")) return "shell"
  if (type.includes("file change") || type.includes("patch")) return "file_edit"
  if (type.includes("file read") || type.includes("read")) return "file_read"
  if (type.includes("search") || type.includes("grep")) return "search"
  if (type.includes("tool")) return "tool"
  return ""
}

export function normalizeCodexItemType(value: unknown): string {
  if (typeof value !== "string") return ""
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export function isCodexToolItem(item: Record<string, unknown>): boolean {
  const name = normalizeCodexToolName(item)
  if (name) return true
  const type = normalizeCodexItemType(item.type ?? item.itemType)
  return (
    type.includes("command") ||
    type.includes("file change") ||
    type.includes("file read") ||
    type.includes("tool") ||
    type.includes("function_call")
  )
}

export function compactCodexToolPayload(
  item: Record<string, unknown>
): Record<string, unknown> {
  const input =
    item.input ??
    item.arguments ??
    item.params ??
    item.command ??
    item.changes ??
    item.path
  if (input && typeof input === "object")
    return input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof item.command === "string") out.command = item.command
  if (typeof item.cwd === "string") out.cwd = item.cwd
  if (typeof item.path === "string") out.path = item.path
  if (item.changes !== undefined) out.changes = item.changes
  if (Object.keys(out).length > 0) return out
  return item
}

export function readToolOutput(item: Record<string, unknown>): unknown {
  for (const key of [
    "output",
    "result",
    "contentItems",
    "aggregatedOutput",
    "content",
    "text",
    "stdout",
    "stderr",
  ]) {
    if (item[key] !== undefined) return item[key]
  }
  return item
}

export function readToolError(item: Record<string, unknown>): string | null {
  const error = item.error
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message
    if (typeof message === "string" && message) return message
  }
  const status =
    typeof item.status === "string" ? item.status.toLowerCase() : ""
  if (status === "failed" || status === "error")
    return readStringField(item, ["message"]) || "Tool failed"
  return null
}

export function basename(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\\/g, "/")
  const leaf = normalized.split("/").filter(Boolean).pop()
  return leaf && leaf.length > 0 ? leaf : value
}

export function hookRun(params: unknown): Record<string, unknown> {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {}
  const run = record.run
  return run && typeof run === "object" && !Array.isArray(run)
    ? (run as Record<string, unknown>)
    : record
}

export function hookOutput(run: Record<string, unknown>): {
  output?: string
  stderr?: string
} {
  const direct =
    readOptionalString(run, ["output", "stdout", "statusMessage"]) ?? undefined
  const entries = Array.isArray(run.entries) ? run.entries : []
  const texts = entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return ""
      const record = entry as Record<string, unknown>
      const text = readOptionalString(record, ["text"])
      const kind = readOptionalString(record, ["kind"])
      return text ? (kind ? `[${kind}] ${text}` : text) : ""
    })
    .filter((entry) => entry.length > 0)
  const output = direct ?? (texts.length > 0 ? texts.join("\n") : undefined)
  const stderr = entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false
    const kind = readOptionalString(entry, ["kind"])
    return kind === "error"
  })
    ? output
    : undefined
  return {
    ...(output ? { output } : {}),
    ...(stderr ? { stderr } : {}),
  }
}

export function normalizeHookOutcome(
  status: string | undefined
): "success" | "error" | "cancelled" {
  const normalized = (status ?? "").toLowerCase()
  if (normalized === "failed" || normalized === "blocked") return "error"
  if (normalized === "stopped" || normalized === "cancelled") return "cancelled"
  return "success"
}

export function patchUpdatedDiff(params: unknown): {
  itemId: string
  turnId?: string
  delta: string
  detail?: string
} | null {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {}
  const changes = Array.isArray(record.changes) ? record.changes : []
  const deltas: string[] = []
  const paths: string[] = []
  for (const change of changes) {
    if (!change || typeof change !== "object") continue
    const entry = change as Record<string, unknown>
    const diff = readOptionalString(entry, ["diff"])
    const path = readOptionalString(entry, ["path"])
    if (diff) deltas.push(diff)
    if (path) paths.push(path)
  }
  const delta = deltas.join("\n")
  if (!delta) return null
  return {
    itemId:
      readRequestId(record, readOptionalString(record, ["itemId"])) ||
      randomUUID(),
    turnId: readTurnId(record),
    delta,
    ...(paths.length > 0 ? { detail: paths.join(", ") } : {}),
  }
}

export function readRequestId(value: unknown, fallback?: string): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of [
      "requestId",
      "request_id",
      "approvalId",
      "approval_id",
      "itemId",
      "item_id",
      "callId",
      "call_id",
    ]) {
      const raw = record[key]
      if (typeof raw === "number" && Number.isFinite(raw)) return String(raw)
    }
  }
  const direct = readOptionalString(value, [
    "requestId",
    "request_id",
    "approvalId",
    "approval_id",
    "itemId",
    "item_id",
    "callId",
    "call_id",
  ])
  return direct ?? fallback ?? ""
}

export function normalizeApprovalDecision(
  value: unknown
): "approve" | "deny" | "answer" {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? readOptionalString(value, ["decision", "outcome", "status"])
        : undefined
  const key = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  if (
    key === "deny" ||
    key === "denied" ||
    key === "decline" ||
    key === "declined" ||
    key === "reject" ||
    key === "rejected"
  ) {
    return "deny"
  }
  if (key === "answer" || key === "answered" || key === "userinput")
    return "answer"
  return "approve"
}

export function isFatalCodexProcessStderrMessage(message: string): boolean {
  return message.toLowerCase().includes("failed to connect to websocket")
}

export function normalizeUserInputQuestions(raw: unknown): Array<{
  id?: string
  header?: string
  question?: string
  text?: string
  options?: Array<string | { label: string; description?: string }>
  multiSelect?: boolean
}> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null
      const record = entry as Record<string, unknown>
      const question =
        typeof record.question === "string"
          ? record.question
          : typeof record.text === "string"
            ? record.text
            : ""
      const header =
        typeof record.header === "string" && record.header.length > 0
          ? record.header
          : question || `Question ${index + 1}`
      const id =
        typeof record.id === "string" && record.id.length > 0
          ? record.id
          : question || header
      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => {
              if (typeof option === "string") return option
              if (!option || typeof option !== "object") return null
              const opt = option as Record<string, unknown>
              const label = typeof opt.label === "string" ? opt.label : ""
              if (!label) return null
              const description =
                typeof opt.description === "string"
                  ? opt.description
                  : undefined
              return description ? { label, description } : { label }
            })
            .filter(
              (
                option
              ): option is string | { label: string; description?: string } =>
                option !== null
            )
        : []
      return {
        id,
        header,
        question,
        text: question || header,
        options,
        ...(typeof record.multiSelect === "boolean"
          ? { multiSelect: record.multiSelect }
          : {}),
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
}

export function normalizeMcpElicitationQuestions(
  params: Record<string, unknown>
): Array<{
  id?: string
  header?: string
  question?: string
  text?: string
  options?: Array<string | { label: string; description?: string }>
  multiSelect?: boolean
}> {
  const message =
    typeof params.message === "string" && params.message.trim()
      ? params.message.trim()
      : "MCP server requested input"
  const serverName =
    typeof params.serverName === "string" && params.serverName.trim()
      ? params.serverName.trim()
      : "MCP"
  if (params.mode === "url") {
    const url = typeof params.url === "string" ? params.url.trim() : ""
    return [
      {
        id:
          typeof params.elicitationId === "string" && params.elicitationId
            ? params.elicitationId
            : "url",
        header: `${serverName} request`,
        question: message,
        text: url ? `${message}\n${url}` : message,
      },
    ]
  }

  const schema =
    params.requestedSchema &&
    typeof params.requestedSchema === "object" &&
    !Array.isArray(params.requestedSchema)
      ? (params.requestedSchema as Record<string, unknown>)
      : null
  const properties =
    schema?.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : null
  if (!properties) {
    return [
      {
        id: "response",
        header: `${serverName} request`,
        question: message,
        text: message,
      },
    ]
  }

  const questions = Object.entries(properties)
    .map(([id, raw], index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
      const property = raw as Record<string, unknown>
      const title =
        typeof property.title === "string" && property.title.trim()
          ? property.title.trim()
          : id
      const description =
        typeof property.description === "string" && property.description.trim()
          ? property.description.trim()
          : undefined
      const options = mcpElicitationOptions(property)
      const multiSelect = property.type === "array"
      return {
        id,
        header: title || `Question ${index + 1}`,
        question: description ?? message,
        text: description ?? title ?? message,
        options,
        ...(multiSelect ? { multiSelect: true } : {}),
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  return questions.length > 0
    ? questions
    : [
        {
          id: "response",
          header: `${serverName} request`,
          question: message,
          text: message,
        },
      ]
}

export function mcpElicitationOptions(
  schema: Record<string, unknown>
): Array<string | { label: string; description?: string }> {
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : []
  if (enumValues.length > 0) return enumValues

  const nested =
    schema.type === "array" &&
    schema.items &&
    typeof schema.items === "object" &&
    !Array.isArray(schema.items)
      ? (schema.items as Record<string, unknown>)
      : schema
  const choices = Array.isArray(nested.oneOf)
    ? nested.oneOf
    : Array.isArray(nested.anyOf)
      ? nested.anyOf
      : []
  return choices
    .map((choice): string | { label: string; description?: string } | null => {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        return null
      }
      const record = choice as Record<string, unknown>
      const labelSource =
        typeof record.title === "string" && record.title.trim()
          ? record.title
          : typeof record.const === "string" && record.const.trim()
            ? record.const
            : ""
      const label = labelSource.trim()
      if (!label) return null
      const description =
        typeof record.description === "string" && record.description.trim()
          ? record.description.trim()
          : undefined
      return description ? { label, description } : label
    })
    .filter(
      (option): option is string | { label: string; description?: string } =>
        option !== null
    )
}
