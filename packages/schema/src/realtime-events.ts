import { z } from "zod"
import type { ThreadActivity } from "./domain"
import { isRecord } from "./json-read"
import { threadActivityResponseSchema } from "./thread-records"
import {
  threadMetadataFrameSchema,
  type ThreadMetadataFrame,
} from "./thread-metadata"

/**
 * The channels the backend pushes over its WebSocket (`apps/backend/src/ws`)
 * that a client applies to its state, and the payload each one carries. A
 * client parses a frame's payload with these before it touches its stores;
 * a frame that does not match is dropped, not cast.
 *
 * Every object is `passthrough`: a newer desktop may add a field, and an
 * older client keeps it instead of refusing the frame.
 */

const optionalText = z.string().nullish()

/**
 * `provider.runtimeEvent`: one provider event of a chat, legacy
 * (`event_type`, `thread_id`) or canonical (`type`, `threadId`) in shape. The
 * event's own fields are in `payload`, or at the top level of older events.
 */
export const providerRuntimeEventFrameSchema = z
  .object({
    event_type: optionalText,
    type: optionalText,
    thread_id: optionalText,
    threadId: optionalText,
    payload: z.unknown().optional(),
  })
  .passthrough()
  .refine((event) => Boolean(event.event_type ?? event.type), {
    message: "the event names no type",
  })
  .refine((event) => Boolean(event.thread_id ?? event.threadId), {
    message: "the event names no thread",
  })
  .refine((event) => event.payload == null || isRecord(event.payload), {
    message: "the payload is not an object",
    path: ["payload"],
  })
export type ProviderRuntimeEventFrame = z.infer<
  typeof providerRuntimeEventFrameSchema
>

/**
 * `provider.replayGap`: the backend could not replay every provider event a
 * client missed, so the client reloads what it shows from the backend.
 */
export const providerReplayGapFrameSchema = z
  .object({ type: z.literal("provider_replay_gap") })
  .passthrough()

/** A realtime event a client can apply, by channel. */
export type RealtimeEvent =
  | { channel: "provider.replayGap" }
  /** A chat renamed, or its settings changed, on any client. */
  | { channel: "thread.metadata"; data: ThreadMetadataFrame }
  | { channel: "thread.activity"; data: ThreadActivity }
  | {
      channel: "provider.runtimeEvent"
      data: ProviderRuntimeEventFrame
      /** `event_type`, else `type`. */
      eventType: string
      /** `thread_id`, else `threadId`. */
      threadId: string
    }

export type RealtimeChannel = RealtimeEvent["channel"]

/**
 * What a client does with one frame: apply the event, drop an invalid one
 * (with the first problem, which names a field, never a value), or ignore a
 * channel it does not handle.
 */
export type RealtimeEventParse =
  | { readonly kind: "event"; readonly event: RealtimeEvent }
  | {
      readonly kind: "invalid"
      readonly channel: RealtimeChannel
      readonly issue: string
    }
  | { readonly kind: "unknown" }

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return "invalid payload"
  const path = issue.path.map(String).join(".")
  return path ? `${path}: ${issue.message}` : issue.message
}

/** Parses the payload of one realtime frame by its channel. */
export function parseRealtimeEvent(
  channel: string,
  data: unknown
): RealtimeEventParse {
  switch (channel) {
    case "provider.replayGap": {
      const parsed = providerReplayGapFrameSchema.safeParse(data)
      return parsed.success
        ? { kind: "event", event: { channel } }
        : { kind: "invalid", channel, issue: firstIssue(parsed.error) }
    }
    case "thread.metadata": {
      const parsed = threadMetadataFrameSchema.safeParse(data)
      return parsed.success
        ? { kind: "event", event: { channel, data: parsed.data } }
        : { kind: "invalid", channel, issue: firstIssue(parsed.error) }
    }
    case "thread.activity": {
      const parsed = threadActivityResponseSchema.safeParse(data)
      return parsed.success
        ? { kind: "event", event: { channel, data: parsed.data } }
        : { kind: "invalid", channel, issue: firstIssue(parsed.error) }
    }
    case "provider.runtimeEvent": {
      const parsed = providerRuntimeEventFrameSchema.safeParse(data)
      if (!parsed.success) {
        return { kind: "invalid", channel, issue: firstIssue(parsed.error) }
      }
      const event = parsed.data
      return {
        kind: "event",
        event: {
          channel,
          data: event,
          // The refinements above guarantee both are non-empty strings.
          eventType: (event.event_type ?? event.type) as string,
          threadId: (event.thread_id ?? event.threadId) as string,
        },
      }
    }
    default:
      return { kind: "unknown" }
  }
}
