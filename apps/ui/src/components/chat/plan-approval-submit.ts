import type { PendingPlanApproval } from "@/lib/pending-approvals"
import { usePreferencesStore } from "@/lib/preferences-store"
import { respondToPlanApproval } from "@/services/backend/chatApi"
import { recordRequestResponseFailure } from "@/components/chat/approval-request-context"

export interface PlanApprovalDecisionOptions {
  /** approve+acceptEdits = auto-accept edits; approve+default = manual approvals. */
  readonly permissionMode?: "acceptEdits" | "default"
  /** Keep-planning feedback for the model. */
  readonly message?: string
}

export interface PlanApprovalSubmitDeps {
  readonly respond: (
    threadId: string,
    providerKind: string,
    requestId: string,
    decision: "approve" | "deny",
    providerInstanceId: string | null,
    options?: PlanApprovalDecisionOptions
  ) => Promise<unknown>
  readonly recordFailure: (input: {
    readonly threadId: string
    readonly requestId: string
    readonly providerKind: string
    readonly providerInstanceId?: string | null
    readonly requestKind: "plan-approval"
    readonly error: unknown
  }) => void
  readonly setPermissionLevel: (level: "allow-edits") => void
}

const DEFAULT_DEPS: PlanApprovalSubmitDeps = {
  respond: respondToPlanApproval,
  recordFailure: recordRequestResponseFailure,
  setPermissionLevel: (level) =>
    usePreferencesStore.getState().set("permissionLevel", level),
}

/**
 * Shared submit path for plan-approval decisions (inline card + modal).
 * Never throws: the backend answers a refused plan response with a non-2xx
 * (400 when the provider cannot take it, 502 when the provider refused),
 * and that is recorded like a tool approval — a failed activity that clears
 * the card, plus a toast saying why — instead of leaking an unhandled
 * rejection out of a click handler. Returns whether the decision landed.
 */
export async function submitPlanApprovalDecision(
  threadId: string,
  planApproval: Pick<
    PendingPlanApproval,
    "providerKind" | "requestId" | "providerInstanceId"
  >,
  decision: "approve" | "deny",
  options?: PlanApprovalDecisionOptions,
  deps: PlanApprovalSubmitDeps = DEFAULT_DEPS
): Promise<boolean> {
  try {
    await deps.respond(
      threadId,
      planApproval.providerKind,
      planApproval.requestId,
      decision,
      planApproval.providerInstanceId ?? null,
      options
    )
  } catch (error) {
    deps.recordFailure({
      threadId,
      requestId: planApproval.requestId,
      providerKind: planApproval.providerKind,
      providerInstanceId: planApproval.providerInstanceId,
      requestKind: "plan-approval",
      error,
    })
    return false
  }
  if (decision === "approve" && options?.permissionMode === "acceptEdits") {
    // Keep the composer's permission chip in sync with the live session.
    deps.setPermissionLevel("allow-edits")
  }
  return true
}
