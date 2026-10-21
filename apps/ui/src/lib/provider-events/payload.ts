/**
 * Readers over the untyped provider event payload: ids, tool names,
 * canonical item flattening, usage and request kinds. Pure; no store access.
 */

import { asRecord, readString } from "@betterc0de/schema"
import { deriveProviderToolActivityPresentation } from "@betterc0de/schema/tool-activity"
import { providerKindFromDriver } from "@betterc0de/schema/provider-kind"

export function payloadTurnId(payload: Record<string, unknown>) {
  return readString(payload, "turn_id", "turnId")
}

export function backendOwnedFinalizeOptions(
  threadId: string,
  turnId?: string | null,
  interactionSegment = false
) {
  return {
    persist: false as const,
    ...(turnId && !interactionSegment
      ? {
          messageId: `provider-assistant:${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`,
        }
      : {}),
  }
}

export function payloadToolId(payload: Record<string, unknown>) {
  return readString(payload, "tool_id", "toolId", "id")
}

export function payloadToolName(payload: Record<string, unknown>) {
  return readString(payload, "tool_name", "toolName", "tool") ?? "tool"
}

export function providerKindFromPayload(payload: Record<string, unknown>) {
  return (
    providerKindFromDriver(
      readString(payload, "providerKind", "provider_kind")
    ) ?? providerKindFromDriver(readString(payload, "provider"))
  )
}

export function providerInstanceIdFromPayload(
  payload: Record<string, unknown>
) {
  return readString(payload, "providerInstanceId", "provider_instance_id")
}

export function correlationFromPayload(payload: Record<string, unknown>) {
  return {
    sessionId: readString(payload, "sessionId", "session_id"),
    taskId: readString(payload, "taskId", "task_id"),
    parentTaskId: readString(payload, "parentTaskId", "parent_task_id"),
    agentId: readString(payload, "agentId", "agent_id"),
    parentAgentId: readString(payload, "parentAgentId", "parent_agent_id"),
    parentToolId: readString(payload, "parentToolId", "parent_tool_id"),
  }
}

export function flattenCanonicalPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const nested = asRecord(payload.payload)
  return {
    ...payload,
    ...nested,
    turn_id: payload.turnId ?? payload.turn_id,
  }
}

function canonicalItemToolName(
  flat: Record<string, unknown>,
  itemType: string | undefined
): string {
  const kind = readString(flat, "kind")
  if (kind?.startsWith("tool:")) return kind.slice("tool:".length)
  const data = asRecord(flat.data)
  return (
    readString(flat, "tool_name", "toolName", "title") ??
    readString(data, "toolName", "tool_name", "name") ??
    itemType ??
    "tool"
  )
}

function canonicalItemInput(
  flat: Record<string, unknown>,
  options?: { detailFallback?: boolean; emptyFallback?: boolean }
): unknown {
  const data = asRecord(flat.data)
  if (flat.input !== undefined) return flat.input
  if (data.input !== undefined) return data.input
  if (data.rawInput !== undefined) return data.rawInput
  if (data.raw_input !== undefined) return data.raw_input
  if (flat.data !== undefined) return flat.data
  if (
    options?.detailFallback !== false &&
    flat.itemType === "command_execution" &&
    typeof flat.detail === "string"
  ) {
    return { command: flat.detail }
  }
  if (options?.emptyFallback === false) return undefined
  return {}
}

function canonicalItemOutput(flat: Record<string, unknown>): unknown {
  const data = asRecord(flat.data)
  if (flat.output !== undefined) return flat.output
  if (flat.result !== undefined) return flat.result
  if (data.output !== undefined) return data.output
  if (data.result !== undefined) return data.result
  if (data.rawOutput !== undefined) return data.rawOutput
  if (data.raw_output !== undefined) return data.raw_output
  if (flat.data !== undefined) return flat.data
  if (flat.detail !== undefined) return flat.detail
  return {}
}

export function normalizeCanonicalItemEvent(
  type: string,
  payload: Record<string, unknown>
): { type: string; payload: Record<string, unknown> } {
  const flat = flattenCanonicalPayload(payload)
  const itemType = readString(flat, "itemType", "item_type", "kind")
  if (!isToolLifecycleItemType(itemType)) {
    return { type, payload: flat }
  }
  const toolId =
    readString(flat, "tool_id", "toolId", "itemId", "item_id", "eventId") ??
    readString(flat, "id")
  const toolName = canonicalItemToolName(flat, itemType)
  const common = {
    ...flat,
    tool_id: toolId,
    tool_name: toolName,
    ...(itemType ? { itemType } : {}),
    item: flat.payload ?? flat.item ?? flat,
    turn_id: flat.turn_id ?? flat.turnId,
  }
  if (type === "item.started") {
    return {
      type: "tool_call",
      payload: {
        ...common,
        input: canonicalItemInput(flat),
        started_at: flat.startedAt ?? flat.started_at ?? flat.at,
      },
    }
  }
  if (type === "item.completed") {
    return {
      type: "tool_result",
      payload: {
        ...common,
        canonicalItemLifecycle: "completed",
        output: canonicalItemOutput(flat),
        completed_at: flat.completedAt ?? flat.completed_at ?? flat.at,
      },
    }
  }
  if (type === "item.updated") {
    return {
      type: "tool_call_delta",
      payload: {
        ...common,
        input: canonicalItemInput(flat, {
          detailFallback: false,
          emptyFallback: false,
        }),
        output_delta: flat.output_delta ?? flat.delta ?? flat.detail,
      },
    }
  }
  return { type, payload: flat }
}

export function truncateDetail(
  value: string | undefined,
  limit = 180
): string | undefined {
  if (!value) return undefined
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value
}

/**
 * True when a `tool_call_delta` payload carries the tool's whole output so
 * far rather than one more chunk (twin of the backend's
 * `isCumulativeToolOutputPayload` in `activity-projection/shared.ts`): either the
 * bridge marked it (`cumulative`, set for item snapshots such as Codex
 * `patchUpdated`) or, for older rows, the ACP shape where `detail` is
 * mirrored verbatim into `output_delta`. Decides both the activity row key
 * and whether the streaming tool card replaces or appends its output —
 * appending a cumulative snapshot showed `npm testnpm testnpm test`.
 */
export function isCumulativeToolOutputPayload(
  payload: Record<string, unknown>
): boolean {
  if (payload.cumulative === true) return true
  const delta = payload.output_delta ?? payload.delta
  return (
    typeof delta === "string" &&
    delta.length > 0 &&
    typeof payload.detail === "string" &&
    payload.detail === delta
  )
}

/**
 * Row key for a `tool.updated` activity (twin of the backend's
 * `toolUpdateActivityKey` in `activity-projection/shared.ts`).
 *
 * Keyed by the tool call only when the payload is cumulative — an ACP
 * `item.updated` mirrors the whole `detail` so far into `output_delta`, so
 * replacing one row is right. A Codex `tool.delta` is one chunk, and the
 * transcript concatenates `output_delta` across rows; keying chunks by tool
 * id collapsed streamed output to its last chunk. A chunk keeps its own row.
 */
export function toolUpdateActivityKey(
  payload: Record<string, unknown>,
  toolId: string | undefined,
  sequence: number
): string | number {
  if (!toolId) return sequence
  const delta = payload.output_delta ?? payload.delta
  if (typeof delta !== "string" || delta.length === 0) return toolId
  return isCumulativeToolOutputPayload(payload) ? toolId : sequence
}

export function outputDetail(
  payload: Record<string, unknown>
): string | undefined {
  return truncateDetail(
    readString(
      payload,
      "stderr",
      "stdout",
      "output",
      "details",
      "detail",
      "message"
    )
  )
}

export function payloadNumber(
  payload: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

export function usagePayload(
  payload: Record<string, unknown>
): Record<string, unknown> | null {
  const rawUsage = asRecord(payload.usage)
  const source = Object.keys(rawUsage).length > 0 ? rawUsage : payload
  const inputTokens = payloadNumber(source, "inputTokens", "input_tokens") ?? 0
  const outputTokens =
    payloadNumber(source, "outputTokens", "output_tokens") ?? 0
  const usedTokens =
    payloadNumber(
      source,
      "usedTokens",
      "used_tokens",
      "totalTokens",
      "total_tokens"
    ) ?? inputTokens + outputTokens
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
    ["cacheReadTokens", ["cacheReadTokens", "cache_read_tokens"]],
    ["cacheCreationTokens", ["cacheCreationTokens", "cache_creation_tokens"]],
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
    const value = payloadNumber(source, ...keys)
    if (value !== undefined) out[target] = value
  }
  const compactsAutomatically =
    source.compactsAutomatically ?? source.compacts_automatically
  if (typeof compactsAutomatically === "boolean")
    out.compactsAutomatically = compactsAutomatically
  return out
}

export function isToolLifecycleItemType(value: string | undefined): boolean {
  const itemType = (value ?? "").toLowerCase()
  return (
    itemType.includes("command") ||
    itemType.includes("tool") ||
    itemType.includes("file") ||
    itemType.includes("search") ||
    itemType.includes("read") ||
    itemType.includes("write") ||
    itemType.includes("patch")
  )
}

export function requestKind(toolName: string | undefined, input: unknown) {
  const normalized = (toolName ?? "").toLowerCase()
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("file_change")
  ) {
    return "file-change"
  }
  if (
    normalized.includes("read") ||
    normalized.includes("grep") ||
    normalized.includes("search") ||
    normalized.includes("glob")
  ) {
    return "file-read"
  }
  if (
    typeof record.command === "string" ||
    normalized.includes("bash") ||
    normalized.includes("exec")
  ) {
    return "command"
  }
  return "command"
}

export function requestKindFromCanonicalRequestType(
  requestType: string | undefined
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command"
    case "file_read_approval":
      return "file-read"
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change"
    default:
      return undefined
  }
}

export function approvalRequestedSummary(
  canonicalRequestKind: "command" | "file-read" | "file-change" | undefined,
  toolName: string | undefined
): string {
  switch (canonicalRequestKind) {
    case "command":
      return "Command approval requested"
    case "file-read":
      return "File-read approval requested"
    case "file-change":
      return "File-change approval requested"
    default:
      return toolName
        ? `Approval required for ${toolName}`
        : "Approval required"
  }
}

export function toolPresentationFromPayload(payload: Record<string, unknown>) {
  const toolName = payloadToolName(payload)
  return deriveProviderToolActivityPresentation({
    toolName,
    title: readString(payload, "title") ?? toolName,
    detail: readString(payload, "detail"),
    input: payload.input,
    output: payload.output,
    rawInput: payload.rawInput ?? payload.raw_input,
    rawOutput: payload.rawOutput ?? payload.raw_output,
    kind: readString(payload, "kind"),
    itemType: readString(payload, "itemType", "item_type"),
    data: payload,
    fallbackSummary: toolName,
  })
}

function stableTextHash(text: string | undefined): string | undefined {
  if (!text) return undefined
  let hash = 2166136261
  for (let idx = 0; idx < text.length; idx += 1) {
    hash ^= text.charCodeAt(idx)
    hash = Math.imul(hash, 16777619)
  }
  return `hash-${(hash >>> 0).toString(36)}`
}

function proposedPlanStableId(
  payload: Record<string, unknown>
): string | undefined {
  return stableTextHash(readString(payload, "planMarkdown", "plan_markdown"))
}

export function proposedPlanIdFromPayload(
  threadId: string,
  payload: Record<string, unknown>
): string | undefined {
  const explicitPlanId = readString(payload, "planId", "plan_id")
  if (explicitPlanId) return explicitPlanId

  const turnId = payloadTurnId(payload)
  if (turnId) return `plan:${threadId}:turn:${turnId}`

  const itemId = readString(payload, "itemId", "item_id")
  if (itemId) return `plan:${threadId}:item:${itemId}`

  const eventId = readString(payload, "eventId", "event_id")
  if (eventId) return `plan:${threadId}:event:${eventId}`

  const hash = proposedPlanStableId(payload)
  return hash ? `plan:${threadId}:content:${hash}` : undefined
}
