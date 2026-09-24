import {
  deriveProviderHandoffs,
  providerHandoffMessageIds,
  type ProviderHandoffEntry,
} from "@betterc0de/schema"
import type { ChatMessage, ThreadActivity } from "@/types/remote"

export type TimelineEntry =
  | { kind: "message"; id: string; message: ChatMessage }
  | { kind: "handoff"; id: string; entry: ProviderHandoffEntry }

/**
 * What the chat shows, in order: the messages, without the internal ones
 * that carry a provider handoff's context, and a notice for each handoff
 * where it happened. The rules are the desktop's (`@betterc0de/schema`);
 * a notice at the same moment as a message follows it, as on the desktop.
 */
export function chatTimeline(
  messages: readonly ChatMessage[],
  activities: readonly ThreadActivity[],
  options: { running: boolean; hasOutput: boolean }
): TimelineEntry[] {
  const hidden = providerHandoffMessageIds(messages)
  const notices = deriveProviderHandoffs(
    messages,
    activities,
    options.running,
    options.hasOutput
  )
    .map((entry) => ({ kind: "handoff" as const, id: entry.id, entry }))
    .sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt))
  const timeline: TimelineEntry[] = []
  let next = 0
  for (const message of messages) {
    if (hidden.has(message.id)) continue
    while (
      next < notices.length &&
      notices[next]!.entry.createdAt < message.createdAt
    ) {
      timeline.push(notices[next]!)
      next += 1
    }
    timeline.push({ kind: "message", id: message.id, message })
  }
  return [...timeline, ...notices.slice(next)]
}
