/**
 * The tool steps of a turn, built from the thread's activities
 * (`tool.started`, `tool.updated`, `tool.completed`, `tool.failed`). The
 * desktop transcript and the phone app's live reply both show these, so a
 * step looks the same in both while it runs and after it finished.
 */

import { asRecord } from "./json-read"
import type { ThreadActivity } from "./domain"
import { extractToolOutputText, isGenericToolName } from "./tool-activity"

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

export function toolFailureText(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (depth > 3) return undefined
  const data = record(value)
  for (const key of ["message", "error", "stderr", "errorMessage", "detail"]) {
    const text = toolFailureText(data[key], depth + 1)
    if (text) return text
  }
  const exitCode = data.exit_code ?? data.exitCode
  return typeof exitCode === "number" && exitCode !== 0
    ? `Command exited with code ${exitCode}.`
    : undefined
}

export type ActivityTool = {
  id: string
  name: string
  /** Latest provider title; ACP providers change it per event. */
  title?: string
  /** The provider's own classification of the call (ACP `kind`). */
  kind?: string
  input: unknown
  output?: unknown
  state?: string
  providerKind?: string
  providerInstanceId?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  error?: string
  outputPreview?: string
  outputTruncated?: boolean
  outputBytes?: number
  outputLineCount?: number
  turnId?: string
  sessionId?: string
  taskId?: string
  parentTaskId?: string
  agentId?: string
  parentAgentId?: string
  parentToolId?: string
}

export function groupToolActivitiesByTurn(activities: ThreadActivity[]) {
  const groups = new Map<string, ThreadActivity[]>()
  for (const activity of activities) {
    if (!activity.turnId) continue
    if (!activity.kind.startsWith("tool.")) continue
    if (isPlanBoundaryToolActivity(activity)) continue
    const existing = groups.get(activity.turnId) ?? []
    existing.push(activity)
    groups.set(activity.turnId, existing)
  }
  return groups
}

export function buildActivityTools(
  activities: ThreadActivity[]
): ActivityTool[] {
  const byId = new Map<string, ActivityTool>()
  const activeFallbackIds = new Map<string, string>()
  for (const activity of [...activities].sort(compareActivities)) {
    const payload = asRecord(activity.payload)
    const explicitToolId =
      stringFrom(payload.toolId) ??
      stringFrom(payload.tool_id) ??
      stringFrom(payload.id) ??
      undefined
    const fallbackKey = explicitToolId
      ? undefined
      : fallbackToolLifecycleKey(activity, payload)
    const fallbackToolId = fallbackKey
      ? (activeFallbackIds.get(fallbackKey) ?? activity.id)
      : activity.id
    const toolId = explicitToolId ?? fallbackToolId
    if (
      fallbackKey &&
      activity.kind !== "tool.completed" &&
      activity.kind !== "tool.failed"
    ) {
      activeFallbackIds.set(fallbackKey, toolId)
    }
    const toolName =
      stringFrom(payload.toolName) ??
      stringFrom(payload.tool_name) ??
      stringFrom(payload.tool) ??
      stringFrom(payload.title) ??
      "tool"
    const title = stringFrom(payload.title)
    const kind =
      stringFrom(payload.kind) ?? stringFrom(objectFrom(payload.data)?.kind)
    const titled = {
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
    }
    const current =
      byId.get(toolId) ??
      ({
        id: toolId,
        name: toolName,
        ...titled,
        input: payload.input ?? {},
        providerKind: providerKindFromActivityPayload(payload),
        providerInstanceId: providerInstanceIdFromActivityPayload(
          activity,
          payload
        ),
        turnId: activity.turnId ?? undefined,
        ...activityCorrelationFields(payload),
        startedAt: activity.createdAt,
        state: "input-available",
      } satisfies ActivityTool)

    // The first real name sticks. Later events carry the provider's title,
    // which for an ACP search is the pattern itself — no basis for a name.
    const name = isGenericToolName(current.name) ? toolName : current.name

    if (activity.kind === "tool.started") {
      byId.set(toolId, {
        ...current,
        ...titled,
        name,
        input: payload.input ?? current.input,
        providerKind:
          providerKindFromActivityPayload(payload) ?? current.providerKind,
        providerInstanceId:
          providerInstanceIdFromActivityPayload(activity, payload) ??
          current.providerInstanceId,
        ...activityCorrelationFields(payload),
        startedAt: current.startedAt ?? activity.createdAt,
      })
      continue
    }

    if (activity.kind === "tool.updated") {
      const delta =
        stringFrom(payload.output_delta) ?? stringFrom(payload.delta)
      const nextInput = toolInputFromActivityPayload(payload) ?? current.input
      const nextOutput = delta
        ? `${stringPreview(current.output)}${delta}`
        : current.output
      byId.set(toolId, {
        ...current,
        ...titled,
        name,
        input: nextInput,
        providerKind:
          providerKindFromActivityPayload(payload) ?? current.providerKind,
        providerInstanceId:
          providerInstanceIdFromActivityPayload(activity, payload) ??
          current.providerInstanceId,
        ...activityCorrelationFields(payload),
        output: nextOutput,
        ...summarizeOutput(nextOutput),
      })
      continue
    }

    if (activity.kind === "tool.completed" || activity.kind === "tool.failed") {
      const output = payload.output ?? current.output
      const completedAt = activity.createdAt
      byId.set(toolId, {
        ...current,
        ...titled,
        name,
        providerKind:
          providerKindFromActivityPayload(payload) ?? current.providerKind,
        providerInstanceId:
          providerInstanceIdFromActivityPayload(activity, payload) ??
          current.providerInstanceId,
        ...activityCorrelationFields(payload),
        output,
        completedAt,
        error:
          activity.kind === "tool.failed"
            ? (toolFailureText(payload.error) ??
              toolFailureText(output) ??
              "Tool failed")
            : undefined,
        durationMs: toolDurationMs(current.startedAt, completedAt),
        state:
          activity.kind === "tool.failed" ? "output-error" : "output-available",
        ...summarizeOutput(output),
      })
      if (fallbackKey) activeFallbackIds.delete(fallbackKey)
    }
  }
  return [...byId.values()]
}

export function activityCorrelationFields(payload: Record<string, unknown>) {
  return {
    sessionId: stringFrom(payload.sessionId) ?? stringFrom(payload.session_id),
    taskId: stringFrom(payload.taskId) ?? stringFrom(payload.task_id),
    parentTaskId:
      stringFrom(payload.parentTaskId) ?? stringFrom(payload.parent_task_id),
    agentId: stringFrom(payload.agentId) ?? stringFrom(payload.agent_id),
    parentAgentId:
      stringFrom(payload.parentAgentId) ?? stringFrom(payload.parent_agent_id),
    parentToolId:
      stringFrom(payload.parentToolId) ?? stringFrom(payload.parent_tool_id),
  }
}

export function providerKindFromActivityPayload(
  payload: Record<string, unknown>
): string | undefined {
  return normalizeProviderKind(
    stringFrom(payload.providerKind) ??
      stringFrom(payload.provider_kind) ??
      stringFrom(payload.provider)
  )
}

export function providerInstanceIdFromActivityPayload(
  activity: ThreadActivity,
  payload: Record<string, unknown>
): string | undefined {
  return (
    stringFrom(payload.providerInstanceId) ??
    stringFrom(payload.provider_instance_id) ??
    stringFrom(activity.providerInstanceId)
  )
}

export function compareActivities(a: ThreadActivity, b: ThreadActivity) {
  const aSeq =
    typeof a.sequence === "number" ? a.sequence : Number.NEGATIVE_INFINITY
  const bSeq =
    typeof b.sequence === "number" ? b.sequence : Number.NEGATIVE_INFINITY
  if (aSeq !== bSeq) return aSeq - bSeq
  const created = a.createdAt.localeCompare(b.createdAt)
  if (created !== 0) return created
  return a.id.localeCompare(b.id)
}

function isPlanBoundaryToolActivity(activity: ThreadActivity): boolean {
  const payload = asRecord(activity.payload)
  const toolName =
    stringFrom(payload.toolName) ??
    stringFrom(payload.tool_name) ??
    stringFrom(payload.tool) ??
    stringFrom(payload.name)
  if ((toolName ?? "").toLowerCase() === "exitplanmode") return true
  const detail =
    stringFrom(payload.detail) ??
    stringFrom(payload.output_delta) ??
    stringFrom(payload.delta)
  return Boolean(detail?.startsWith("ExitPlanMode:"))
}

function fallbackToolLifecycleKey(
  activity: ThreadActivity,
  payload: Record<string, unknown>
): string | undefined {
  if (
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed" &&
    activity.kind !== "tool.failed"
  ) {
    return undefined
  }
  const parts = [
    stringFrom(payload.itemType) ?? stringFrom(payload.item_type),
    stringFrom(payload.title),
    stringFrom(payload.toolName) ??
      stringFrom(payload.tool_name) ??
      stringFrom(payload.tool),
    stringFrom(payload.detail),
    stringFrom(payload.summary) ?? activity.summary,
  ]
    .map((part) => normalizeLifecycleKeyPart(part))
    .filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join("\u0000") : undefined
}

function toolInputFromActivityPayload(
  payload: Record<string, unknown>
): unknown | undefined {
  if (payload.input !== undefined) return payload.input
  const item = objectFrom(payload.item)
  if (item?.input !== undefined) return item.input
  const data = objectFrom(payload.data) ?? objectFrom(item?.data)
  if (data?.input !== undefined) return data.input
  return undefined
}

function normalizeLifecycleKeyPart(
  value: string | undefined
): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ")
  return normalized && normalized.length > 0 ? normalized : undefined
}

function normalizeProviderKind(value: string | undefined): string | undefined {
  const key = (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
  if (!key) return undefined
  if (key === "codex" || key === "codexcli") return "codex"
  if (key === "claude" || key === "claudeagent" || key === "claudecli") {
    return "claude"
  }
  if (key === "anthropiccli") return "anthropic_cli"
  return value
}

function stringPreview(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function summarizeOutput(output: unknown) {
  // Show the result's text (file lines, stdout, matches), not the envelope
  // the provider wrapped it in. Only a result without any text falls back
  // to its JSON.
  const text = extractToolOutputText(output) ?? stringPreview(output)
  const truncated = text.length > 16_000
  const outputPreview = truncated ? text.slice(0, 16_000) : text
  return {
    outputPreview,
    outputTruncated: truncated,
    outputBytes: text.length,
    outputLineCount: text ? text.split(/\r?\n/).length : 0,
  }
}

function toolDurationMs(startedAt: string | undefined, completedAt: string) {
  if (!startedAt) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, end - start)
}

function objectFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
