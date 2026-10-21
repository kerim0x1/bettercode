/**
 * Head/tail bound for the tool activities the renderer projects itself
 * (RAM-04).
 *
 * The backend bounds every tool activity it stores and broadcasts. Provider
 * plugins send their events to the renderer only, over the desktop bridge, and
 * `lib/provider-events/activities` projects those into the chat store without
 * a backend copy. Without this bound one large command output would sit in the
 * store, often twice (`output` plus a mirrored `detail` / `rawOutput`), for as
 * long as the thread stays loaded.
 *
 * The bound is the backend's own, shared through
 * `@betterc0de/schema/output-bounds` (tool activities only, not approval
 * requests): the same budget, keys, cut order and marker text, so a bounded
 * live activity looks exactly like a bounded stored one. The renderer adds
 * only the {@link OUTPUT_BOUNDED_IN_RENDERER} flag: a renderer-bounded
 * activity has no journal row behind it, so its full output cannot be read
 * back (see `lib/tool-full-output.ts`).
 */
import type { ThreadActivity } from "@betterc0de/schema"
import {
  boundToolActivity,
  TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES,
} from "@betterc0de/schema/output-bounds"

/**
 * Payload flag of an activity this module bounded. Only the renderer sets it;
 * there is no stored copy of such an activity's full output.
 */
export const OUTPUT_BOUNDED_IN_RENDERER = "outputBoundedInRenderer"

const RENDERER_BOUND_MARK: Readonly<Record<string, unknown>> = {
  [OUTPUT_BOUNDED_IN_RENDERER]: true,
}

/**
 * A tool activity the renderer projected, as the store keeps it: payload
 * bounded, summary and presentation text cut to one inline row, and
 * {@link OUTPUT_BOUNDED_IN_RENDERER} set when the payload was cut. Other
 * activity kinds pass through untouched; a plan must never be cut in the
 * middle.
 */
export function boundLiveToolActivity(
  activity: ThreadActivity,
  budgetBytes: number = TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES
): ThreadActivity {
  return boundToolActivity(activity, {
    budgetBytes,
    boundedPayloadFields: RENDERER_BOUND_MARK,
  })
}
