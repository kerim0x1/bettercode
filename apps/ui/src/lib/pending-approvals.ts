import type { ThreadActivity } from "@/lib/chat-store"
import type { PermissionUpdate } from "@betterc0de/schema"
import { stripProposedPlanWrapper } from "@/lib/plan-content"
import { nonEmptyString, type JsonRecord } from "@betterc0de/schema/json-read"
import { derivePendingRequests } from "@betterc0de/schema/pending-requests"

/**
 * Pending tool-approval / plan-approval requests of a thread, for the
 * transcript, the approval modal and the attention system (badges/toasts).
 * Which requests are open is derived by `derivePendingRequests`, shared with
 * the phone; this module only maps them to what the desktop shows.
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

function suggestionsFrom(payload: JsonRecord): PermissionUpdate[] | undefined {
  const raw = payload.suggestions
  return Array.isArray(raw) && raw.length > 0
    ? (raw as PermissionUpdate[])
    : undefined
}

export function derivePendingApprovals(
  activities: ThreadActivity[]
): PendingApproval[] {
  return derivePendingRequests(activities, { kinds: ["approval"] }).map(
    (request) => {
      const { payload } = request
      return {
        requestId: request.requestId,
        providerKind: request.providerKind ?? "claude",
        providerInstanceId: request.providerInstanceId,
        pluginId: nonEmptyString(payload.pluginId),
        toolName:
          nonEmptyString(payload.toolName) ??
          nonEmptyString(payload.tool_name) ??
          nonEmptyString(payload.tool),
        requestKind: nonEmptyString(payload.requestKind),
        input: payload.input,
        createdAt: request.createdAt,
        turnId: request.turnId,
        title: nonEmptyString(payload.title),
        description: nonEmptyString(payload.description),
        decisionReason:
          nonEmptyString(payload.decisionReason) ??
          nonEmptyString(payload.decision_reason),
        blockedPath:
          nonEmptyString(payload.blockedPath) ??
          nonEmptyString(payload.blocked_path),
        suggestions: suggestionsFrom(payload),
      }
    }
  )
}

export function derivePendingPlanApprovals(
  activities: ThreadActivity[]
): PendingPlanApproval[] {
  return derivePendingRequests(activities, { kinds: ["plan-approval"] }).map(
    (request) => ({
      requestId: request.requestId,
      providerKind: request.providerKind ?? "claude",
      providerInstanceId: request.providerInstanceId,
      // Strip the model preamble + `<proposed_plan>` wrapper so every
      // consumer (modal, inline card, attention title) renders just the
      // plan body.
      planMarkdown: stripProposedPlanWrapper(request.planMarkdown ?? ""),
      createdAt: request.createdAt,
      turnId: request.turnId,
    })
  )
}
