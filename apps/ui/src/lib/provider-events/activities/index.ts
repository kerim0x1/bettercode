/**
 * Projects one provider event into the `ThreadActivity` row the transcript
 * shows. Mirrors the backend's `provider/activity-projection` for events the
 * renderer receives directly (Electron IPC, plugins); the families are cut
 * the same way so the two can be folded together.
 */

import type { ThreadActivity } from "@/lib/chat-store"
import {
  providerInstanceIdFromPayload,
  providerKindFromPayload,
} from "../payload"
import type { ActivityContext } from "./context"
import { projectRequestActivity } from "./request-events"
import { projectSessionActivity } from "./session-events"
import { projectToolActivity } from "./tool-events"
import { projectTurnActivity } from "./turn-events"

export { makeActivity } from "./shared"
export type { ActivityContext } from "./context"

/** Families in the order they are tried; their event types are disjoint. */
const PROJECTORS: ReadonlyArray<
  (ctx: ActivityContext) => ThreadActivity | null
> = [
  projectToolActivity,
  projectRequestActivity,
  projectSessionActivity,
  projectTurnActivity,
]

export function activityFromProviderEvent(
  threadId: string,
  type: string,
  payload: Record<string, unknown>
): ThreadActivity | null {
  const ctx: ActivityContext = {
    threadId,
    type,
    payload,
    providerKind: providerKindFromPayload(payload),
    providerInstanceId: providerInstanceIdFromPayload(payload),
  }
  for (const project of PROJECTORS) {
    const activity = project(ctx)
    if (activity) return activity
  }
  return null
}
