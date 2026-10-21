import { asRecord, readString } from "@betterc0de/schema"
import type { ThreadActivityProjection } from "../../persistence/projections"
import type { LegacyProviderEvent } from "../types"
import type { ProjectionContext } from "./context"
import { projectToolEvents } from "./tool-events"
import { projectRequestEvents } from "./request-events"
import { projectSessionEvents } from "./session-events"
import { projectTurnEvents } from "./turn-events"
import { boundThreadActivity } from "./output-bounds"
import {
  flattenProviderPayload,
  normalizeProviderKind,
  providerInstanceIdFromPayload,
} from "./shared"

export { isCumulativeToolOutputPayload, toolUpdateActivityKey } from "./shared"
export {
  makeFailedRequestActivity,
  makeResolvedRequestActivity,
} from "./request-activities"
export type { ProjectionContext } from "./context"
export {
  boundThreadActivity,
  boundToolActivity,
  TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES,
} from "./output-bounds"
export { boundProviderRuntimeEventForBroadcast } from "./runtime-event-bounds"

/**
 * Event families in the order they are tried. Every family matches on
 * `eventType` alone and the types are disjoint, so the order only decides
 * which file a reader opens first.
 */
const PROJECTORS: ReadonlyArray<
  (ctx: ProjectionContext) => ThreadActivityProjection | null
> = [
  projectToolEvents,
  projectRequestEvents,
  projectSessionEvents,
  projectTurnEvents,
]

/**
 * Turns one provider runtime event into the durable, user-visible activity
 * row it stands for, or null when the event carries nothing to show. A tool
 * activity's or an approval request's payload is bounded (see
 * `output-bounds.ts`); `boundToolOutput: false` returns it whole, for
 * reading the full output back from the journal.
 */
export function projectProviderEventToThreadActivity(
  event: LegacyProviderEvent,
  sequence: number,
  options: { readonly boundToolOutput?: boolean } = {}
): ThreadActivityProjection | null {
  const eventType = event.event_type
  const threadId = event.thread_id
  if (!threadId) return null

  const payload = flattenProviderPayload(asRecord(event.payload))
  const ctx: ProjectionContext = {
    event,
    eventType,
    threadId,
    payload,
    providerKind: normalizeProviderKind(payload),
    providerInstanceId: providerInstanceIdFromPayload(payload),
    createdAt:
      numericTimestamp(payload.started_at) ??
      numericTimestamp(payload.completed_at) ??
      readString(payload, "createdAt", "created_at"),
    sequence,
  }
  for (const project of PROJECTORS) {
    const activity = project(ctx)
    if (activity) {
      return options.boundToolOutput === false
        ? activity
        : boundThreadActivity(activity)
    }
  }
  return null
}

function numericTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number") return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}
