import type { ThreadActivity } from "@betterc0de/schema"
import { isStalePendingRequestFailureActivity } from "@betterc0de/schema/pending-requests"

// Which requests are open, and what settles one, is shared with the phone
// (`@betterc0de/schema/pending-requests`); these re-exports keep the
// renderer's existing import sites.
export {
  isStalePendingRequestFailureDetail,
  requestIdFromActivity,
} from "@betterc0de/schema/pending-requests"

/**
 * Human-readable detail for a request response that the backend refused
 * (non-2xx) or that never reached it. Kept short: it lands on the failed
 * activity card and in a toast.
 */
export function describeRequestResponseFailure(
  error: unknown,
  fallback: string
): string {
  const message =
    error instanceof Error
      ? error.message.trim()
      : typeof error === "string"
        ? error.trim()
        : ""
  return message.length > 0 ? message : fallback
}

/**
 * Twin of the backend's `activityId` (`provider/activity-projection/shared.ts`):
 * the same parts joined the same way, so a locally recorded failure and
 * the backend's own row for the same request share one id and upsert
 * rather than stack. Kept in sync by the parity test next to this file.
 */
function backendActivityId(
  parts: ReadonlyArray<string | number | undefined | null>
): string {
  return parts
    .filter(
      (part): part is string | number =>
        part !== undefined && part !== null && `${part}`.length > 0
    )
    .map((part) => `${part}`.replace(/\s+/g, "_"))
    .join("::")
}

/**
 * Local twin of the backend's `provider.approval.respond.failed` activity.
 * The backend records and broadcasts one when the provider refuses the
 * response; this covers the request never getting there (network, 5xx
 * before the activity write) so `derivePendingApprovals` clears the card
 * either way instead of leaving a request that can no longer be answered.
 */
export function failedRequestResponseActivity(input: {
  readonly threadId: string
  readonly requestId: string
  readonly providerKind: string
  readonly providerInstanceId?: string | null
  readonly requestKind: "approval" | "plan-approval"
  readonly detail: string
  readonly now?: number
}): ThreadActivity {
  const now = input.now ?? Date.now()
  return {
    id: backendActivityId([
      input.threadId,
      "provider.approval.respond.failed",
      input.requestId,
    ]),
    threadId: input.threadId,
    kind: "provider.approval.respond.failed",
    tone: "error",
    summary:
      input.requestKind === "plan-approval"
        ? "Provider plan-approval response failed"
        : "Provider approval response failed",
    payload: {
      requestId: input.requestId,
      providerKind: input.providerKind,
      providerInstanceId: input.providerInstanceId ?? undefined,
      detail: input.detail,
    },
    sequence: now * 1000,
    createdAt: new Date(now).toISOString(),
  }
}

export function isStalePendingApprovalFailureActivity(
  activity: Pick<ThreadActivity, "kind" | "payload" | "summary">
): boolean {
  return (
    activity.kind === "provider.approval.respond.failed" &&
    isStalePendingRequestFailureActivity(activity)
  )
}

export function isStalePendingUserInputFailureActivity(
  activity: Pick<ThreadActivity, "kind" | "payload" | "summary">
): boolean {
  return (
    activity.kind === "provider.user-input.respond.failed" &&
    isStalePendingRequestFailureActivity(activity)
  )
}
