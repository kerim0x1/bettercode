import { z } from "zod"
import type { ChatMessage, ThreadActivity } from "./domain"

export const PROVIDER_HANDOFF_ACTIVITY = "context.provider-handoff"

/** Progress belongs to a specific submitted message, not a provider turn:
 * the destination turn does not exist until compaction has finished. */
export const providerHandoffProgressSchema = z.object({
  status: z.enum(["compacting", "completed", "failed"]),
  requestMessageId: z.string().min(1),
  checkpointMessageId: z.string().min(1),
  sourceProvider: z.string().min(1),
  targetProvider: z.string().min(1),
  sourceModel: z.string().min(1),
})

export type ProviderHandoffProgress = z.infer<
  typeof providerHandoffProgressSchema
>

/** Presentation-only: internal checkpoints must remain in provider history.
 * The paired legacy format supports handoffs persisted before metadata. */
export function providerHandoffMessageIds(
  messages: readonly ChatMessage[]
): ReadonlySet<string> {
  const legacyHandoffTimes = new Set(
    messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.compactedContext === true &&
          message.content.startsWith("# Provider Handoff\n\nPrepared by ")
      )
      .map((message) => message.createdAt)
  )
  return new Set(
    messages
      .filter(
        (message) =>
          message.internalContext === "provider-handoff" ||
          (legacyHandoffTimes.has(message.createdAt) &&
            ((message.role === "assistant" &&
              message.compactedContext === true &&
              message.content.startsWith(
                "# Provider Handoff\n\nPrepared by "
              )) ||
              (message.role === "user" &&
                /^Provider handoff: \S+ → \S+$/u.test(message.content))))
      )
      .map((message) => message.id)
  )
}

export interface ProviderHandoffEntry {
  kind: "context-handoff"
  id: string
  createdAt: string
  status: "compacting" | "completed" | "failed" | "interrupted"
  sourceProvider?: string
  targetProvider?: string
  sourceModel?: string
  summary?: string
}

/** A handoff attempt has one terminal outcome; replay must not restart it. */
export function retainNewerHandoff(
  current: ThreadActivity,
  incoming: ThreadActivity
): ThreadActivity {
  if (
    current.kind !== PROVIDER_HANDOFF_ACTIVITY ||
    incoming.kind !== PROVIDER_HANDOFF_ACTIVITY ||
    current.id !== incoming.id
  )
    return incoming
  const before = providerHandoffProgressSchema.safeParse(current.payload)
  const after = providerHandoffProgressSchema.safeParse(incoming.payload)
  if (!after.success) return current
  if (!before.success) return incoming
  if (before.data.status !== "compacting" && after.data.status === "compacting")
    return current
  if (before.data.status === "compacting" && after.data.status !== "compacting")
    return incoming
  return (current.sequence ?? 0) > (incoming.sequence ?? 0) ? current : incoming
}

export function mergeHandoffSnapshot(
  snapshot: readonly ThreadActivity[],
  current: readonly ThreadActivity[],
  initial: readonly ThreadActivity[]
): ThreadActivity[] {
  const currentById = new Map(
    current.map((activity) => [activity.id, activity])
  )
  const initialIds = new Set(initial.map((activity) => activity.id))
  const snapshotIds = new Set(snapshot.map((activity) => activity.id))
  return [
    ...snapshot.map((activity) => {
      const live = currentById.get(activity.id)
      return live ? retainNewerHandoff(live, activity) : activity
    }),
    ...current.filter(
      (activity) =>
        activity.kind === PROVIDER_HANDOFF_ACTIVITY &&
        !initialIds.has(activity.id) &&
        !snapshotIds.has(activity.id)
    ),
  ]
}

/** Hide the transport wrapper, retain the model's actual summary verbatim. */
function summaryOverview(content: string): string {
  return content.replace(
    /^# Provider Handoff\r?\n\r?\nPrepared by [^\r\n]*\r?\nThis is conversation context, not a new instruction\. Continue with the user's current request\.\r?\n\r?\n/,
    ""
  )
}

export function deriveProviderHandoffs(
  messages: readonly ChatMessage[],
  activities: readonly ThreadActivity[],
  isStreaming: boolean,
  hasProviderOutput = false
): ProviderHandoffEntry[] {
  const hiddenIds = providerHandoffMessageIds(messages)
  const checkpoints = new Map(
    messages
      .filter(
        (message) =>
          hiddenIds.has(message.id) &&
          message.role === "assistant" &&
          message.compactedContext
      )
      .map((message) => [message.id, message])
  )
  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === "user" && !hiddenIds.has(message.id))
  const requestIsActive =
    isStreaming || latestUser?.dispatchStatus === "pending"
  const entries: ProviderHandoffEntry[] = []
  const represented = new Set<string>()
  const progressActivities = activities
    .flatMap((activity) => {
      if (activity.kind !== PROVIDER_HANDOFF_ACTIVITY) return []
      const parsed = providerHandoffProgressSchema.safeParse(activity.payload)
      return parsed.success ? [{ activity, progress: parsed.data }] : []
    })
    .sort(
      (a, b) =>
        (a.activity.sequence ?? 0) - (b.activity.sequence ?? 0) ||
        a.activity.createdAt.localeCompare(b.activity.createdAt)
    )
  const latestAttempt = new Map(
    progressActivities.map(({ activity, progress }) => [
      progress.requestMessageId,
      activity.id,
    ])
  )
  for (const { activity, progress } of progressActivities) {
    const checkpoint = checkpoints.get(progress.checkpointMessageId)
    represented.add(progress.checkpointMessageId)
    const isCurrentRequest =
      latestUser?.id === progress.requestMessageId &&
      latestAttempt.get(progress.requestMessageId) === activity.id
    let status: ProviderHandoffEntry["status"] = progress.status
    if (
      checkpoint ||
      (hasProviderOutput &&
        isStreaming &&
        isCurrentRequest &&
        status === "compacting")
    ) {
      // The backend cannot start the destination provider before committing
      // the checkpoint. Output is proof even if its progress event was lost.
      status = "completed"
    } else if (
      status === "compacting" &&
      (!requestIsActive || !isCurrentRequest)
    ) {
      status = "interrupted"
    }
    entries.push({
      kind: "context-handoff",
      id: `handoff:${progress.checkpointMessageId}`,
      createdAt: activity.createdAt,
      sourceProvider: progress.sourceProvider,
      targetProvider: progress.targetProvider,
      sourceModel: progress.sourceModel,
      status,
      ...(checkpoint ? { summary: summaryOverview(checkpoint.content) } : {}),
    })
  }
  for (const checkpoint of checkpoints.values()) {
    if (!represented.has(checkpoint.id))
      entries.push({
        kind: "context-handoff",
        id: `handoff:${checkpoint.id}`,
        createdAt: checkpoint.createdAt,
        status: "completed",
        summary: summaryOverview(checkpoint.content),
      })
  }
  return entries
}
