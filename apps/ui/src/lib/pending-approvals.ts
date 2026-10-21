import { asRecord } from "@betterc0de/schema"
import type { ThreadActivity } from "@/lib/chat-store"
import type { PermissionUpdate } from "@betterc0de/schema"
import {
  isStalePendingApprovalFailureActivity,
  requestIdFromActivity,
} from "@/lib/pending-provider-requests"
import { stripProposedPlanWrapper } from "@/lib/plan-content"

/**
 * Pure derivation of pending tool-approval / plan-approval requests from a
 * thread's activity log. Extracted from chat-transcript.tsx so the attention
 * system (badges/toasts) and the transcript UI share one pairing rule.
 */

export type PendingApproval = {
  requestId: string
  providerKind: string
  providerInstanceId?: string
  pluginId?: string
  toolName?: string
  requestKind?: string
  input: unknown
  createdAt: string
  turnId?: string
  // Rich context from the Claude Agent SDK canUseTool options:
  title?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  suggestions?: PermissionUpdate[]
}

export type PendingPlanApproval = {
  requestId: string
  providerKind: string
  providerInstanceId?: string
  planMarkdown: string
  createdAt: string
  turnId?: string
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
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

function providerKindFromPayload(
  payload: Record<string, unknown>
): string | undefined {
  return normalizeProviderKind(
    stringFrom(payload.providerKind) ??
      stringFrom(payload.provider_kind) ??
      stringFrom(payload.provider)
  )
}

function providerInstanceIdFrom(
  activity: ThreadActivity,
  payload: Record<string, unknown>
): string | undefined {
  return (
    stringFrom(payload.providerInstanceId) ??
    stringFrom(payload.provider_instance_id) ??
    stringFrom(activity.providerInstanceId)
  )
}

function compareActivities(a: ThreadActivity, b: ThreadActivity) {
  const aSeq =
    typeof a.sequence === "number" ? a.sequence : Number.NEGATIVE_INFINITY
  const bSeq =
    typeof b.sequence === "number" ? b.sequence : Number.NEGATIVE_INFINITY
  if (aSeq !== bSeq) return aSeq - bSeq
  const created = a.createdAt.localeCompare(b.createdAt)
  if (created !== 0) return created
  return a.id.localeCompare(b.id)
}

function suggestionsFrom(
  payload: Record<string, unknown>
): PermissionUpdate[] | undefined {
  const raw = payload.suggestions
  return Array.isArray(raw) && raw.length > 0
    ? (raw as PermissionUpdate[])
    : undefined
}

export function derivePendingApprovals(
  activities: ThreadActivity[]
): PendingApproval[] {
  const open = new Map<string, PendingApproval>()
  const sorted = [...activities].sort(compareActivities)

  // See `derivePendingProviderUserInputs`: activity sequences come from two
  // emitters and a resolution can carry a LOWER sequence than the request it
  // settles. Collecting settled ids first makes the result independent of
  // that ordering, so an answered approval cannot pop back up.
  const settled = new Set<string>()
  for (const activity of sorted) {
    const requestId = requestIdFromActivity(activity)
    if (!requestId) continue
    if (
      activity.kind === "approval.resolved" ||
      isStalePendingApprovalFailureActivity(activity)
    ) {
      settled.add(requestId)
    }
  }

  for (const activity of sorted) {
    const payload = asRecord(activity.payload)
    const requestId = requestIdFromActivity(activity)
    if (!requestId || settled.has(requestId)) continue

    if (activity.kind === "approval.requested") {
      open.set(requestId, {
        requestId,
        providerKind: providerKindFromPayload(payload) ?? "claude",
        providerInstanceId: providerInstanceIdFrom(activity, payload),
        pluginId: stringFrom(payload.pluginId),
        toolName:
          stringFrom(payload.toolName) ??
          stringFrom(payload.tool_name) ??
          stringFrom(payload.tool),
        requestKind: stringFrom(payload.requestKind),
        input: payload.input,
        createdAt: activity.createdAt,
        turnId: stringFrom(payload.turn_id) ?? activity.turnId ?? undefined,
        title: stringFrom(payload.title),
        description: stringFrom(payload.description),
        decisionReason:
          stringFrom(payload.decisionReason) ??
          stringFrom(payload.decision_reason),
        blockedPath:
          stringFrom(payload.blockedPath) ?? stringFrom(payload.blocked_path),
        suggestions: suggestionsFrom(payload),
      })
      continue
    }
  }
  return [...open.values()]
}

export function derivePendingPlanApprovals(
  activities: ThreadActivity[]
): PendingPlanApproval[] {
  const open = new Map<string, PendingPlanApproval>()
  const sorted = [...activities].sort(compareActivities)
  // Requests and resolutions can originate from different sequence domains.
  // A resolution must win even when replay sorts it before its request.
  const settled = new Set<string>()
  for (const activity of activities) {
    if (
      activity.kind === "plan-approval.resolved" ||
      isStalePendingApprovalFailureActivity(activity)
    ) {
      const requestId = requestIdFromActivity(activity)
      if (requestId) settled.add(requestId)
    }
  }
  // Providers sometimes open the plan-approval request WITHOUT the plan
  // payload (e.g. Claude CLI's ExitPlanMode input arriving empty after a
  // session resume). The plan itself was streamed as a
  // `turn.proposed.completed` activity — index those by turn so we can
  // recover the plan text for the request's OWN turn, not just the newest
  // one. Using the newest globally is wrong once the agent proposes again
  // in a later turn (it overwrites an older, still-open request's plan with
  // an unrelated follow-up message).
  const proposedPlanByTurn = new Map<string, string>()
  let lastProposedPlanMarkdown = ""
  for (const activity of sorted) {
    const payload = asRecord(activity.payload)

    if (activity.kind === "turn.proposed.completed") {
      const planMarkdown =
        stringFrom(payload.planMarkdown) ??
        stringFrom(payload.plan_markdown) ??
        stringFrom(payload.detail)
      if (planMarkdown?.trim()) {
        lastProposedPlanMarkdown = planMarkdown
        const turnId = stringFrom(payload.turn_id) ?? activity.turnId
        if (turnId) proposedPlanByTurn.set(turnId, planMarkdown)
      }
      continue
    }

    const requestId = requestIdFromActivity(activity)
    if (!requestId) continue

    if (activity.kind === "plan-approval.requested") {
      if (settled.has(requestId)) continue
      const turnId = stringFrom(payload.turn_id) ?? activity.turnId ?? undefined
      open.set(requestId, {
        requestId,
        providerKind: providerKindFromPayload(payload) ?? "claude",
        providerInstanceId: providerInstanceIdFrom(activity, payload),
        planMarkdown:
          stringFrom(payload.planMarkdown) ??
          stringFrom(payload.plan_markdown) ??
          stringFrom(payload.plan) ??
          stringFrom(payload.detail) ??
          stringFrom(payload.content) ??
          (turnId ? proposedPlanByTurn.get(turnId) : undefined) ??
          "",
        createdAt: activity.createdAt,
        turnId,
      })
      continue
    }

    if (activity.kind === "plan-approval.resolved") {
      open.delete(requestId)
      continue
    }

    if (isStalePendingApprovalFailureActivity(activity)) {
      open.delete(requestId)
    }
  }
  // Order-independent backfill for still-empty entries: prefer the plan
  // proposed in the request's OWN turn (a `turn.proposed.completed` can be
  // sorted after the request on session resume), then fall back to the most
  // recent proposed plan only when the request carries no turn to match.
  for (const [requestId, entry] of open) {
    if (entry.planMarkdown.trim()) continue
    const byTurn = entry.turnId
      ? proposedPlanByTurn.get(entry.turnId)
      : undefined
    const recovered = byTurn ?? (entry.turnId ? "" : lastProposedPlanMarkdown)
    if (recovered.trim()) {
      open.set(requestId, { ...entry, planMarkdown: recovered })
    }
  }
  // Strip the model preamble + `<proposed_plan>` wrapper so every consumer
  // (modal, inline card, attention title) renders just the plan body.
  for (const [requestId, entry] of open) {
    const stripped = stripProposedPlanWrapper(entry.planMarkdown)
    if (stripped !== entry.planMarkdown) {
      open.set(requestId, { ...entry, planMarkdown: stripped })
    }
  }
  return [...open.values()]
}
