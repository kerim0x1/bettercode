import { isRecord, readString } from "@betterc0de/schema"
import type { LegacyProviderEvent } from "../types"
import {
  boundApprovalRequestPayload,
  boundToolActivityPayload,
} from "./output-bounds"
import { flattenProviderPayload, isToolLifecycleItemType } from "./shared"

/**
 * Bounds for the raw `provider.runtimeEvent` frame (RAM-04).
 *
 * Besides the projected `thread.activity`, every provider event goes out to
 * every client as it was journaled, and the WebSocket hub keeps the frame in
 * its replay journal. The journal caps one event at 1 MiB, so a tool result
 * or an approval for a large file write could still put a megabyte on the
 * wire and in each renderer's live tool state.
 *
 * The frame gets the same bounds as the activity the event projects to: the
 * tool events' payload through `boundToolActivityPayload` (head and tail of
 * each large value, a marker in the text, `outputTruncated` / `outputBytes`
 * / `truncatedFields`), an approval request's through
 * `boundApprovalRequestPayload`, which keeps whole what the approval card
 * renders and answers with. Everything else — assistant text, plans, diffs,
 * questions — is sent as is. Only the broadcast copy is bounded: the
 * journal, the projections and the post-journal listeners see the event
 * unchanged.
 */

/** Tool lifecycle frames, legacy and canonical. */
const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "tool_call",
  "tool_call_delta",
  "tool_result",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "tool.failed",
  "tool.denied",
  "tool.progress",
  "tool_progress",
  "tool.summary",
  "tool_summary",
])

/** Item frames, which are tool frames when their item type is a tool's. */
const ITEM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "item.started",
  "item_started",
  "item.updated",
  "item_updated",
  "item.completed",
  "item_completed",
])

function isToolRuntimeEvent(
  eventType: string,
  payload: Record<string, unknown>
): boolean {
  if (TOOL_EVENT_TYPES.has(eventType)) return true
  if (!ITEM_EVENT_TYPES.has(eventType)) return false
  // The same test the activity projection applies (`projectToolEvents`): an
  // assistant message or reasoning item is never cut.
  return isToolLifecycleItemType(
    readString(payload, "itemType", "item_type", "kind")
  )
}

/**
 * A tool approval request, as the renderer tells one apart (`request.opened`
 * in `normalize.ts`): not a plan approval, whose plan must stay whole, and
 * not a question.
 */
function isApprovalRequestRuntimeEvent(
  eventType: string,
  payload: Record<string, unknown>
): boolean {
  if (
    eventType !== "tool_approval_requested" &&
    eventType !== "request.opened"
  ) {
    return false
  }
  const kind = readString(payload, "kind")
  if (kind === "plan_approval" || kind === "user_input") return false
  return (
    readString(payload, "requestType", "request_type") !== "tool_user_input"
  )
}

/**
 * The copy of `event` that goes out on `provider.runtimeEvent`: the event
 * itself (same reference) unless it is a tool or approval frame over the
 * activity payload budget, then a copy with its payload bounded.
 */
export function boundProviderRuntimeEventForBroadcast(
  event: LegacyProviderEvent
): LegacyProviderEvent {
  const payload = event.payload
  if (!isRecord(payload)) return event
  const eventType = event.event_type
  const flat = flattenProviderPayload(payload)
  const bounded = isToolRuntimeEvent(eventType, flat)
    ? boundToolActivityPayload(payload)
    : isApprovalRequestRuntimeEvent(eventType, flat)
      ? boundApprovalRequestPayload(payload)
      : payload
  return bounded === payload ? event : { ...event, payload: bounded }
}
