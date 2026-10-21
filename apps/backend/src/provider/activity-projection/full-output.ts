import { isRecord } from "@betterc0de/schema"
import type { EventStore } from "../../persistence/eventStore"
import type { ThreadActivityProjectionQuery } from "../../persistence/projections"
import {
  decorateLegacyViewWithTruncation,
  legacyViewOf,
} from "../runtime/journalEntry"
import { parsePersistedProviderRuntimeEvent } from "../runtime/ProviderRuntimeJournalReplayer"
import { projectProviderEventToThreadActivity } from "./index"
import { primaryToolActivityOutput, toolOutputByteSize } from "./output-bounds"

export interface ThreadActivityFullOutputDeps {
  readonly activities: Pick<ThreadActivityProjectionQuery, "findById">
  readonly events: Pick<EventStore, "readProviderRuntimeByStreamVersion">
}

export type ThreadActivityFullOutput =
  | {
      readonly status: "found"
      readonly activityId: string
      readonly output: unknown
      /** UTF-8 bytes of `output` (of its JSON when it is not a string). */
      readonly bytes: number
      /**
       * The journal itself had to bound the event (its 1 MiB row limit), so
       * this copy may be shorter than what the provider returned.
       */
      readonly truncated: boolean
    }
  /** No activity with this id in this thread. */
  | { readonly status: "not_found" }
  /** The activity is not a tool call, or the call has no output. */
  | { readonly status: "no_output" }
  /** The journal no longer holds the event (retention) or never did. */
  | { readonly status: "not_retained" }

/**
 * The full output of a tool activity whose stored payload was bounded
 * (`output-bounds.ts`), read back from the provider runtime journal.
 *
 * An activity's `sequence` is the journal row's `stream_version` in the
 * thread's stream: ingestion journals each event under the sequence it then
 * projects with, and startup replay projects a row with its stream version.
 * The row is decoded and projected again exactly as ingestion did, only
 * without the bound, and the copy whose activity id matches is the one the
 * stored activity came from. Journal retention (30 days, 50,000 projected
 * events) decides how long this works.
 */
export function readThreadActivityFullOutput(
  deps: ThreadActivityFullOutputDeps,
  threadId: string,
  activityId: string
): ThreadActivityFullOutput {
  const activity = deps.activities.findById(threadId, activityId)
  if (!activity) return { status: "not_found" }
  if (!activity.kind.startsWith("tool.")) return { status: "no_output" }
  const sequence = activity.sequence
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0
  ) {
    return { status: "not_retained" }
  }

  const rows = deps.events.readProviderRuntimeByStreamVersion(
    threadId,
    sequence
  )
  // Provider runtime stream versions are not unique (no index enforces it),
  // so the newest row that projects to this activity is the one it came from.
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    let projected
    let journalTruncated: boolean
    try {
      const parsed = parsePersistedProviderRuntimeEvent(row)
      let view = legacyViewOf(parsed.entry)
      if (!view) continue
      if (parsed.entry.shape === "canonical" && parsed.truncation) {
        view = decorateLegacyViewWithTruncation(view, parsed.truncation)
      }
      journalTruncated = parsed.truncation !== null
      projected = projectProviderEventToThreadActivity(
        view,
        row.stream_version,
        { boundToolOutput: false }
      )
    } catch {
      // An unreadable row is the replayer's problem; it holds no output here.
      continue
    }
    if (!projected || projected.activity_id !== activityId) continue
    const payload = isRecord(projected.payload) ? projected.payload : {}
    const primary = primaryToolActivityOutput(payload)
    if (!primary) return { status: "no_output" }
    return {
      status: "found",
      activityId,
      output: primary.value,
      bytes: toolOutputByteSize(primary.value),
      truncated: journalTruncated,
    }
  }
  return { status: "not_retained" }
}
