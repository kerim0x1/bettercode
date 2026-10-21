import { asRecord } from "@betterc0de/schema"
import type { ThreadActivity } from "@/lib/chat-store"
import {
  derivePendingApprovals,
  derivePendingPlanApprovals,
} from "@/lib/pending-approvals"
import { derivePendingProviderUserInputs } from "@/lib/pending-user-input-requests"
import { requestIdFromActivity } from "@/lib/pending-provider-requests"

/**
 * Aggregated "needs the user" state for one thread, derived purely from its
 * activity log. Consumed by the attention store (badges/toasts) and shared
 * with the approval modal focus logic.
 */
export interface ThreadAttention {
  threadId: string
  /** Open tool-approval requests. */
  approvals: number
  /** Open AskUserQuestion requests. */
  questions: number
  /** Open plan approvals (interactive requests + latest unimplemented capture), capped at 1. */
  planApprovals: number
  total: number
  /**
   * Stable keys ("approval:<id>" | "input:<id>" | "plan:<id>") for toast
   * dedupe and appeared/disappeared diffing in the watcher.
   */
  openRequestKeys: string[]
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Mirrors chat-transcript's sourceProposedPlanKey pairing for legacy plan captures. */
function derivePendingLegacyPlanKey(
  activities: ThreadActivity[]
): string | null {
  const implemented = new Set<string>()
  const approvedRequests = new Set<string>()
  const approvedTurns = new Set<string>()
  for (const activity of activities) {
    if (activity.kind !== "plan-approval.resolved") continue
    const payload = asRecord(activity.payload)
    if (payload.decision !== "approve") continue
    const requestId = requestIdFromActivity(activity)
    if (requestId) approvedRequests.add(requestId)
    const turnId = stringFrom(payload.turn_id) ?? activity.turnId
    if (turnId) approvedTurns.add(`${activity.threadId}::${turnId}`)
  }
  for (const activity of activities) {
    if (activity.kind !== "plan-approval.requested") continue
    const requestId = requestIdFromActivity(activity)
    const turnId =
      stringFrom(asRecord(activity.payload).turn_id) ?? activity.turnId
    if (requestId && approvedRequests.has(requestId) && turnId) {
      approvedTurns.add(`${activity.threadId}::${turnId}`)
    }
  }
  for (const activity of activities) {
    if (activity.kind !== "turn.proposed.implemented") continue
    const payload = asRecord(activity.payload)
    const source = asRecord(
      payload.sourceProposedPlan ?? payload.source_proposed_plan
    )
    const threadId =
      stringFrom(source.threadId) ??
      stringFrom(source.thread_id) ??
      activity.threadId
    const planId = stringFrom(source.planId) ?? stringFrom(source.plan_id)
    if (planId) implemented.add(`${threadId}::${planId}`)
  }
  let latest: { key: string; createdAt: string } | null = null
  for (const activity of activities) {
    if (activity.kind !== "turn.proposed.completed") continue
    const payload = asRecord(activity.payload)
    const turnId = stringFrom(payload.turn_id) ?? activity.turnId
    if (turnId && approvedTurns.has(`${activity.threadId}::${turnId}`)) continue
    const content =
      stringFrom(payload.planMarkdown) ??
      stringFrom(payload.plan_markdown) ??
      stringFrom(payload.detail) ??
      ""
    if (!content.trim()) continue
    const planId =
      stringFrom(payload.planId) ?? stringFrom(payload.plan_id) ?? activity.id
    const key = `${activity.threadId}::${planId}`
    if (implemented.has(key)) continue
    if (!latest || activity.createdAt.localeCompare(latest.createdAt) >= 0) {
      latest = { key, createdAt: activity.createdAt }
    }
  }
  return latest ? latest.key : null
}

export function deriveThreadAttention(
  threadId: string,
  activities: ThreadActivity[]
): ThreadAttention {
  const approvals = derivePendingApprovals(activities)
  const questions = derivePendingProviderUserInputs(activities)
  const planApprovalRequests = derivePendingPlanApprovals(activities)

  const keys: string[] = []
  for (const approval of approvals) keys.push(`approval:${approval.requestId}`)
  for (const question of questions) keys.push(`input:${question.requestId}`)

  // Interactive plan-approval requests win over the legacy capture pairing;
  // either way plan attention is advisory and capped at 1.
  let planApprovals = 0
  if (planApprovalRequests.length > 0) {
    planApprovals = 1
    keys.push(
      `plan:${planApprovalRequests[planApprovalRequests.length - 1]!.requestId}`
    )
  } else {
    const legacyKey = derivePendingLegacyPlanKey(activities)
    if (legacyKey) {
      planApprovals = 1
      keys.push(`plan:${legacyKey}`)
    }
  }

  return {
    threadId,
    approvals: approvals.length,
    questions: questions.length,
    planApprovals,
    total: approvals.length + questions.length + planApprovals,
    openRequestKeys: keys,
  }
}
