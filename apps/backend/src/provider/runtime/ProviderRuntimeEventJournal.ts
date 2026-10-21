import { isRecord } from "@betterc0de/schema"
import { randomUUID } from "node:crypto"
import type { EventStore } from "../../persistence/eventStore"
import type { OrchestrationEvent } from "../../persistence/eventStore"
import { logger } from "../../observability/logger"
import type { LegacyProviderEvent } from "../types"
import type { ProviderRuntimeEvent as CanonicalProviderRuntimeEvent } from "./contracts"
import type { ProviderRuntimeEventJournal as ProviderRuntimeEventJournalPort } from "./ProviderRuntimeIngestion"
import {
  CANONICAL_JOURNAL_SCHEMA,
  JOURNAL_PAYLOAD_TRUNCATED_KEY,
  JOURNAL_TRUNCATION_MARKER_KEY,
  LEGACY_JOURNAL_SCHEMA,
  stripRaw,
  type JournalTruncationRecord,
  type ProviderRuntimeJournalEntry,
} from "./journalEntry"

export { JOURNAL_PAYLOAD_TRUNCATED_KEY, JOURNAL_TRUNCATION_MARKER_KEY }

export const MAX_JOURNALED_PROVIDER_EVENT_BYTES = 1024 * 1024
/**
 * First per-string cap tried when an event is over the journal limit. Halved
 * until the whole event fits; a cap that cuts nothing is skipped, not treated
 * as "unboundable" — an event made of many strings that each sit under the
 * first cap (25 × 60 KiB MCP content blocks) is bounded at a smaller one.
 * Bounding below the floor means the event is structurally oversized
 * (thousands of keys) rather than carrying big values.
 */
const JOURNAL_STRING_CAP_INITIAL_BYTES = 64 * 1024
const JOURNAL_STRING_CAP_FLOOR_BYTES = 256
const JOURNAL_TRUNCATION_MAX_DEPTH = 32
/** Patch fields of a `turn.diff.updated` event; dropped whole, never cut. */
const DIFF_PATCH_KEYS = [
  "unifiedDiff",
  "unified_diff",
  "diff",
  "patch",
] as const
/**
 * Identity and correlation keys that are never cut at any depth, whatever
 * the cap. The hub injects `payload.dispatchTurnId`, adapters nest
 * `payload.turn_id` / `payload.toolUseId` / `payload.requestId`, and the
 * projections correlate on them: a cut id would orphan the activity even
 * though the row replays. Only string values are protected — an object under
 * one of these names is not an id and is walked like any other.
 */
const PROTECTED_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "threadId",
  "thread_id",
  "eventId",
  "event_id",
  "turnId",
  "turn_id",
  "dispatchTurnId",
  "itemId",
  "item_id",
  "toolId",
  "tool_id",
  "toolUseId",
  "requestId",
  "request_id",
  "sessionId",
  "session_id",
  "providerInstanceId",
  "correlationId",
])
/**
 * Root keys of a canonical event that are never cut, whatever the cap:
 * identity and correlation. All are short in practice (the floor is 256 B),
 * but a row whose `threadId` or `type` was cut would be unreadable, so they
 * are protected explicitly rather than by luck.
 */
const PROTECTED_CANONICAL_ROOT_KEYS: ReadonlySet<string> = new Set([
  "type",
  "threadId",
  "eventId",
  "turnId",
  "provider",
  "providerKind",
  "providerInstanceId",
  "itemId",
  "requestId",
  "toolId",
  "sessionId",
  "taskId",
  "parentTaskId",
  "agentId",
  "parentAgentId",
  "parentEventId",
  "parentToolId",
  "createdAt",
])

export interface ProviderRuntimeJournalPersistResult {
  readonly sequence: number
  /**
   * The entry exactly as journaled. Differs from the input only when the
   * event had to be bounded (or, for a canonical entry, when `raw` was
   * stripped); the caller projects and broadcasts this one so live and
   * replay never disagree about what the user saw.
   */
  readonly entry: ProviderRuntimeJournalEntry
  /**
   * Set when the event was bounded. A legacy entry already carries the
   * markers inside its `payload` (this record is informational); a canonical
   * entry stays pure and the caller decorates the legacy view from it.
   */
  readonly truncation: JournalTruncationRecord | null
}
const DEFAULT_RETENTION_MAX_EVENTS = 50_000
const DEFAULT_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const DEFAULT_PRUNE_EVERY = 256
export class ProviderRuntimeJournalSerializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ProviderRuntimeJournalSerializationError"
  }
}

/** One journal row, prepared per entry shape, before the shared append. */
interface PreparedJournalRow {
  readonly payloadJson: string
  readonly metadataJson: string
  readonly envelopeType: string
  readonly streamId: string
  readonly entry: ProviderRuntimeJournalEntry
  readonly truncation: JournalTruncationRecord | null
}

/** Durably records provider events before projections and broadcast. */
export class ProviderRuntimeEventJournal implements ProviderRuntimeEventJournalPort {
  private persistedSincePrune = 0

  constructor(
    private readonly events: EventStore,
    private readonly options: {
      readonly retentionMaxEvents?: number
      readonly retentionMaxAgeMs?: number
      readonly pruneEvery?: number
      readonly now?: () => number
    } = {}
  ) {
    this.tryPrune()
  }

  persist(
    entry: ProviderRuntimeJournalEntry,
    sequence: number,
    recoveryEventId?: string
  ): ProviderRuntimeJournalPersistResult {
    const row =
      entry.shape === "canonical"
        ? prepareCanonicalRow(entry.event)
        : prepareLegacyRow(entry.event)
    const result: ProviderRuntimeJournalPersistResult = {
      sequence: 0,
      entry: row.entry,
      truncation: row.truncation,
    }

    const eventId = recoveryEventId ?? randomUUID()
    if (recoveryEventId) {
      const equivalent = this.findEquivalentStreamEvent(eventId, row, sequence)
      if (equivalent) return { ...result, sequence: equivalent.sequence }
    }

    let stored: OrchestrationEvent | undefined
    try {
      ;[stored] = this.events.append([
        {
          event_id: eventId,
          aggregate_kind: "provider_runtime",
          stream_id: row.streamId,
          stream_version: sequence,
          event_type: row.envelopeType,
          occurred_at: new Date().toISOString(),
          command_id: null,
          causation_event_id: null,
          correlation_id: null,
          actor_kind: "provider",
          payload_json: row.payloadJson,
          metadata_json: row.metadataJson,
        },
      ])
    } catch (error) {
      const committed = recoveryEventId
        ? this.findEquivalentCommittedEvent(eventId, row, sequence)
        : null
      if (committed) return { ...result, sequence: committed.sequence }
      throw error
    }
    if (!stored || !Number.isSafeInteger(stored.sequence)) {
      throw new Error("Provider runtime journal append returned no sequence.")
    }
    this.persistedSincePrune += 1
    if (this.persistedSincePrune >= this.pruneEvery) this.tryPrune()
    return { ...result, sequence: stored.sequence }
  }

  private findEquivalentStreamEvent(
    eventId: string,
    row: PreparedJournalRow,
    sequence: number
  ): OrchestrationEvent | null {
    const candidates =
      this.events.readProviderRuntimeByStreamVersion?.(
        row.streamId,
        sequence
      ) ?? []
    return (
      candidates.find(
        (candidate) =>
          candidate.event_id !== eventId &&
          isEquivalentProviderRuntimeEvent(candidate, row, sequence)
      ) ?? null
    )
  }

  private findEquivalentCommittedEvent(
    eventId: string,
    row: PreparedJournalRow,
    sequence: number
  ): OrchestrationEvent | null {
    const byId = this.events.readByEventId?.(eventId)
    if (isEquivalentProviderRuntimeEvent(byId, row, sequence)) {
      return byId
    }
    return this.findEquivalentStreamEvent(eventId, row, sequence)
  }

  private get pruneEvery(): number {
    return positiveInteger(this.options.pruneEvery, DEFAULT_PRUNE_EVERY)
  }

  private tryPrune(): void {
    if (typeof this.events.pruneProviderRuntimeEvents !== "function") return
    const now = this.options.now?.() ?? Date.now()
    const retentionMaxAgeMs = positiveInteger(
      this.options.retentionMaxAgeMs,
      DEFAULT_RETENTION_MAX_AGE_MS
    )
    try {
      this.events.pruneProviderRuntimeEvents({
        olderThan: new Date(now - retentionMaxAgeMs).toISOString(),
        maxEvents: positiveInteger(
          this.options.retentionMaxEvents,
          DEFAULT_RETENTION_MAX_EVENTS
        ),
      })
      this.persistedSincePrune = 0
    } catch (err) {
      logger.warn({ err }, "failed to prune provider runtime audit events")
    }
  }
}

function serializeOrThrow(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    throw new ProviderRuntimeJournalSerializationError(
      "Provider runtime event cannot be serialized for durable journaling.",
      { cause: error }
    )
  }
}

/**
 * Legacy rows are byte-identical to what this journal wrote before it learned
 * the canonical shape: `schema: 2`, markers inside `payload`.
 */
function prepareLegacyRow(event: LegacyProviderEvent): PreparedJournalRow {
  let payloadJson = serializeOrThrow(event)
  const bytes = Buffer.byteLength(payloadJson, "utf8")
  let truncation: JournalPayloadTruncation | null = null
  let journaled: LegacyProviderEvent = event
  if (bytes > MAX_JOURNALED_PROVIDER_EVENT_BYTES) {
    // A 2 MB tool result must not cost the user the rest of the turn. Keep
    // every structural field, bound the big string values, and journal
    // that. The bounded event is what the caller projects and broadcasts
    // too: journal-first means the replay can never show less than live.
    truncation = boundProviderRuntimeEventForJournal(
      event,
      bytes,
      MAX_JOURNALED_PROVIDER_EVENT_BYTES
    )
    if (!truncation) throw oversizedError(bytes)
    payloadJson = truncation.payload
    journaled = truncation.event
    logJournalTruncation(event.thread_id, event.event_type, bytes, truncation)
  }
  return {
    payloadJson,
    metadataJson: JSON.stringify({
      schema: LEGACY_JOURNAL_SCHEMA,
      contract: "provider-runtime-event",
      durability: "journal-first",
      // Not `truncated` — the replayer refuses that key as audit-only. This
      // copy replays fine; it is just shorter than what the provider said.
      ...(truncation ? { payloadTruncated: true, originalBytes: bytes } : {}),
    }),
    envelopeType: `ProviderRuntime:${event.event_type}`,
    streamId: event.thread_id,
    entry: { shape: "legacy", event: journaled },
    truncation: truncation
      ? {
          originalBytes: bytes,
          ...(truncation.stringCapBytes !== null
            ? { stringCapBytes: truncation.stringCapBytes }
            : {}),
          fields: truncation.fields,
        }
      : null,
  }
}

/**
 * Canonical rows store the event pure: no marker keys inside it, `raw`
 * stripped, and the truncation record (when any) in `metadata_json` under
 * `payloadTruncated` / `originalBytes` / `stringCapBytes` / `truncatedFields`.
 */
function prepareCanonicalRow(
  input: CanonicalProviderRuntimeEvent
): PreparedJournalRow {
  const event = stripRaw(input)
  let payloadJson = serializeOrThrow(event)
  const bytes = Buffer.byteLength(payloadJson, "utf8")
  let truncation: JournalCanonicalTruncation | null = null
  let journaled = event
  if (bytes > MAX_JOURNALED_PROVIDER_EVENT_BYTES) {
    truncation = boundCanonicalEventForJournal(
      event,
      bytes,
      MAX_JOURNALED_PROVIDER_EVENT_BYTES
    )
    if (!truncation) throw oversizedError(bytes)
    payloadJson = truncation.payload
    journaled = truncation.event
    logJournalTruncation(event.threadId, event.type, bytes, truncation)
  }
  return {
    payloadJson,
    metadataJson: JSON.stringify({
      schema: CANONICAL_JOURNAL_SCHEMA,
      contract: "provider-runtime-event",
      durability: "journal-first",
      ...(truncation
        ? {
            payloadTruncated: true,
            originalBytes: bytes,
            ...(truncation.stringCapBytes !== null
              ? { stringCapBytes: truncation.stringCapBytes }
              : {}),
            truncatedFields: truncation.fields,
          }
        : {}),
    }),
    envelopeType: `ProviderRuntime:${event.type}`,
    streamId: event.threadId,
    entry: { shape: "canonical", event: journaled },
    truncation: truncation
      ? {
          originalBytes: bytes,
          ...(truncation.stringCapBytes !== null
            ? { stringCapBytes: truncation.stringCapBytes }
            : {}),
          fields: truncation.fields,
        }
      : null,
  }
}

function oversizedError(
  bytes: number
): ProviderRuntimeJournalSerializationError {
  return new ProviderRuntimeJournalSerializationError(
    `Provider runtime event is ${bytes} bytes and could not be bounded to the recoverable journal limit of ${MAX_JOURNALED_PROVIDER_EVENT_BYTES} bytes.`
  )
}

function logJournalTruncation(
  thread: string,
  eventType: string,
  originalBytes: number,
  truncation: { readonly bytes: number; readonly fields: ReadonlyArray<string> }
): void {
  logger.warn(
    {
      thread,
      event_type: eventType,
      originalBytes,
      journaledBytes: truncation.bytes,
      truncatedFields: truncation.fields,
    },
    "provider runtime event exceeded the journal limit; journaled with bounded string values"
  )
}

interface JournalPayloadTruncation {
  readonly payload: string
  readonly bytes: number
  readonly fields: ReadonlyArray<string>
  readonly stringCapBytes: number | null
  /** The bounded event as an object — what the caller projects live. */
  readonly event: LegacyProviderEvent
}

interface JournalCanonicalTruncation {
  readonly payload: string
  readonly bytes: number
  readonly fields: ReadonlyArray<string>
  readonly stringCapBytes: number | null
  readonly event: CanonicalProviderRuntimeEvent
}

function isDiffEvent(eventType: string): boolean {
  return eventType === "turn.diff.updated" || eventType === "turn_diff_updated"
}

/**
 * Returns the legacy event re-serialized with oversized string values cut to
 * a prefix, or null when no per-string cap above the floor makes it fit.
 *
 * Strings stay strings so replay projections keep reading them, and they are
 * cut clean — no inline suffix, which would corrupt anything a consumer
 * parses (JSON output, base64, a patch). The cut is recorded structurally:
 * once under `payload.journal_truncation`, plus the flat `payloadTruncated`
 * flag. A `turn.diff.updated` patch is not cut at all: a partial unified diff
 * is not a diff, so the patch is dropped and the event's existing
 * `diffTruncated` flag is set — the same shape the checkpoint reactor uses
 * when its own output limit trips, so the diff panel already understands it.
 */
export function boundProviderRuntimeEventForJournal(
  event: LegacyProviderEvent,
  originalBytes: number,
  maxBytes: number
): JournalPayloadTruncation | null {
  const droppedFields: string[] = []
  let basePayload = event.payload as Record<string, unknown>
  if (isDiffEvent(event.event_type)) {
    const { payload, dropped } = dropDiffPatch(basePayload)
    droppedFields.push(...dropped)
    if (dropped.length > 0) {
      basePayload = payload
      const asIs = finishBounded(
        event,
        basePayload,
        originalBytes,
        null,
        droppedFields
      )
      if (asIs && asIs.bytes <= maxBytes) return asIs
    }
  }
  for (
    let cap = JOURNAL_STRING_CAP_INITIAL_BYTES;
    cap >= JOURNAL_STRING_CAP_FLOOR_BYTES;
    cap = Math.floor(cap / 2)
  ) {
    const fields: string[] = []
    const boundedPayload = boundStrings(basePayload, cap, "", 0, fields)
    // Nothing cut at this cap: the event would serialize to the same bytes
    // that were already over the limit (or to the `asIs` diff row above), so
    // try the next smaller cap. Only an exhausted ladder means unboundable.
    if (fields.length === 0) continue
    const bounded = finishBounded(
      event,
      boundedPayload as Record<string, unknown>,
      originalBytes,
      cap,
      [...droppedFields, ...fields]
    )
    if (!bounded) return null
    if (bounded.bytes <= maxBytes) return bounded
  }
  return null
}

/**
 * The canonical twin of `boundProviderRuntimeEventForJournal`. Big strings
 * sit at the event root (`output`, `input`, `delta`, `text`, `planMarkdown`,
 * `error`) as well as inside `payload`, so the whole event is walked, with
 * the identity keys protected. The diff rule is the same (patch dropped from
 * `payload`, `diffTruncated` + `diffTruncationReason: "journal_limit"` set).
 * No marker is written into the event; the caller records the cut in the
 * row metadata and decorates the legacy view from it.
 */
export function boundCanonicalEventForJournal(
  event: CanonicalProviderRuntimeEvent,
  originalBytes: number,
  maxBytes: number
): JournalCanonicalTruncation | null {
  const droppedFields: string[] = []
  let baseEvent = event as unknown as Record<string, unknown>
  if (isDiffEvent(event.type) && isRecord(baseEvent.payload)) {
    const { payload, dropped } = dropDiffPatch(baseEvent.payload)
    if (dropped.length > 0) {
      droppedFields.push(...dropped.map((key) => `payload.${key}`))
      baseEvent = { ...baseEvent, payload }
      const asIs = finishCanonicalBounded(baseEvent, null, droppedFields)
      if (asIs && asIs.bytes <= maxBytes) return asIs
    }
  }
  for (
    let cap = JOURNAL_STRING_CAP_INITIAL_BYTES;
    cap >= JOURNAL_STRING_CAP_FLOOR_BYTES;
    cap = Math.floor(cap / 2)
  ) {
    const fields: string[] = []
    const bounded: Record<string, unknown> = Object.create(null)
    for (const [key, value] of Object.entries(baseEvent)) {
      bounded[key] = PROTECTED_CANONICAL_ROOT_KEYS.has(key)
        ? value
        : boundStrings(value, cap, key, 1, fields)
    }
    // Same rule as the legacy twin: a cap that cuts nothing cannot make the
    // event smaller, so move on to the next one rather than giving up.
    if (fields.length === 0) continue
    const finished = finishCanonicalBounded(bounded, cap, [
      ...droppedFields,
      ...fields,
    ])
    if (!finished) return null
    if (finished.bytes <= maxBytes) return finished
  }
  return null
}

function dropDiffPatch(payload: Record<string, unknown>): {
  readonly payload: Record<string, unknown>
  readonly dropped: string[]
} {
  const withoutPatch: Record<string, unknown> = { ...payload }
  const dropped: string[] = []
  for (const key of DIFF_PATCH_KEYS) {
    if (typeof withoutPatch[key] === "string") {
      delete withoutPatch[key]
      dropped.push(key)
    }
  }
  if (dropped.length === 0) return { payload, dropped }
  return {
    payload: {
      ...withoutPatch,
      diffTruncated: true,
      diffTruncationReason: "journal_limit",
    },
    dropped,
  }
}

function finishBounded(
  event: LegacyProviderEvent,
  payload: Record<string, unknown>,
  originalBytes: number,
  stringCapBytes: number | null,
  fields: ReadonlyArray<string>
): JournalPayloadTruncation | null {
  const bounded: LegacyProviderEvent = {
    ...event,
    payload: {
      ...payload,
      [JOURNAL_PAYLOAD_TRUNCATED_KEY]: true,
      [JOURNAL_TRUNCATION_MARKER_KEY]: {
        truncated: true,
        originalBytes,
        ...(stringCapBytes !== null ? { stringCapBytes } : {}),
        fields,
      },
    },
  }
  let serialized: string
  try {
    serialized = JSON.stringify(bounded)
  } catch {
    return null
  }
  return {
    payload: serialized,
    bytes: Buffer.byteLength(serialized, "utf8"),
    fields,
    stringCapBytes,
    event: bounded,
  }
}

function finishCanonicalBounded(
  event: Record<string, unknown>,
  stringCapBytes: number | null,
  fields: ReadonlyArray<string>
): JournalCanonicalTruncation | null {
  let serialized: string
  try {
    serialized = JSON.stringify(event)
  } catch {
    return null
  }
  return {
    payload: serialized,
    bytes: Buffer.byteLength(serialized, "utf8"),
    fields,
    stringCapBytes,
    event: event as unknown as CanonicalProviderRuntimeEvent,
  }
}

function boundStrings(
  value: unknown,
  cap: number,
  path: string,
  depth: number,
  fields: string[]
): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= cap) return value
    fields.push(path || "$")
    return utf8PrefixForJournal(value, cap)
  }
  if (depth >= JOURNAL_TRUNCATION_MAX_DEPTH || value === null) return value
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      boundStrings(entry, cap, `${path}[${index}]`, depth + 1, fields)
    )
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null)
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      out[key] =
        typeof entry === "string" && PROTECTED_IDENTITY_KEYS.has(key)
          ? entry
          : boundStrings(
              entry,
              cap,
              path ? `${path}.${key}` : key,
              depth + 1,
              fields
            )
    }
    return out
  }
  return value
}

function utf8PrefixForJournal(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  let end = low
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1
  return value.slice(0, end)
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

/**
 * Whether a stored row is the same journal write as `row`: same stream,
 * version, envelope and payload bytes, the same row shape and the same
 * `payloadTruncated`. Metadata is compared parsed and by shape family, not
 * as a string: an older binary wrote `{}` or `{schema: 1}` where this one
 * writes `{schema: 2}`, and migration 51 rewrites `{}` to `{schema: 1}` —
 * none of that may make a spool record look new and re-append a duplicate.
 */
function isEquivalentProviderRuntimeEvent(
  candidate: OrchestrationEvent | null | undefined,
  row: PreparedJournalRow,
  sequence: number
): candidate is OrchestrationEvent {
  if (
    !candidate ||
    candidate.aggregate_kind !== "provider_runtime" ||
    candidate.stream_id !== row.streamId ||
    candidate.stream_version !== sequence ||
    candidate.event_type !== row.envelopeType ||
    candidate.payload_json !== row.payloadJson
  ) {
    return false
  }
  const expected = parseMetadataIdentity(row.metadataJson)
  const actual = parseMetadataIdentity(candidate.metadata_json)
  return (
    expected !== null &&
    actual !== null &&
    expected.shape === actual.shape &&
    expected.payloadTruncated === actual.payloadTruncated
  )
}

function parseMetadataIdentity(
  metadataJson: string
): { readonly shape: string; readonly payloadTruncated: boolean } | null {
  try {
    const parsed: unknown = JSON.parse(metadataJson)
    if (!isRecord(parsed)) return null
    return {
      shape: journalSchemaShape(parsed.schema),
      payloadTruncated: parsed.payloadTruncated === true,
    }
  } catch {
    return null
  }
}

/** `undefined | 1 | 2` are one shape family; `3` is the canonical one. */
function journalSchemaShape(schema: unknown): string {
  if (schema === undefined || schema === 1 || schema === 2) return "legacy"
  if (schema === CANONICAL_JOURNAL_SCHEMA) return "canonical"
  return `unknown:${String(schema)}`
}
