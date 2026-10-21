import type { ProviderRuntimeEvent as CanonicalProviderRuntimeEvent } from "./contracts"
import type { ProviderRuntimeEvent as LegacyProviderRuntimeEvent } from "../types"
import { canonicalToLegacy } from "./legacyBridge"

/**
 * What the provider runtime journal stores, one row per entry.
 *
 * `shape: "canonical"` is the runtime stack's `ProviderRuntimeEvent` exactly
 * as the hub delivered it (minus `raw`, see `stripRaw`). It is journaled
 * before any translation so a bug in the legacy bridge can no longer lose
 * what the provider said; the bridge runs behind the journal, on the way to
 * projections and the wire.
 *
 * `shape: "legacy"` is the older `{event_type, thread_id, payload}` shape. It
 * is written only by the frozen in-process provider stack
 * (`provider/adapters/`, `provider/service.ts`) and by the checkpoint
 * reactor's own emissions; it is not a target for new producers. Every row
 * written before this split is legacy-shaped, so the reader keeps this arm
 * for as long as those rows exist.
 */
export type ProviderRuntimeJournalEntry =
  | {
      readonly shape: "canonical"
      readonly event: CanonicalProviderRuntimeEvent
    }
  | {
      readonly shape: "legacy"
      readonly event: LegacyProviderRuntimeEvent
    }

/** `metadata_json.schema` of a canonical row. `undefined | 1 | 2` are legacy. */
export const CANONICAL_JOURNAL_SCHEMA = 3
export const LEGACY_JOURNAL_SCHEMA = 2

/**
 * Marker keys a journal-bounded event carries in its legacy `payload`: the
 * structured record and a flat boolean companion so projections and clients
 * can read one field. Legacy rows store them inside `payload_json`; canonical
 * rows keep the event pure and store the record in `metadata_json`, and the
 * legacy view is decorated with the same two keys on the way out so nothing
 * downstream can tell the rows apart. Not `truncated` — the replayer refuses
 * that key in metadata as audit-only.
 */
export const JOURNAL_TRUNCATION_MARKER_KEY = "journal_truncation"
export const JOURNAL_PAYLOAD_TRUNCATED_KEY = "payloadTruncated"

/** How a journaled event was bounded to the row limit. */
export interface JournalTruncationRecord {
  readonly originalBytes: number
  readonly stringCapBytes?: number
  /**
   * Paths of the cut (or, for a diff patch, dropped) values. Event-root
   * relative for canonical entries (`output`, `payload.data.stdout`);
   * payload-relative for legacy entries (`output`, `data.stdout`).
   */
  readonly fields: ReadonlyArray<string>
}

export type LegacyViewBridge = (
  event: CanonicalProviderRuntimeEvent
) => LegacyProviderRuntimeEvent | null

export function canonicalJournalEntry(
  event: CanonicalProviderRuntimeEvent
): ProviderRuntimeJournalEntry {
  return { shape: "canonical", event }
}

export function legacyJournalEntry(
  event: LegacyProviderRuntimeEvent
): ProviderRuntimeJournalEntry {
  return { shape: "legacy", event }
}

export function journalEntryThreadId(
  entry: ProviderRuntimeJournalEntry
): string {
  return entry.shape === "canonical"
    ? entry.event.threadId
    : entry.event.thread_id
}

/** The bare type name; the row envelope is `ProviderRuntime:<this>`. */
export function journalEntryEventType(
  entry: ProviderRuntimeJournalEntry
): string {
  return entry.shape === "canonical" ? entry.event.type : entry.event.event_type
}

/**
 * Whether ingesting this entry settles a provider turn. The hub catches an
 * ingestion failure around its emit and marks the turn uncertain instead of
 * recorded; both shapes must rethrow for the same set of events or a
 * canonical `turn.completed` whose journal write failed would settle as if
 * it had been journaled.
 *
 * The set mirrors the hub's own (`observeTurnLifecycle`): `session.exited`
 * settles a correlated admission exactly like `turn.aborted` does — a
 * process that died mid-turn ends the turn — so an ingestion failure on it
 * has to reach the hub too, or the turn would settle as recorded when its
 * last event never made it to the journal.
 */
export function isTerminalJournalEntry(
  entry: ProviderRuntimeJournalEntry
): boolean {
  return isTerminalJournalEventType(journalEntryEventType(entry))
}

export function isTerminalJournalEventType(eventType: string): boolean {
  return (
    eventType === "turn_completed" ||
    eventType === "turn.completed" ||
    eventType === "turn_interrupted" ||
    eventType === "turn.aborted" ||
    eventType === "turn_error" ||
    eventType === "session.exited" ||
    eventType === "session_exited"
  )
}

/**
 * Streamed text is folded into the assistant transcript snapshot instead of
 * the journal when a transcript store exists (see event-persistence.md);
 * `message.delta` is the harness/Claude spelling of the same stream and
 * would otherwise flood the journal once canonical events are journaled.
 */
const TRANSCRIPT_LANE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "content_delta",
  "content.delta",
  "content_replace",
  "content.replace",
  "reasoning_delta",
  "reasoning.delta",
  "reasoning_replace",
  "reasoning.replace",
  "message.delta",
])

export function shouldJournalEventType(
  eventType: string,
  transcriptSnapshotsEnabled: boolean
): boolean {
  if (!eventType) return false
  if (!transcriptSnapshotsEnabled) return true
  return !TRANSCRIPT_LANE_EVENT_TYPES.has(eventType)
}

export function shouldJournalEntry(
  entry: ProviderRuntimeJournalEntry,
  transcriptSnapshotsEnabled: boolean
): boolean {
  return shouldJournalEventType(
    journalEntryEventType(entry),
    transcriptSnapshotsEnabled
  )
}

/** UTF-8 size of the entry as held in memory, or `fallback` when it cannot be serialized. */
export function journalEntryBytes(
  entry: ProviderRuntimeJournalEntry,
  fallback: number
): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry.event), "utf8")
  } catch {
    return fallback
  }
}

/**
 * The native provider envelope (`raw`) is consumed by nothing behind the
 * journal — not ingestion, not projection, not the bridge, not a client —
 * and for the ACP and BetterC0deCompat adapters it is the whole native
 * message, roughly doubling the row. The hub's NDJSON audit log still keeps
 * it. Returns the same object when there is nothing to strip.
 */
export function stripRaw(
  event: CanonicalProviderRuntimeEvent
): CanonicalProviderRuntimeEvent {
  if (!("raw" in event) || event.raw === undefined) return event
  const { raw: _raw, ...rest } = event
  return rest as CanonicalProviderRuntimeEvent
}

/**
 * The legacy `{event_type, thread_id, payload}` view of an entry — what
 * projections, the checkpoint reactor and both clients consume. This is the
 * only place the bridge runs on the journal path; `bridge` is injectable so
 * a test can stand in a broken one and prove the row was journaled anyway.
 * `null` means the bridge declined the event (it has no legacy twin).
 */
export function legacyViewOf(
  entry: ProviderRuntimeJournalEntry,
  bridge: LegacyViewBridge = canonicalToLegacy
): LegacyProviderRuntimeEvent | null {
  if (entry.shape === "legacy") return entry.event
  return bridge(entry.event)
}

/**
 * Writes the truncation markers into a legacy view's `payload`, exactly as
 * the journal writes them into a bounded legacy row, so the activity payload
 * and the wire frame of a bounded canonical row match those of a bounded
 * legacy row. Live (from the persist result) and replay (from row metadata)
 * decorate through this one function, so they cannot disagree.
 */
export function decorateLegacyViewWithTruncation(
  legacy: LegacyProviderRuntimeEvent,
  truncation: JournalTruncationRecord
): LegacyProviderRuntimeEvent {
  return {
    ...legacy,
    payload: {
      ...legacy.payload,
      [JOURNAL_PAYLOAD_TRUNCATED_KEY]: true,
      [JOURNAL_TRUNCATION_MARKER_KEY]: {
        truncated: true,
        originalBytes: truncation.originalBytes,
        ...(truncation.stringCapBytes !== undefined
          ? { stringCapBytes: truncation.stringCapBytes }
          : {}),
        fields: [...truncation.fields],
      },
    },
  }
}
