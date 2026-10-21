import { useChatStore } from "@/lib/chat-store"
import {
  derivePendingPlanApprovals,
  type PendingPlanApproval,
} from "@/lib/pending-approvals"
import { respondToPlanApproval } from "@/services/backend"

/**
 * Single source of truth for "implement this plan".
 *
 * Plan mode runs in interactive approval mode: when the agent proposes a plan
 * it opens a `plan_approval` request and parks the turn awaiting the user. The
 * correct way to implement is to RESOLVE that pending approval — the same turn
 * then continues into implementation. Dispatching a fresh "Implement the
 * proposed plan." chat turn instead collides with the still-active parked turn
 * (409 `turn_active`) and produced the duplicate messages + "chat send failed"
 * the user hit.
 *
 * So every Implement affordance funnels through here: if an approval is
 * pending → resolve it; only when none is pending (capture-style, a stale plan
 * from a prior session, or a brand-new thread) does the caller fall back to a
 * fresh implement message.
 */

/** Prefer the approval for the plan's own turn, else the newest pending one. */
export function selectPlanApprovalForImplement(
  pending: readonly PendingPlanApproval[],
  turnId?: string | null
): PendingPlanApproval | null {
  if (pending.length === 0) return null
  const byTurn = turnId ? pending.find((p) => p.turnId === turnId) : undefined
  return byTurn ?? pending[pending.length - 1] ?? null
}

// Threads with an implement resolution in flight. Guards against double-clicks
// / re-fires while the approve round-trip is pending — a second attempt would
// otherwise hit a StalePendingProviderRequestError (the resolver is already
// consumed) and surface as an error bubble.
const implementInFlight = new Set<string>()

export type ImplementOutcome =
  | "resolved"
  | "no-approval"
  | "in-flight"
  | "error"

/**
 * Resolve a pending plan approval for `threadId` (approve + acceptEdits by
 * default). Returns:
 *  - "resolved": an approval existed and was approved (same-turn implement).
 *  - "no-approval": nothing pending — caller should send an implement message.
 *  - "in-flight": an implement is already running for this thread (ignored).
 *  - "error": the approve round-trip failed (an error bubble was appended).
 */
export async function implementPendingPlanApproval(
  threadId: string,
  opts: {
    turnId?: string | null
    permissionMode?: "acceptEdits" | "default"
  } = {}
): Promise<ImplementOutcome> {
  if (implementInFlight.has(threadId)) return "in-flight"
  const store = useChatStore.getState()
  const pending = derivePendingPlanApprovals(
    store.activitiesByThread[threadId] ?? []
  )
  const approval = selectPlanApprovalForImplement(pending, opts.turnId)
  if (!approval) return "no-approval"

  implementInFlight.add(threadId)
  try {
    await respondToPlanApproval(
      threadId,
      approval.providerKind,
      approval.requestId,
      "approve",
      approval.providerInstanceId ?? null,
      { permissionMode: opts.permissionMode ?? "acceptEdits" }
    )
    return "resolved"
  } catch (err) {
    useChatStore.getState().addMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      createdAt: new Date().toISOString(),
    })
    return "error"
  } finally {
    implementInFlight.delete(threadId)
  }
}
