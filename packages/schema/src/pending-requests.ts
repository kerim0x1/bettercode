/**
 * Which provider requests a thread still waits on — tool approvals, plan
 * approvals and questions (`user_input`) — read from its activities. The
 * desktop (approval cards, question panel, attention badges) and the phone
 * (request cards, "waiting" badges) used to derive this each on their own,
 * with different ordering and settling rules, so the two could disagree
 * about which requests are open. Both derive it here now; each client keeps
 * only the mapping from a request to what it shows.
 *
 * The rules, and why where the clients used to differ:
 *
 * - Order: `compareActivities` (sequence, unsequenced activities first, then
 *   creation time, then id). The phone placed unsequenced activities at
 *   sequence 0 and the desktop's question panel ignored ids on ties.
 *   Requests come back in the order their first opening activity sorts.
 * - Settled ids are collected before anything opens, so a resolution that
 *   sorts before its request (route-written and projected activities carry
 *   sequences from two emitters) still settles it.
 * - A request id names one provider callback. Any resolution or stale
 *   refusal naming it settles it, whatever kind of request it was (the
 *   phone's rule). The desktop only accepted a resolution of the same kind,
 *   but the projection reports some resolutions under another kind: a
 *   question the provider cancelled arrives as `approval.resolved`, and the
 *   desktop kept showing it.
 * - A response failure settles a request only when its detail says the
 *   provider no longer knows it (the desktop's exact phrase list, which is
 *   what the backend writes); the phone accepted any detail containing
 *   "stale pending" or "unknown pending". A transient failure leaves the
 *   request open so the user can answer again.
 * - A question request without questions is open: the provider waits on
 *   it. The desktop used to drop it, leaving a turn waiting with nothing to
 *   answer; the phone asked for a free-text answer.
 * - The request id is read from the payload or its nested `data`/`item`
 *   (the desktop's rule); the phone only read the top level.
 * - The provider kind is folded with `providerKindFromDriver` from
 *   `providerKind`, `provider_kind` or `provider`. A request without one has
 *   none here: the desktop falls back to Claude, the phone sends nothing.
 */

import type { ThreadActivity } from "./domain"
import { asRecord, nonEmptyString, type JsonRecord } from "./json-read"
import {
  compareActivities,
  providerInstanceIdFromActivityPayload,
  providerKindFromActivityPayload,
} from "./activity-tools"

export type PendingRequestKind = "approval" | "plan-approval" | "user-input"

export interface PendingProviderRequest {
  readonly requestId: string
  readonly kind: PendingRequestKind
  /** The activity that opened it; the latest one when it was reported again. */
  readonly activity: ThreadActivity
  /** `activity.payload` as a record. */
  readonly payload: JsonRecord
  /** Folded provider kind, or undefined when the request names none. */
  readonly providerKind?: string
  readonly providerInstanceId?: string
  readonly turnId?: string
  readonly createdAt: string
  /**
   * Plan approvals only: the plan, from the request or else from the plan
   * proposed in the request's own turn. Untouched: a client shows
   * `stripProposedPlanWrapper(planMarkdown)`. "" when none was found.
   */
  readonly planMarkdown?: string
}

const PROPOSED_PLAN_OPEN = /<proposed_plan>/i
const PROPOSED_PLAN_CLOSE = /<\/proposed_plan>/i

/**
 * The plan body to show: any model preamble and the `<proposed_plan>`
 * wrapper dropped, tolerant of an unclosed opening tag (a model may stream
 * "…here's the plan.\n<proposed_plan>\n## …" and never close it). Text
 * without the wrapper comes back trimmed, so it is safe on any plan. The
 * desktop's plan card and the phone's request card both show this.
 */
export function stripProposedPlanWrapper(text: string): string {
  const open = PROPOSED_PLAN_OPEN.exec(text)
  if (!open) return text.trim()
  const afterOpen = text.slice(open.index + open[0].length)
  const close = PROPOSED_PLAN_CLOSE.exec(afterOpen)
  return (close ? afterOpen.slice(0, close.index) : afterOpen).trim()
}

export interface DerivePendingRequestsOptions {
  /** Only requests of these kinds; every kind by default. */
  readonly kinds?: readonly PendingRequestKind[]
}

/**
 * Response-failure details that mean the provider no longer knows the
 * request (`stalePendingRequestDetail` in the backend, and the wording of
 * older backends), so answering it again cannot succeed.
 */
const STALE_PENDING_REQUEST_DETAILS = [
  "stale pending approval request",
  "stale pending user-input request",
  "stale pending plan-approval request",
  "unknown pending approval request",
  "unknown pending permission request",
  "unknown pending user-input request",
  "unknown pending plan-approval request",
] as const

const RESOLVED_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "approval.resolved",
  "plan-approval.resolved",
  "user-input.resolved",
])

const RESPONSE_FAILED_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "provider.approval.respond.failed",
  "provider.user-input.respond.failed",
])

/** The kind of request this activity opens, if it opens one. */
export function pendingRequestKindOpenedBy(
  activity: Pick<ThreadActivity, "kind">
): PendingRequestKind | undefined {
  switch (activity.kind) {
    case "approval.requested":
      return "approval"
    case "plan-approval.requested":
      return "plan-approval"
    case "user-input.requested":
      return "user-input"
    default:
      return undefined
  }
}

export function requestIdFromActivity(
  activity: Pick<ThreadActivity, "payload">
): string | undefined {
  const payload = asRecord(activity.payload)
  const direct =
    nonEmptyString(payload.requestId) ?? nonEmptyString(payload.request_id)
  if (direct) return direct

  const data = asRecord(payload.data)
  const item = asRecord(payload.item)
  return (
    nonEmptyString(data.requestId) ??
    nonEmptyString(data.request_id) ??
    nonEmptyString(item.requestId) ??
    nonEmptyString(item.request_id)
  )
}

export function isStalePendingRequestFailureDetail(detail: unknown): boolean {
  const normalized = nonEmptyString(detail)?.toLowerCase()
  if (!normalized) return false
  return STALE_PENDING_REQUEST_DETAILS.some((needle) =>
    normalized.includes(needle)
  )
}

function failureDetailFromActivity(
  activity: Pick<ThreadActivity, "payload" | "summary">
): string | undefined {
  const payload = asRecord(activity.payload)
  const data = asRecord(payload.data)
  return (
    nonEmptyString(payload.detail) ??
    nonEmptyString(payload.error) ??
    nonEmptyString(payload.message) ??
    nonEmptyString(data.detail) ??
    nonEmptyString(data.error) ??
    nonEmptyString(data.message) ??
    nonEmptyString(activity.summary)
  )
}

/**
 * A response the provider refused because it no longer knows the request
 * (after an app restart or a recovered session).
 */
export function isStalePendingRequestFailureActivity(
  activity: Pick<ThreadActivity, "kind" | "payload" | "summary">
): boolean {
  return (
    RESPONSE_FAILED_ACTIVITY_KINDS.has(activity.kind) &&
    isStalePendingRequestFailureDetail(failureDetailFromActivity(activity))
  )
}

/** Whether this activity settles the request it names: answered, or refused as stale. */
export function settlesPendingRequest(
  activity: Pick<ThreadActivity, "kind" | "payload" | "summary">
): boolean {
  return (
    RESOLVED_ACTIVITY_KINDS.has(activity.kind) ||
    isStalePendingRequestFailureActivity(activity)
  )
}

/** Whether this activity can change which requests are open. */
export function affectsPendingRequests(
  activity: Pick<ThreadActivity, "kind" | "payload" | "summary">
): boolean {
  return (
    pendingRequestKindOpenedBy(activity) !== undefined ||
    settlesPendingRequest(activity)
  )
}

/** The ids of the requests these activities settle, in any order. */
export function settledRequestIds(
  activities: readonly ThreadActivity[]
): Set<string> {
  const settled = new Set<string>()
  for (const activity of activities) {
    if (!settlesPendingRequest(activity)) continue
    const requestId = requestIdFromActivity(activity)
    if (requestId) settled.add(requestId)
  }
  return settled
}

function planMarkdownFromRequest(payload: JsonRecord): string | undefined {
  return (
    nonEmptyString(payload.planMarkdown) ??
    nonEmptyString(payload.plan_markdown) ??
    nonEmptyString(payload.plan) ??
    nonEmptyString(payload.detail) ??
    nonEmptyString(payload.content)
  )
}

function planMarkdownFromProposal(payload: JsonRecord): string | undefined {
  return (
    nonEmptyString(payload.planMarkdown) ??
    nonEmptyString(payload.plan_markdown) ??
    nonEmptyString(payload.detail)
  )
}

/**
 * The requests these activities leave open, in the order they were opened.
 * See the module comment for the rules.
 */
export function derivePendingRequests(
  activities: readonly ThreadActivity[],
  options: DerivePendingRequestsOptions = {}
): PendingProviderRequest[] {
  const kinds = options.kinds ? new Set(options.kinds) : undefined
  const wantsPlans = !kinds || kinds.has("plan-approval")
  const sorted = [...activities].sort(compareActivities)
  const settled = settledRequestIds(sorted)
  const open = new Map<string, PendingProviderRequest>()

  // Providers sometimes open a plan approval WITHOUT the plan (Claude CLI's
  // ExitPlanMode input arrives empty after a session resume); the plan was
  // streamed as `turn.proposed.completed`. They are indexed by turn so a
  // request recovers the plan of its OWN turn: the newest plan overall
  // belongs to a later turn once the agent proposes again.
  const proposedPlanByTurn = new Map<string, string>()
  let lastProposedPlanMarkdown = ""

  for (const activity of sorted) {
    const payload = asRecord(activity.payload)
    if (activity.kind === "turn.proposed.completed") {
      if (!wantsPlans) continue
      const planMarkdown = planMarkdownFromProposal(payload)
      if (planMarkdown?.trim()) {
        lastProposedPlanMarkdown = planMarkdown
        const turnId =
          nonEmptyString(payload.turn_id) ?? nonEmptyString(activity.turnId)
        if (turnId) proposedPlanByTurn.set(turnId, planMarkdown)
      }
      continue
    }

    const kind = pendingRequestKindOpenedBy(activity)
    if (!kind || (kinds && !kinds.has(kind))) continue
    const requestId = requestIdFromActivity(activity)
    if (!requestId || settled.has(requestId)) continue
    const turnId =
      nonEmptyString(payload.turn_id) ?? nonEmptyString(activity.turnId)
    open.set(requestId, {
      requestId,
      kind,
      activity,
      payload,
      providerKind: providerKindFromActivityPayload(payload),
      providerInstanceId: providerInstanceIdFromActivityPayload(
        activity,
        payload
      ),
      turnId,
      createdAt: activity.createdAt,
      ...(kind === "plan-approval"
        ? {
            planMarkdown:
              planMarkdownFromRequest(payload) ??
              (turnId ? proposedPlanByTurn.get(turnId) : undefined) ??
              "",
          }
        : {}),
    })
  }

  // A plan proposed after its request sorted (session resume) still fills
  // it: the plan of the request's own turn, or the newest plan when the
  // request names no turn.
  for (const [requestId, request] of open) {
    if (request.kind !== "plan-approval") continue
    if (request.planMarkdown?.trim()) continue
    const recovered = request.turnId
      ? (proposedPlanByTurn.get(request.turnId) ?? "")
      : lastProposedPlanMarkdown
    if (recovered.trim()) {
      open.set(requestId, { ...request, planMarkdown: recovered })
    }
  }
  return [...open.values()]
}
