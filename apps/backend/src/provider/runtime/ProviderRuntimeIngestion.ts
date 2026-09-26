import type { ThreadActivityProjection } from "../../persistence/projections"
import type {
  ThreadMessageUpsertRequest,
  ThreadSaveMessage,
} from "../../services/threads/types"
import { projectProviderEventToThreadActivity } from "../activity-projection"
import type { ProviderRuntimeEvent } from "../types"
import type { ProviderRuntimeEvent as CanonicalProviderRuntimeEvent } from "./contracts"
import { getBackendLoggingSettings } from "../../observability/logger"
import { ProviderRuntimeJournalSerializationError } from "./ProviderRuntimeEventJournal"
import {
  canonicalJournalEntry,
  decorateLegacyViewWithTruncation,
  isTerminalJournalEntry,
  isTerminalJournalEventType,
  journalEntryBytes,
  journalEntryEventType,
  journalEntryThreadId,
  legacyJournalEntry,
  legacyViewOf,
  shouldJournalEntry,
  type JournalTruncationRecord,
  type LegacyViewBridge,
  type ProviderRuntimeJournalEntry,
} from "./journalEntry"
import { canonicalProviderKindAlias } from "./providerKindAliases"
import { isGenericToolName, asRecord, readString } from "@betterc0de/schema"
import {
  backendMetrics,
  PROVIDER_JOURNAL_EVENTS_TOTAL,
  PROVIDER_TRANSCRIPT_SNAPSHOT_BYTES_TOTAL,
  PROVIDER_TRANSCRIPT_SNAPSHOTS_TOTAL,
} from "../../observability/metrics"

/**
 * Two intake lanes: `"event"` carries the legacy shape (the frozen in-process
 * provider stack and the checkpoint reactor's own emissions), `"canonical"`
 * carries the runtime hub's `ProviderRuntimeEvent`. Both are journaled
 * before anything else; only the canonical lane runs the legacy bridge, and
 * it runs it behind the journal.
 */
export interface ProviderRuntimeEventBusLike {
  on(
    eventName: "event",
    listener: (event: ProviderRuntimeEvent) => void
  ): unknown
  on(
    eventName: "canonical",
    listener: (event: CanonicalProviderRuntimeEvent) => void
  ): unknown
  off(
    eventName: "event",
    listener: (event: ProviderRuntimeEvent) => void
  ): unknown
  off(
    eventName: "canonical",
    listener: (event: CanonicalProviderRuntimeEvent) => void
  ): unknown
}

export interface ProviderRuntimeActivityStore {
  upsert(activity: ThreadActivityProjection): void
  listByThread?(threadId: string): ThreadActivityProjection[]
}

export interface ProviderRuntimeThreadMetadataStore {
  updateThreadTitle(threadId: string, title: string, updatedAt?: string): void
  updateThreadGoal?(threadId: string, goal: unknown, providerKind?: string, updatedAt?: string): void
}

type ProviderRuntimeLifecycleKind =
  | "codex"
  | "codex_cli"
  | "claude"
  | "anthropic_cli"
  | "cursor"
  | "betterc0de"
  | "BetterC0de"
  | "opencode_cli"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "grok"
  | "grok_cli"
  | "google"
  | "lmstudio"

type ProviderRuntimeLifecycleStatus =
  | "starting"
  | "ready"
  | "running"
  | "closing"
  | "closed"
  | "interrupted"
  | "stopped"
  | "error"

export interface ProviderRuntimeSessionLifecycleSnapshot {
  readonly activeTurnId?: string | null
  readonly lastError?: string | null
  readonly runtimeMode?: string | null
}

export interface ProviderRuntimeSessionLifecycleStore {
  get?(
    threadId: string,
    providerInstanceId: string
  ): ProviderRuntimeSessionLifecycleSnapshot | null

  updateSessionLifecycle(input: {
    readonly threadId: string
    readonly providerInstanceId: string
    readonly providerKind: ProviderRuntimeLifecycleKind
    readonly status: ProviderRuntimeLifecycleStatus
    readonly activeTurnId?: string | null
    readonly lastError?: string | null
    readonly runtimeMode?: string | null
  }): void
}

export interface ProviderRuntimeCheckpointDiffStore {
  recordRuntimeEvent(event: ProviderRuntimeEvent): void
}

export interface ProviderRuntimeEventJournal {
  /**
   * Returns the journal sequence, or the sequence together with the entry as
   * journaled when the journal had to bound it — the ingestion then projects
   * and broadcasts that bounded copy, never the larger in-memory original.
   * `truncation` describes the cut for a canonical entry so the legacy view
   * can be decorated with the same markers a bounded legacy row carries.
   */
  persist(
    entry: ProviderRuntimeJournalEntry,
    sequence: number,
    recoveryEventId?: string
  ):
    | number
    | void
    | {
        readonly sequence: number
        readonly entry: ProviderRuntimeJournalEntry
        readonly truncation?: JournalTruncationRecord | null
      }
}

export interface ProviderRuntimeProjectionReceiptStore {
  markProjected(eventSequence: number): void
}

export interface ProviderRuntimeChatDispatchLifecycleStore {
  hasProviderTurn(
    threadId: string,
    providerInstanceId: string | null,
    providerTurnId: string
  ): boolean
  markCompletedByProviderTurn(
    threadId: string,
    providerInstanceId: string | null,
    providerTurnId: string
  ): unknown
  markFailedByProviderTurn(
    threadId: string,
    providerInstanceId: string | null,
    providerTurnId: string,
    error: unknown
  ): unknown
}

export interface ProviderRuntimeTranscriptStore {
  upsertMessage(input: ThreadMessageUpsertRequest): void
  getMessage?(
    threadId: string,
    messageId: string
  ): ThreadSaveMessage | null
}

export interface ProviderRuntimeTranscriptRecoveryStore {
  enqueue(
    input: ThreadMessageUpsertRequest,
    metadata: {
      readonly reason: "retry_exhausted" | "memory_pressure" | "shutdown"
      readonly truncated: boolean
    }
  ): boolean
}

export interface ProviderRuntimeJournalRecoveryStore {
  enqueue(
    entry: ProviderRuntimeJournalEntry,
    input: { readonly projectionSequence: number }
  ): boolean
}

export interface SourceProposedPlanImplementationInput {
  readonly sourceProposedPlan: {
    readonly threadId: string
    readonly planId: string
  }
  readonly implementationThreadId: string
  readonly providerKind: string
  readonly providerInstanceId?: string | null
  readonly acceptedTurnId: string
}

export interface PendingSourceProposedPlanImplementationStore {
  recordPending(input: SourceProposedPlanImplementationInput): void
  peekPending(input: {
    readonly implementationThreadId: string
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId: string
  }): SourceProposedPlanImplementationInput | null
  ackPending(input: {
    readonly implementationThreadId: string
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId: string
  }): void
  clearPending?(input: {
    readonly implementationThreadId: string
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId?: string | null
  }): void
  clearAll(): number
}

export class InMemoryPendingSourceProposedPlanImplementationStore implements PendingSourceProposedPlanImplementationStore {
  private readonly pendingByThread = new Map<
    string,
    SourceProposedPlanImplementationInput
  >()

  recordPending(input: SourceProposedPlanImplementationInput): void {
    this.pendingByThread.set(input.implementationThreadId, input)
  }

  peekPending(input: {
    readonly implementationThreadId: string
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId: string
  }): SourceProposedPlanImplementationInput | null {
    const pending = this.pendingByThread.get(input.implementationThreadId)
    if (!pending || !sourcePlanImplementationMatches(pending, input)) {
      return null
    }
    return pending
  }

  ackPending(input: {
    readonly implementationThreadId: string
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId: string
  }): void {
    this.clearPending(input)
  }

  /** @deprecated Prefer peekPending followed by ackPending after projection. */
  consumePending(input: {
    readonly implementationThreadId: string
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId: string
  }): SourceProposedPlanImplementationInput | null {
    const pending = this.peekPending(input)
    if (pending) this.ackPending(input)
    return pending
  }

  clearPending(input: {
    readonly implementationThreadId: string
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId?: string | null
  }): void {
    const pending = this.pendingByThread.get(input.implementationThreadId)
    if (!pending || !sourcePlanImplementationMatches(pending, input)) return
    this.pendingByThread.delete(input.implementationThreadId)
  }

  clearAll(): number {
    const count = this.pendingByThread.size
    this.pendingByThread.clear()
    return count
  }
}

export interface ProviderRuntimeBroadcaster {
  broadcast(frame: unknown): void
  clientCount(): number
}

export interface ProviderRuntimeIngestionLogger {
  debug?(bindings: Record<string, unknown>, message: string): void
  info(bindings: Record<string, unknown>, message: string): void
  warn(bindings: Record<string, unknown>, message: string): void
  error(bindings: Record<string, unknown>, message: string): void
}

export interface ProviderRuntimeIngestionOptions {
  readonly eventBus: ProviderRuntimeEventBusLike
  readonly activityStore: ProviderRuntimeActivityStore
  readonly threadMetadataStore?: ProviderRuntimeThreadMetadataStore
  readonly sessionLifecycleStore?: ProviderRuntimeSessionLifecycleStore
  readonly checkpointDiffStore?: ProviderRuntimeCheckpointDiffStore
  readonly eventJournal?: ProviderRuntimeEventJournal
  readonly journalRecoveryStore?: ProviderRuntimeJournalRecoveryStore
  readonly projectionReceipts?: ProviderRuntimeProjectionReceiptStore
  readonly chatDispatchLifecycleStore?: ProviderRuntimeChatDispatchLifecycleStore
  readonly shouldPersistConversations?: () => boolean
  readonly transcriptStore?: ProviderRuntimeTranscriptStore
  readonly transcriptRecoveryStore?: ProviderRuntimeTranscriptRecoveryStore
  readonly onFatalDurabilityFailure?: (
    error: Error,
    context: { readonly threadId: string; readonly turnId: string }
  ) => void
  readonly onFatalProjectionFailure?: (
    error: Error,
    context: { readonly threadId: string; readonly eventType: string }
  ) => void
  readonly sourceProposedPlanImplementations?: PendingSourceProposedPlanImplementationStore
  readonly broadcaster: ProviderRuntimeBroadcaster
  readonly logger: ProviderRuntimeIngestionLogger
  readonly sequenceStart?: number
  readonly traceProviderEvents?: boolean
  readonly assistantTranscriptMaxBytes?: number
  readonly bufferedAssistantTranscriptsMaxBytes?: number
  readonly assistantTranscriptRetryBaseMs?: number
  readonly assistantTranscriptRetryMaxMs?: number
  readonly assistantTranscriptRetryMaxAttempts?: number
  readonly assistantTranscriptFlushBytes?: number
  readonly evictedAssistantTranscriptMaxKeys?: number
  readonly proposedPlanMaxBytes?: number
  readonly bufferedProposedPlansMaxBytes?: number
  readonly journalRetryBaseMs?: number
  readonly journalRetryMaxMs?: number
  readonly journalQueueMaxEvents?: number
  readonly journalQueueMaxBytes?: number
  /**
   * The canonical -> legacy bridge used behind the journal. Defaults to
   * `canonicalToLegacy`; injectable so a test can stand in a broken bridge
   * and prove the canonical row was journaled regardless.
   */
  readonly legacyView?: LegacyViewBridge
  /**
   * Post-projection lane: receives the legacy view of every live event the
   * bridge produced, after ingestion has processed it — journaled first
   * whenever journaling applies (never on startup replay). Not every event
   * is journaled: with conversation auto-save off only terminal dispatch
   * events are, and transcript-lane deltas fold into the snapshot instead;
   * those still arrive here. The checkpoint reactor listens here so it never
   * sees an event before the journal did, never one the bridge declined or
   * failed on, and never a journaled one whose projection was blocked.
   */
  readonly projectedSink?: (event: ProviderRuntimeEvent) => void
}

const MAX_BUFFERED_PROPOSED_PLANS = 10_000
const MAX_BUFFERED_ASSISTANT_TRANSCRIPTS = 1_000
const MAX_TRANSCRIPT_TOOL_CALLS = 128
const MAX_TRANSCRIPT_TOOL_VALUE_BYTES = 64 * 1024
const DEFAULT_ASSISTANT_TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_BUFFERED_ASSISTANT_TRANSCRIPTS_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_PROPOSED_PLAN_MAX_BYTES = 1024 * 1024
const DEFAULT_BUFFERED_PROPOSED_PLANS_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_ASSISTANT_TRANSCRIPT_RETRY_BASE_MS = 250
const DEFAULT_ASSISTANT_TRANSCRIPT_RETRY_MAX_MS = 5_000
const DEFAULT_ASSISTANT_TRANSCRIPT_RETRY_MAX_ATTEMPTS = 5
const DEFAULT_EVICTED_ASSISTANT_TRANSCRIPT_MAX_KEYS = 2_000
const ASSISTANT_TRANSCRIPT_FLUSH_DELAY_MS = 250
const DEFAULT_ASSISTANT_TRANSCRIPT_FLUSH_BYTES = 16 * 1024
const JOURNAL_PERSIST_ATTEMPTS = 3
const PROJECTION_RECEIPT_ATTEMPTS = 3
const DEFAULT_JOURNAL_RETRY_BASE_MS = 100
const DEFAULT_JOURNAL_RETRY_MAX_MS = 5_000
const DEFAULT_JOURNAL_QUEUE_MAX_EVENTS = 4_096
const DEFAULT_JOURNAL_QUEUE_MAX_BYTES = 32 * 1024 * 1024

interface BufferedProposedPlan {
  readonly payload: Record<string, unknown>
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
}

interface BufferedProposedPlanCompletion {
  readonly activity: ThreadActivityProjection | null
  readonly suppressDefaultActivity: boolean
}

interface QueuedProviderRuntimeEvent {
  readonly entry: ProviderRuntimeJournalEntry
  readonly bytes: number
}

interface ProcessProviderRuntimeEventOptions {
  readonly skipJournal?: boolean
  readonly skipBroadcast?: boolean
  readonly strictProjection?: boolean
  readonly projectionSequence?: number
  readonly forcePersistConversations?: boolean
  /** Startup replay: the truncation record read back from the row metadata. */
  readonly truncation?: JournalTruncationRecord | null
}

/**
 * The legacy bridge threw on an entry that is already journaled. Thrown out
 * of ingestion only for a terminal entry, so the hub settles the turn as
 * failed rather than recorded (the same outcome as under the old wiring,
 * where the bridge ran in front of the bus). Carries the bridge's own error
 * as `cause` and its message verbatim; by the time it is thrown the failure
 * has been logged and surfaced in the thread, so a catcher must not treat it
 * as a persistence failure — the row is durable and waits for replay.
 */
export class ProviderRuntimeBridgeError extends Error {
  constructor(cause: Error, readonly eventType: string) {
    super(cause.message, { cause })
    this.name = "ProviderRuntimeBridgeError"
  }
}

/**
 * `undefined`: nothing to journal (no journal configured); `null`: append
 * failed and the event was queued; `"fatal"`: never journalable; otherwise
 * the sequence plus the entry as journaled and how it was bounded.
 */
type JournalPersistResult =
  | {
      readonly sequence: number
      readonly entry: ProviderRuntimeJournalEntry
      readonly truncation: JournalTruncationRecord | null
    }
  | undefined
  | null
  | "fatal"

/** What a failure notice needs to know about the event that failed. */
interface ProviderRuntimeFailureSource {
  readonly threadId: string
  readonly eventType: string
  readonly providerKind?: string
  readonly providerInstanceId?: string
  readonly turnId?: string
}

interface BufferedAssistantTranscript {
  assistantTextBoundaryPending?: boolean
  /** Already-journaled snapshots must finish recovery even with auto-save off. */
  recoverySnapshot?: boolean
  readonly threadId: string
  readonly turnId: string
  readonly createdAt: string
  projectionSequence: number
  lastAppliedProjectionSequence: number
  persistedProjectionSequence: number
  content: string
  contentBytes: number
  reasoning: string
  reasoningBytes: number
  toolCalls: BufferedTranscriptToolCall[]
  toolCallsBytes: number
  providerKind?: string
  providerInstanceId?: string
  status?: string
  truncated?: boolean
  terminal?: boolean
  retryAttempts: number
  bytesSincePersist: number
  flushTimer?: ReturnType<typeof setTimeout>
}

interface BufferedTranscriptToolCall {
  id: string
  name: string
  /** Latest provider title; ACP providers change it per event. */
  title?: string
  /** The provider's own classification of the call (ACP `kind`). */
  kind?: string
  input: unknown
  output?: unknown
  state: "input-available" | "output-available" | "output-error"
  providerKind?: string
  providerInstanceId?: string
  turnId?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  error?: string
}

function assistantTranscriptBytes(
  transcript: BufferedAssistantTranscript
): number {
  return (
    transcript.contentBytes +
    transcript.reasoningBytes +
    transcript.toolCallsBytes
  )
}

type ProviderRuntimeLogLevel = "info" | "warn" | "error"

interface ProviderRuntimeLogRecord {
  readonly level: ProviderRuntimeLogLevel
  readonly message: string
  readonly bindings: Record<string, unknown>
}

export class ProviderRuntimeIngestion {
  private sequence: number
  private unsubscribe: (() => void) | null = null
  private readonly bufferedProposedPlans = new Map<
    string,
    BufferedProposedPlan
  >()
  private readonly loggedReasoningStarts = new Set<string>()
  private readonly bufferedAssistantTranscripts = new Map<
    string,
    BufferedAssistantTranscript
  >()
  private readonly evictedAssistantTranscriptKeys = new Set<string>()
  private readonly evictedAssistantTurnByThread = new Map<string, string>()
  private readonly activeTurnByThread = new Map<string, string>()
  private readonly assistantTranscriptMaxBytes: number
  private readonly bufferedAssistantTranscriptsMaxBytes: number
  private readonly assistantTranscriptRetryBaseMs: number
  private readonly assistantTranscriptRetryMaxMs: number
  private readonly assistantTranscriptRetryMaxAttempts: number
  private readonly assistantTranscriptFlushBytes: number
  private readonly evictedAssistantTranscriptMaxKeys: number
  private readonly proposedPlanMaxBytes: number
  private readonly bufferedProposedPlansMaxBytes: number
  private readonly journalRetryBaseMs: number
  private readonly journalRetryMaxMs: number
  private readonly journalQueueMaxEvents: number
  private readonly journalQueueMaxBytes: number
  private bufferedAssistantTranscriptBytes = 0
  private bufferedProposedPlanBytes = 0
  private journalQueueBytes = 0
  private journalRetryDelayMs: number
  private journalRetryTimer: ReturnType<typeof setTimeout> | null = null
  private drainingJournalQueue = false
  private readonly journalQueue: QueuedProviderRuntimeEvent[] = []
  private stopped = false
  private journalIntakeStopped = false
  /**
   * Threads currently inside a degraded-projection block. The in-thread
   * `projection_degraded` notice is emitted once per thread per block — every
   * event used to add one, which buried the transcript under warnings while
   * the backend drained — and an event of that thread projecting end to end
   * (journal, projections, receipt) ends its block.
   */
  private readonly projectionDegradedThreads = new Set<string>()
  /** Event types the bridge declined at least once; see `noteDeclinedEntry`. */
  private readonly declinedEntryTypes = new Set<string>()

  constructor(private readonly options: ProviderRuntimeIngestionOptions) {
    this.sequence = options.sequenceStart ?? Date.now() * 1000
    this.assistantTranscriptMaxBytes = positiveInteger(
      options.assistantTranscriptMaxBytes,
      DEFAULT_ASSISTANT_TRANSCRIPT_MAX_BYTES
    )
    this.bufferedAssistantTranscriptsMaxBytes = positiveInteger(
      options.bufferedAssistantTranscriptsMaxBytes,
      DEFAULT_BUFFERED_ASSISTANT_TRANSCRIPTS_MAX_BYTES
    )
    this.assistantTranscriptRetryBaseMs = positiveInteger(
      options.assistantTranscriptRetryBaseMs,
      DEFAULT_ASSISTANT_TRANSCRIPT_RETRY_BASE_MS
    )
    this.assistantTranscriptRetryMaxMs = Math.max(
      this.assistantTranscriptRetryBaseMs,
      positiveInteger(
        options.assistantTranscriptRetryMaxMs,
        DEFAULT_ASSISTANT_TRANSCRIPT_RETRY_MAX_MS
      )
    )
    this.assistantTranscriptRetryMaxAttempts = positiveInteger(
      options.assistantTranscriptRetryMaxAttempts,
      DEFAULT_ASSISTANT_TRANSCRIPT_RETRY_MAX_ATTEMPTS
    )
    this.assistantTranscriptFlushBytes = positiveInteger(
      options.assistantTranscriptFlushBytes,
      DEFAULT_ASSISTANT_TRANSCRIPT_FLUSH_BYTES
    )
    this.evictedAssistantTranscriptMaxKeys = positiveInteger(
      options.evictedAssistantTranscriptMaxKeys,
      DEFAULT_EVICTED_ASSISTANT_TRANSCRIPT_MAX_KEYS
    )
    this.proposedPlanMaxBytes = positiveInteger(
      options.proposedPlanMaxBytes,
      DEFAULT_PROPOSED_PLAN_MAX_BYTES
    )
    this.bufferedProposedPlansMaxBytes = positiveInteger(
      options.bufferedProposedPlansMaxBytes,
      DEFAULT_BUFFERED_PROPOSED_PLANS_MAX_BYTES
    )
    this.journalRetryBaseMs = positiveInteger(
      options.journalRetryBaseMs,
      DEFAULT_JOURNAL_RETRY_BASE_MS
    )
    this.journalRetryMaxMs = Math.max(
      this.journalRetryBaseMs,
      positiveInteger(options.journalRetryMaxMs, DEFAULT_JOURNAL_RETRY_MAX_MS)
    )
    this.journalQueueMaxEvents = positiveInteger(
      options.journalQueueMaxEvents,
      DEFAULT_JOURNAL_QUEUE_MAX_EVENTS
    )
    this.journalQueueMaxBytes = positiveInteger(
      options.journalQueueMaxBytes,
      DEFAULT_JOURNAL_QUEUE_MAX_BYTES
    )
    this.journalRetryDelayMs = this.journalRetryBaseMs
  }

  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    this.stopped = false
    if (this.journalQueue.length > 0) this.scheduleJournalQueueRetry()
    const listener = (event: ProviderRuntimeEvent) => this.ingest(event)
    const canonicalListener = (event: CanonicalProviderRuntimeEvent) =>
      this.ingestCanonical(event)
    this.options.eventBus.on("event", listener)
    this.options.eventBus.on("canonical", canonicalListener)
    this.unsubscribe = () => {
      this.options.eventBus.off("event", listener)
      this.options.eventBus.off("canonical", canonicalListener)
      this.unsubscribe = null
    }
    return this.unsubscribe
  }

  stop(): void {
    this.unsubscribe?.()
    if (this.journalRetryTimer) {
      clearTimeout(this.journalRetryTimer)
      this.journalRetryTimer = null
    }
    if (this.journalQueue.length > 0) this.drainJournalQueue()
    if (this.journalRetryTimer) {
      clearTimeout(this.journalRetryTimer)
      this.journalRetryTimer = null
    }

    let journalRecoveryError: Error | null = null
    while (this.journalQueue.length > 0) {
      const queued = this.journalQueue[0]
      if (!queued) break
      const projectionSequence = this.sequence + 1
      if (
        !this.options.journalRecoveryStore?.enqueue(queued.entry, {
          projectionSequence,
        })
      ) {
        journalRecoveryError = new Error(
          `Could not spool ${this.journalQueue.length} provider runtime journal event(s) during shutdown.`
        )
        this.blockProjectionAfterFailure(
          journalRecoveryError,
          failureSourceOfEntry(queued.entry),
          journalEntryMeta(queued.entry),
          "provider runtime journal shutdown spool failed"
        )
        break
      }
      this.sequence = projectionSequence
      this.journalQueue.shift()
      this.journalQueueBytes = Math.max(
        0,
        this.journalQueueBytes - queued.bytes
      )
    }

    this.stopped = true
    for (const key of this.bufferedAssistantTranscripts.keys()) {
      const transcript = this.bufferedAssistantTranscripts.get(key)
      if (!transcript) continue
      if (!this.flushAssistantTranscript(key, true)) {
        if (!this.spoolAssistantTranscript(key, transcript, "shutdown")) {
          this.dropBufferedAssistantTranscript(key, transcript)
          this.markAssistantTranscriptEvicted(key, transcript)
          this.reportFatalTranscriptDurabilityFailure(
            transcript,
            "shutdown persistence and recovery spool failure"
          )
        }
      }
    }
    this.evictedAssistantTranscriptKeys.clear()
    this.evictedAssistantTurnByThread.clear()
    if (journalRecoveryError) throw journalRecoveryError
  }

  /** Legacy-shaped intake: the frozen in-process stack and the reactor. */
  ingest(event: ProviderRuntimeEvent): void {
    this.ingestEntry(legacyJournalEntry(event))
  }

  /** Canonical intake: what the provider hub emits. Journaled before bridging. */
  ingestCanonical(event: CanonicalProviderRuntimeEvent): void {
    this.ingestEntry(canonicalJournalEntry(event))
  }

  private ingestEntry(entry: ProviderRuntimeJournalEntry): void {
    try {
      this.ingestEvent(entry)
    } catch (err) {
      // A surfaced bridge failure was already logged with its context and
      // shown in the thread; logging it again here would only double it.
      if (!(err instanceof ProviderRuntimeBridgeError)) {
        this.options.logger.error(
          { err, ...journalEntryMeta(entry) },
          "failed to ingest provider runtime event"
        )
      }
      // A terminal event whose ingestion failed must not settle the turn as
      // if it had been recorded. The hub catches this around its emit and
      // marks the turn uncertain; swallowing it here hid that from the hub.
      if (isTerminalJournalEntry(entry)) throw err
    }
  }

  replayPersisted(
    entry: ProviderRuntimeJournalEntry,
    input: {
      readonly projectionSequence: number
      readonly truncation?: JournalTruncationRecord | null
    }
  ): void {
    const projected = this.processEvent(entry, {
      skipJournal: true,
      skipBroadcast: true,
      strictProjection: true,
      projectionSequence: input.projectionSequence,
      forcePersistConversations: true,
      truncation: input.truncation ?? null,
    })
    if (!projected) {
      throw new Error(
        `Provider runtime event '${journalEntryEventType(entry)}' for thread '${journalEntryThreadId(entry)}' could not be replayed.`
      )
    }
  }

  private ingestEvent(entry: ProviderRuntimeJournalEntry): void {
    if (this.journalIntakeStopped) {
      this.options.logger.error(
        journalEntryMeta(entry),
        "provider runtime event rejected after journal intake stopped"
      )
      return
    }
    // A degraded projection does not short-circuit here: the next event goes
    // through the normal journal-then-project lane. Events journaled while
    // degraded carry no receipt and are replayed at startup.
    if (this.journalQueue.length > 0 || this.drainingJournalQueue) {
      const accepted = this.enqueueJournalBlockedEvent(entry)
      if (accepted || this.journalQueue.length > 0) {
        this.scheduleJournalQueueRetry()
      }
      return
    }
    if (!this.processEvent(entry)) {
      const accepted = this.enqueueJournalBlockedEvent(entry)
      if (accepted || this.journalQueue.length > 0) {
        this.scheduleJournalQueueRetry()
      }
    }
  }

  /**
   * The legacy view of an entry through the configured bridge. Pure and
   * cheap; called before the journal only for the read-only dispatch lookup
   * and again after it for projection. A bridge that throws is reported as
   * a failed view (`error`) so the caller can decide what that costs.
   */
  private legacyViewOfEntry(
    entry: ProviderRuntimeJournalEntry
  ): { readonly view: ProviderRuntimeEvent | null; readonly error: unknown } {
    try {
      return { view: legacyViewOf(entry, this.options.legacyView), error: null }
    } catch (error) {
      return { view: null, error }
    }
  }

  private processEvent(
    entry: ProviderRuntimeJournalEntry,
    options: ProcessProviderRuntimeEventOptions = {}
  ): boolean {
    const eventMeta = journalEntryMeta(entry)
    const sequence = options.projectionSequence ?? this.sequence + 1
    // A read-only lookup before the journal: is this the terminal event of a
    // dispatch the outbox still holds? It decides whether the event is
    // journaled even when conversation auto-save is off. It reads the
    // pre-journal legacy view; a bridge that throws here only loses that
    // hint (the event is then journaled iff auto-save is on) — nothing
    // durable depends on the bridge before the journal.
    const preview = this.legacyViewOfEntry(entry)
    const terminalDispatch = preview.view
      ? providerDispatchTerminalProjection(preview.view)
      : null
    let durableDispatchTerminal = false
    if (terminalDispatch && this.options.chatDispatchLifecycleStore) {
      try {
        durableDispatchTerminal = this.options.chatDispatchLifecycleStore.hasProviderTurn(
          eventMeta.thread,
          terminalDispatch.providerInstanceId,
          terminalDispatch.providerTurnId
        )
      } catch (error) {
        // A lifecycle lookup failure must not bypass the journal. Assume the
        // event is durable so replay can converge after storage recovers.
        durableDispatchTerminal = true
        this.options.logger.warn(
          { err: error, ...eventMeta },
          "failed to inspect chat dispatch lifecycle before journaling terminal event"
        )
      }
    }
    const persistConversations =
      options.forcePersistConversations ??
      (this.shouldPersistConversations() || durableDispatchTerminal)
    let journalSequence: number | undefined
    let journaled = entry
    let truncation: JournalTruncationRecord | null = options.truncation ?? null
    if (
      !options.skipJournal &&
      persistConversations &&
      shouldJournalEntry(entry, this.options.transcriptStore !== undefined)
    ) {
      const persisted = this.persistJournalBeforeProjection(
        entry,
        eventMeta,
        sequence
      )
      if (persisted === null) {
        return false
      }
      if (persisted === "fatal") {
        return true
      }
      if (persisted !== undefined) {
        journalSequence = persisted.sequence
        journaled = persisted.entry
        truncation = persisted.truncation
      }
    }
    this.sequence = Math.max(this.sequence, sequence)

    // The bridge runs here, behind the journal. Journal-first means project
    // what was journaled: `event` is the legacy view of the journaled entry
    // (bounded, raw-less), decorated with the same truncation markers a
    // bounded legacy row carries, so live projection, broadcast and startup
    // replay all show the same thing.
    const bridged =
      journaled.event === entry.event && preview.error === null
        ? preview
        : this.legacyViewOfEntry(journaled)
    if (bridged.error !== null) {
      // The row is durable and unreceipted: the startup replayer will run
      // the (fixed) bridge over it, up to its attempt budget. Nothing is
      // projected or broadcast now. This is a translation bug, not a
      // persistence failure, so it does not go through
      // `blockProjectionAfterFailure`: that lane taints and drains the
      // backend, which would turn one bridge bug into a lost session. It is
      // logged, surfaced once per thread in the transcript, and — for a
      // terminal entry only — rethrown so the hub settles the turn as failed
      // instead of recorded.
      const error =
        bridged.error instanceof Error
          ? bridged.error
          : new Error(String(bridged.error))
      if (options.strictProjection === true) throw error
      this.options.logger.error(
        { err: error, ...eventMeta },
        "legacy bridge failed after journaling; row left unreceipted for startup replay"
      )
      this.emitProjectionDegradedNotice(
        failureSourceOfEntry(journaled),
        error,
        "projection"
      )
      if (isTerminalJournalEntry(journaled)) {
        throw new ProviderRuntimeBridgeError(error, eventMeta.event_type)
      }
      return true
    }
    if (bridged.view === null) {
      // The bridge declined the event: it has no legacy twin, so there is
      // nothing to project or broadcast — but the canonical row is durable
      // now, where it used to be dropped before the journal. Receipted so
      // replay does not re-offer it; a future bridge can re-project it.
      this.noteDeclinedEntry(journaled, eventMeta)
      if (journalSequence !== undefined) {
        if (!this.markProjectionReceipt(journalSequence, failureSourceOfEntry(journaled), eventMeta)) {
          return true
        }
        this.projectionDegradedThreads.delete(eventMeta.thread)
      }
      return true
    }
    let event = bridged.view
    if (journaled.shape === "canonical" && truncation) {
      event = decorateLegacyViewWithTruncation(event, truncation)
    }
    let projectionsSucceeded = true
    let bufferedPlanCompletion: BufferedProposedPlanCompletion = {
      activity: null,
      suppressDefaultActivity: false,
    }
    if (persistConversations) {
      try {
        bufferedPlanCompletion = this.consumeBufferedProposedPlanCompletion(
          event,
          sequence
        )
      } catch (err) {
        this.options.logger.warn(
          { err, ...eventMeta },
          "failed to restore proposed-plan projection state"
        )
        if (options.strictProjection === true) throw err
        projectionsSucceeded = false
      }
    }
    let activity: ThreadActivityProjection | null = null

    if (!persistConversations) {
      this.discardConversationBuffers(event.thread_id)
    } else if (bufferedPlanCompletion.activity) {
      activity = bufferedPlanCompletion.activity
    } else if (!bufferedPlanCompletion.suppressDefaultActivity) {
      try {
        activity = projectProviderEventToThreadActivity(event, sequence)
      } catch (err) {
        projectionsSucceeded = false
        this.options.logger.warn(
          { err, ...eventMeta },
          "failed to project provider thread activity"
        )
      }
    }

    if (activity) {
      projectionsSucceeded =
        this.persistThreadActivity(activity, !options.skipBroadcast) &&
        projectionsSucceeded
    }

    if (
      persistConversations &&
      !bufferedPlanCompletion.suppressDefaultActivity
    ) {
      try {
        this.ingestProposedPlanBuffer(event, sequence, !options.skipBroadcast)
      } catch (err) {
        this.options.logger.warn(
          { err, ...eventMeta },
          "failed to update proposed-plan projection state"
        )
        if (options.strictProjection === true) throw err
        projectionsSucceeded = false
      }
    }
    if (persistConversations) {
      this.clearBufferedProposedPlansForSessionExit(event)
    }

    if (this.options.checkpointDiffStore) {
      try {
        this.options.checkpointDiffStore.recordRuntimeEvent(event)
      } catch (err) {
        projectionsSucceeded = false
        this.options.logger.warn(
          { err, ...eventMeta },
          "failed to persist provider checkpoint diff"
        )
      }
    }

    if (persistConversations) {
      projectionsSucceeded =
        this.ingestThreadMetadata(event, options.strictProjection === true) &&
        projectionsSucceeded
    }
    projectionsSucceeded =
      this.ingestSourceProposedPlanImplementation(
        event,
        options.strictProjection === true,
        !options.skipBroadcast
      ) && projectionsSucceeded
    projectionsSucceeded =
      this.ingestSessionLifecycle(event, options.strictProjection === true) &&
      projectionsSucceeded
    projectionsSucceeded =
      this.ingestChatDispatchLifecycle(
        event,
        options.strictProjection === true
      ) && projectionsSucceeded
    if (persistConversations) {
      try {
        projectionsSucceeded =
          this.ingestAssistantTranscript(
            event,
            journalSequence !== undefined || options.strictProjection === true,
            sequence,
            options.forcePersistConversations === true
          ) && projectionsSucceeded
      } catch (err) {
        this.options.logger.warn(
          { err, ...eventMeta },
          "failed to hydrate or persist provider assistant transcript"
        )
        if (options.strictProjection === true) throw err
        projectionsSucceeded = false
      }
    }

    if (journalSequence !== undefined) {
      if (!projectionsSucceeded) {
        this.blockProjectionAfterFailure(
          new Error(
            `Provider runtime projections failed for journal event ${journalSequence}.`
          ),
          failureSourceOfLegacy(event),
          eventMeta,
          "provider runtime projection failed; blocking later projections"
        )
        return true
      }
      if (
        !this.markProjectionReceipt(
          journalSequence,
          failureSourceOfLegacy(event),
          eventMeta
        )
      ) {
        return true
      }
      // Journaled, projected and receipted end to end: this thread's
      // degraded block (if any) is over, and the next failure gets its own
      // single notice.
      this.projectionDegradedThreads.delete(event.thread_id)
    }

    // The post-journal lane (checkpoint reactor). Live events only: a
    // startup replay is silent, exactly as it never reached the bus before.
    if (!options.skipBroadcast && this.options.projectedSink) {
      try {
        this.options.projectedSink(event)
      } catch (err) {
        this.options.logger.error(
          { err, ...eventMeta },
          "post-journal provider event listener failed"
        )
      }
    }

    if (!options.skipBroadcast) {
      try {
        const clients = this.options.broadcaster.clientCount()
        // The broadcast log describes the frame on the wire, so it names the
        // legacy event type (`turn_error`), not the journaled canonical one.
        const wireMeta = providerEventMeta(event)
        if (
          this.options.traceProviderEvents ??
          getBackendLoggingSettings().traceProviderEvents
        ) {
          const payloadKeys = event.payload
            ? Object.keys(event.payload).join(",")
            : "-"
          console.log(
            `[REASON-TRACE:HUB-BROADCAST] type=${wireMeta.event_type ?? "-"} thread=${wireMeta.thread ?? "-"} clients=${clients} payloadKeys=${payloadKeys}`
          )
        }
        this.logProviderRuntimeEvent(event, wireMeta, clients)
        this.options.broadcaster.broadcast({
          channel: "provider.runtimeEvent",
          data: event,
        })
      } catch (err) {
        this.options.logger.error(
          { err, channel: "provider.runtimeEvent", ...eventMeta },
          "broadcast failed; dropping provider event"
        )
      }
    }
    return options.strictProjection ? projectionsSucceeded : true
  }

  private ingestChatDispatchLifecycle(
    event: ProviderRuntimeEvent,
    strictProjection: boolean
  ): boolean {
    const store = this.options.chatDispatchLifecycleStore
    if (!store) return true
    const terminal = providerDispatchTerminalProjection(event)
    if (!terminal) return true
    try {
      if (terminal.status === "completed") {
        store.markCompletedByProviderTurn(
          event.thread_id,
          terminal.providerInstanceId,
          terminal.providerTurnId
        )
      } else {
        store.markFailedByProviderTurn(
          event.thread_id,
          terminal.providerInstanceId,
          terminal.providerTurnId,
          terminal.error
        )
      }
      return true
    } catch (error) {
      this.options.logger.warn(
        { err: error, ...providerEventMeta(event) },
        "failed to project chat dispatch terminal lifecycle"
      )
      if (strictProjection) throw error
      return false
    }
  }

  private persistJournalBeforeProjection(
    entry: ProviderRuntimeJournalEntry,
    eventMeta: ReturnType<typeof journalEntryMeta>,
    sequence: number
  ): JournalPersistResult {
    if (!this.options.eventJournal) return undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= JOURNAL_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        const persisted = this.options.eventJournal.persist(entry, sequence)
        // Canonical rows count under their dotted type (`turn.completed`),
        // legacy rows under the legacy name (`turn_completed`).
        backendMetrics.incrementCounter(PROVIDER_JOURNAL_EVENTS_TOTAL, {
          eventType: eventMeta.event_type,
        })
        // No "projections resume" log here: an append succeeding says nothing
        // about the projection lane, and the backend that reaches this path
        // after a failure is tainted and draining.
        if (typeof persisted === "number") {
          return { sequence: persisted, entry, truncation: null }
        }
        if (
          persisted &&
          typeof persisted === "object" &&
          Number.isSafeInteger(persisted.sequence)
        ) {
          return {
            sequence: persisted.sequence,
            entry: persisted.entry,
            truncation: persisted.truncation ?? null,
          }
        }
        return undefined
      } catch (error) {
        if (error instanceof ProviderRuntimeJournalSerializationError) {
          this.blockProjectionAfterFailure(
            error,
            failureSourceOfEntry(entry),
            eventMeta,
            "provider runtime event is not journal-serializable; blocking later projections"
          )
          return "fatal"
        }
        lastError = error
        if (isSqliteContention(error)) return null
        if (attempt < JOURNAL_PERSIST_ATTEMPTS) {
          this.options.logger.warn(
            { err: error, attempt, ...eventMeta },
            "provider runtime journal persist failed; retrying before projection"
          )
        }
      }
    }
    this.options.logger.error(
      { err: lastError, attempts: JOURNAL_PERSIST_ATTEMPTS, ...eventMeta },
      "provider runtime journal persist failed; event queued before projection"
    )
    return null
  }

  private markProjectionReceipt(
    journalSequence: number,
    source: ProviderRuntimeFailureSource,
    eventMeta: ReturnType<typeof journalEntryMeta>
  ): boolean {
    const receipts = this.options.projectionReceipts
    if (!receipts) return true
    let lastError: unknown
    for (let attempt = 1; attempt <= PROJECTION_RECEIPT_ATTEMPTS; attempt += 1) {
      try {
        receipts.markProjected(journalSequence)
        return true
      } catch (error) {
        lastError = error
        if (attempt < PROJECTION_RECEIPT_ATTEMPTS) {
          this.options.logger.warn(
            { err: error, attempt, journalSequence, ...eventMeta },
            "provider runtime projection receipt failed; retrying"
          )
        }
      }
    }

    const error =
      lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? "unknown projection receipt failure"))
    this.options.logger.error(
      {
        err: error,
        attempts: PROJECTION_RECEIPT_ATTEMPTS,
        journalSequence,
        ...eventMeta,
      },
      "provider runtime projection receipt failed; blocking later projections"
    )
    try {
      this.options.onFatalProjectionFailure?.(error, {
        threadId: source.threadId,
        eventType: source.eventType,
      })
    } catch (callbackError) {
      this.options.logger.error(
        { err: callbackError, ...eventMeta },
        "fatal provider projection callback failed"
      )
    }
    this.emitProjectionDegradedNotice(source, error, "projection_receipt")
    return false
  }

  private blockProjectionAfterFailure(
    error: Error,
    source: ProviderRuntimeFailureSource,
    eventMeta: ReturnType<typeof journalEntryMeta> & Record<string, unknown>,
    message: string
  ): void {
    this.options.logger.error({ err: error, ...eventMeta }, message)
    try {
      this.options.onFatalProjectionFailure?.(error, {
        threadId: source.threadId,
        eventType: source.eventType,
      })
    } catch (callbackError) {
      this.options.logger.error(
        { err: callbackError, ...eventMeta },
        "fatal provider projection callback failed"
      )
    }
    this.emitProjectionDegradedNotice(source, error, "projection")
  }

  /**
   * A journaled entry the bridge has no legacy twin for. Logged once per
   * type: the volume is tiny (non-tool `item.started`, `tool_user_input`
   * requests) and the log is the only place the drop is visible.
   */
  private noteDeclinedEntry(
    entry: ProviderRuntimeJournalEntry,
    eventMeta: ReturnType<typeof journalEntryMeta>
  ): void {
    const eventType = journalEntryEventType(entry)
    if (this.declinedEntryTypes.has(eventType)) return
    this.declinedEntryTypes.add(eventType)
    this.options.logger.info(
      eventMeta,
      "provider runtime event journaled without a legacy projection (bridge declined); further events of this type are not logged"
    )
  }

  /**
   * Makes a degraded projection visible in the thread instead of only in the
   * backend log. Uses the existing `runtime.warning` activity kind so no
   * client needs a new case; the notice itself is not journaled (it describes
   * the journal lane) and goes out on both the activity and raw event
   * channels so the renderer's twin projection can pick it up either way.
   * One notice per thread per degraded block; the block ends when an event of
   * that thread again projects end to end.
   */
  private emitProjectionDegradedNotice(
    source: ProviderRuntimeFailureSource,
    error: Error,
    reason: "projection" | "projection_receipt" | "journal_after_projection"
  ): void {
    if (this.projectionDegradedThreads.has(source.threadId)) return
    this.projectionDegradedThreads.add(source.threadId)
    const sequence = this.sequence + 1
    this.sequence = sequence
    const notice: ProviderRuntimeEvent = {
      event_type: "runtime.warning",
      thread_id: source.threadId,
      payload: {
        ...(source.providerKind ? { providerKind: source.providerKind } : {}),
        ...(source.providerInstanceId
          ? { providerInstanceId: source.providerInstanceId }
          : {}),
        ...(source.turnId ? { turn_id: source.turnId } : {}),
        event_id: `projection-degraded:${source.threadId}:${sequence}`,
        class: "projection_degraded",
        reason,
        source_event_type: source.eventType,
        message:
          "Part of this turn could not be recorded live. The journaled copy will be recovered on the next restart.",
        error: error.message,
      },
    }
    try {
      const activity = projectProviderEventToThreadActivity(notice, sequence)
      if (activity) this.persistThreadActivity(activity, true)
      this.options.broadcaster.broadcast({
        channel: "provider.runtimeEvent",
        data: notice,
      })
    } catch (err) {
      this.options.logger.error(
        { err, event_type: source.eventType, thread: source.threadId },
        "failed to publish provider projection degradation notice"
      )
    }
  }

  private enqueueJournalBlockedEvent(entry: ProviderRuntimeJournalEntry): boolean {
    const bytes = journalEntryBytes(entry, DEFAULT_JOURNAL_QUEUE_MAX_BYTES)
    const queueAtCapacity =
      this.journalQueue.length >= this.journalQueueMaxEvents ||
      this.journalQueueBytes + bytes > this.journalQueueMaxBytes
    this.journalQueue.push({ entry, bytes })
    this.journalQueueBytes += bytes
    if (!queueAtCapacity) return true

    this.journalIntakeStopped = true
    this.unsubscribe?.()
    if (this.journalRetryTimer) {
      clearTimeout(this.journalRetryTimer)
      this.journalRetryTimer = null
    }

    let spooled = true
    while (this.journalQueue.length > 0) {
      const queued = this.journalQueue[0]
      if (!queued) break
      const projectionSequence = this.sequence + 1
      if (
        !this.options.journalRecoveryStore?.enqueue(queued.entry, {
          projectionSequence,
        })
      ) {
        spooled = false
        break
      }
      this.sequence = projectionSequence
      this.journalQueue.shift()
      this.journalQueueBytes = Math.max(
        0,
        this.journalQueueBytes - queued.bytes
      )
    }

    const error = new Error(
      spooled
        ? "Provider runtime journal retry queue reached its safety limit; accepted events were transferred to the recovery spool and runtime intake was stopped."
        : "Provider runtime journal retry queue reached its safety limit and could not transfer every accepted event to the recovery spool."
    )
    this.blockProjectionAfterFailure(
      error,
      failureSourceOfEntry(entry),
      {
        ...journalEntryMeta(entry),
        queuedEvents: this.journalQueue.length,
        queuedBytes: this.journalQueueBytes,
        maxEvents: this.journalQueueMaxEvents,
        maxBytes: this.journalQueueMaxBytes,
      },
      "provider runtime journal retry queue overflowed; stopping intake"
    )
    return spooled
  }

  private scheduleJournalQueueRetry(): void {
    if (
      this.stopped ||
      this.journalRetryTimer ||
      this.journalQueue.length === 0
    ) {
      return
    }
    const delayMs = this.journalRetryDelayMs
    this.journalRetryTimer = setTimeout(() => {
      this.journalRetryTimer = null
      this.drainJournalQueue()
    }, delayMs)
    this.journalRetryTimer.unref?.()
  }

  private drainJournalQueue(): void {
    if (this.stopped || this.drainingJournalQueue) return
    this.drainingJournalQueue = true
    let blocked = false
    try {
      while (this.journalQueue.length > 0) {
        const queued = this.journalQueue[0]
        if (!queued) break
        let processed = false
        try {
          processed = this.processEvent(queued.entry)
        } catch (err) {
          // The journal append already succeeded if projection throws, so the
          // same stream version must not be appended again. The row has no
          // receipt, which is exactly what the startup replayer selects — a
          // "discarded" receipt would remove it from replay. Consume the
          // queue entry, but escalate rather than pretend it projected.
          // A bridge failure is the exception: `processEvent` has logged and
          // surfaced it, the hub's emit returned long ago (the entry sat in
          // the queue), and a translation bug is not grounds to drain the
          // backend — the row simply waits for replay.
          if (!(err instanceof ProviderRuntimeBridgeError)) {
            this.blockProjectionAfterFailure(
              err instanceof Error ? err : new Error(String(err)),
              failureSourceOfEntry(queued.entry),
              journalEntryMeta(queued.entry),
              "failed to project queued provider runtime event after journaling; row left unreceipted for startup replay"
            )
          }
          processed = true
        }
        if (!processed) {
          blocked = true
          break
        }
        this.journalQueue.shift()
        this.journalQueueBytes = Math.max(
          0,
          this.journalQueueBytes - queued.bytes
        )
      }
    } finally {
      this.drainingJournalQueue = false
    }
    if (blocked) {
      this.journalRetryDelayMs = Math.min(
        this.journalRetryMaxMs,
        this.journalRetryDelayMs * 2
      )
      this.scheduleJournalQueueRetry()
    } else {
      this.journalRetryDelayMs = this.journalRetryBaseMs
      if (this.journalQueue.length > 0) this.scheduleJournalQueueRetry()
    }
  }

  private ingestAssistantTranscript(
    event: ProviderRuntimeEvent,
    flushImmediately = false,
    projectionSequence = this.sequence,
    recoverySnapshot = false
  ): boolean {
    if (!this.options.transcriptStore) return true

    const payload = asRecord(event.payload)
    const payloadTurnId = readString(payload, "turn_id", "turnId")
    if (
      (event.event_type === "turn_started" ||
        event.event_type === "turn.started") &&
      payloadTurnId
    ) {
      this.activeTurnByThread.set(event.thread_id, payloadTurnId)
      return true
    }

    const turnId = payloadTurnId ?? this.activeTurnByThread.get(event.thread_id)
    if (
      event.event_type === "session.exited" ||
      event.event_type === "session_exited"
    ) {
      const persisted = this.flushAssistantTranscriptsForThread(event.thread_id)
      this.activeTurnByThread.delete(event.thread_id)
      this.evictedAssistantTurnByThread.delete(event.thread_id)
      return persisted
    }
    if (!turnId) return true
    const key = assistantTranscriptKey(event.thread_id, turnId)

    if (isAssistantContentEvent(event.event_type, payload)) {
      if (this.isAssistantTranscriptEvicted(key, event.thread_id, turnId)) return true
      const text = providerTranscriptText(event.event_type, payload)
      if (text === undefined) return true
      const transcript = this.assistantTranscript(
        event,
        payload,
        turnId,
        recoverySnapshot
      )
      if (projectionSequence <= transcript.lastAppliedProjectionSequence) {
        return this.flushPreviouslyAppliedAssistantTranscript(
          key,
          transcript,
          flushImmediately
        )
      }
      this.updateAssistantTranscriptText(
        transcript,
        "content",
        !isReplaceEvent(event.event_type) &&
          text && transcript.assistantTextBoundaryPending && transcript.content
          ? `${assistantParagraphSeparator(transcript.content, text)}${text}`
          : text,
        isReplaceEvent(event.event_type)
      )
      if (text || isReplaceEvent(event.event_type)) {
        transcript.assistantTextBoundaryPending = false
      }
      this.markAssistantTranscriptEventApplied(transcript, projectionSequence)
      if (
        flushImmediately ||
        transcript.bytesSincePersist >=
          this.assistantTranscriptFlushThreshold(transcript)
      ) {
        return this.flushAssistantTranscript(key, false)
      }
      this.scheduleAssistantTranscriptFlush(transcript)
      this.trimBufferedAssistantTranscripts()
      return true
    }

    if (isReasoningContentEvent(event.event_type)) {
      if (this.isAssistantTranscriptEvicted(key, event.thread_id, turnId)) return true
      const text = providerTranscriptText(event.event_type, payload)
      if (text === undefined) return true
      const transcript = this.assistantTranscript(
        event,
        payload,
        turnId,
        recoverySnapshot
      )
      if (projectionSequence <= transcript.lastAppliedProjectionSequence) {
        return this.flushPreviouslyAppliedAssistantTranscript(
          key,
          transcript,
          flushImmediately
        )
      }
      this.updateAssistantTranscriptText(
        transcript,
        "reasoning",
        text,
        isReplaceEvent(event.event_type)
      )
      this.markAssistantTranscriptEventApplied(transcript, projectionSequence)
      if (
        flushImmediately ||
        transcript.bytesSincePersist >=
          this.assistantTranscriptFlushThreshold(transcript)
      ) {
        return this.flushAssistantTranscript(key, false)
      }
      this.scheduleAssistantTranscriptFlush(transcript)
      this.trimBufferedAssistantTranscripts()
      return true
    }

    if (transcriptToolPhase(event.event_type, payload)) {
      if (this.isAssistantTranscriptEvicted(key, event.thread_id, turnId)) return true
      const transcript = this.assistantTranscript(
        event,
        payload,
        turnId,
        recoverySnapshot
      )
      if (projectionSequence <= transcript.lastAppliedProjectionSequence) {
        return this.flushPreviouslyAppliedAssistantTranscript(
          key,
          transcript,
          flushImmediately
        )
      }
      this.updateAssistantTranscriptTool(transcript, event.event_type, payload)
      transcript.assistantTextBoundaryPending = true
      this.markAssistantTranscriptEventApplied(transcript, projectionSequence)
      if (flushImmediately) {
        return this.flushAssistantTranscript(key, false)
      }
      this.scheduleAssistantTranscriptFlush(transcript)
      this.trimBufferedAssistantTranscripts()
      return true
    }

    // A turn has one durable message, but can contain several assistant items.
    // Persist the boundary with the same projection receipt so recovery neither
    // glues paragraphs together nor inserts separators between token chunks.
    if (isAssistantMessageBoundary(event.event_type, payload)) {
      if (this.isAssistantTranscriptEvicted(key, event.thread_id, turnId)) return true
      const transcript = this.assistantTranscript(event, payload, turnId, recoverySnapshot)
      if (projectionSequence <= transcript.lastAppliedProjectionSequence) {
        return this.flushPreviouslyAppliedAssistantTranscript(
          key, transcript, flushImmediately
        )
      }
      transcript.assistantTextBoundaryPending = true
      this.markAssistantTranscriptEventApplied(transcript, projectionSequence)
      if (flushImmediately) return this.flushAssistantTranscript(key, false)
      this.scheduleAssistantTranscriptFlush(transcript)
      this.trimBufferedAssistantTranscripts()
      return true
    }

    if (!isTerminalJournalEventType(event.event_type)) return true
    const transcript = this.assistantTranscript(event, payload, turnId, recoverySnapshot)
    let persisted = true
    if (transcript) {
      if (projectionSequence > transcript.lastAppliedProjectionSequence) {
        transcript.status =
          readString(payload, "status", "state") ??
          terminalTurnStatus(event.event_type)
        transcript.terminal = true
        this.markAssistantTranscriptEventApplied(transcript, projectionSequence)
      }
      persisted = this.flushAssistantTranscript(key, true)
    }
    this.evictedAssistantTranscriptKeys.delete(key)
    if (this.evictedAssistantTurnByThread.get(event.thread_id) === turnId) {
      this.evictedAssistantTurnByThread.delete(event.thread_id)
    }
    if (this.activeTurnByThread.get(event.thread_id) === turnId) {
      this.activeTurnByThread.delete(event.thread_id)
    }
    return persisted
  }

  private assistantTranscript(
    event: ProviderRuntimeEvent,
    payload: Record<string, unknown>,
    turnId: string,
    recoverySnapshot = false
  ): BufferedAssistantTranscript {
    const key = assistantTranscriptKey(event.thread_id, turnId)
    const existing = this.bufferedAssistantTranscripts.get(key)
    if (existing) {
      existing.recoverySnapshot ||= recoverySnapshot
      return existing
    }

    const persisted = this.options.transcriptStore?.getMessage?.(
      event.thread_id,
      providerAssistantMessageId(event.thread_id, turnId)
    )
    const persistedExtra = persisted?.extra ?? {}
    const content = utf8Prefix(
      persisted?.role === "assistant" ? persisted.content : "",
      this.assistantTranscriptMaxBytes
    )
    const contentBytes = Buffer.byteLength(content, "utf8")
    const reasoning = utf8Prefix(
      typeof persistedExtra.reasoning === "string"
        ? persistedExtra.reasoning
        : "",
      Math.max(0, this.assistantTranscriptMaxBytes - contentBytes)
    )
    const reasoningBytes = Buffer.byteLength(reasoning, "utf8")
    const toolCalls = persistedTranscriptToolCalls(persistedExtra.toolCalls)
    let toolCallsBytes = transcriptToolCallsBytes(toolCalls)
    const availableToolBytes = Math.max(
      0,
      this.assistantTranscriptMaxBytes - contentBytes - reasoningBytes
    )
    while (toolCalls.length > 0 && toolCallsBytes > availableToolBytes) {
      toolCalls.shift()
      toolCallsBytes = transcriptToolCallsBytes(toolCalls)
    }
    const storedProjectionSequence = persistedExtra.providerRuntimeSequence
    const persistedProjectionSequence =
      typeof storedProjectionSequence === "number" &&
      Number.isSafeInteger(storedProjectionSequence)
        ? storedProjectionSequence
        : -1
    const transcript: BufferedAssistantTranscript = {
      recoverySnapshot,
      threadId: event.thread_id,
      turnId,
      createdAt:
        persisted?.created_at ??
        readString(payload, "createdAt", "created_at", "timestamp") ??
        new Date().toISOString(),
      projectionSequence: persistedProjectionSequence,
      lastAppliedProjectionSequence: persistedProjectionSequence,
      persistedProjectionSequence,
      content,
      contentBytes,
      assistantTextBoundaryPending:
        persistedExtra.assistantTextBoundaryPending === true,
      reasoning,
      reasoningBytes,
      toolCalls,
      toolCallsBytes,
      providerKind: readString(
        payload,
        "providerKind",
        "provider_kind",
        "provider"
      ) ?? readString(persistedExtra, "providerKind", "provider_kind"),
      providerInstanceId: readString(
        payload,
        "providerInstanceId",
        "provider_instance_id"
      ) ?? readString(
        persistedExtra,
        "providerInstanceId",
        "provider_instance_id"
      ),
      status: readString(persistedExtra, "status"),
      truncated: persistedExtra.transcriptTruncated === true || undefined,
      retryAttempts: 0,
      bytesSincePersist: 0,
    }
    this.bufferedAssistantTranscripts.set(key, transcript)
    this.bufferedAssistantTranscriptBytes += assistantTranscriptBytes(transcript)
    return transcript
  }

  private markAssistantTranscriptEventApplied(
    transcript: BufferedAssistantTranscript,
    projectionSequence: number
  ): void {
    transcript.lastAppliedProjectionSequence = projectionSequence
    transcript.projectionSequence = projectionSequence
  }

  private flushPreviouslyAppliedAssistantTranscript(
    key: string,
    transcript: BufferedAssistantTranscript,
    flushImmediately: boolean
  ): boolean {
    if (
      flushImmediately &&
      transcript.projectionSequence > transcript.persistedProjectionSequence
    ) {
      return this.flushAssistantTranscript(key, false)
    }
    this.trimBufferedAssistantTranscripts()
    return true
  }

  private updateAssistantTranscriptText(
    transcript: BufferedAssistantTranscript,
    field: "content" | "reasoning",
    text: string,
    replace: boolean
  ): void {
    const previousTotal = assistantTranscriptBytes(transcript)
    let truncated = false

    if (field === "content") {
      const remainingBytes = Math.max(
        0,
        this.assistantTranscriptMaxBytes -
          transcript.toolCallsBytes -
          (replace ? 0 : transcript.contentBytes)
      )
      const boundedText = utf8Prefix(text, remainingBytes)
      const nextContent = replace
        ? boundedText
        : transcript.content + boundedText
      const nextContentBytes = replace
        ? Buffer.byteLength(boundedText, "utf8")
        : appendedUtf8Bytes(transcript.content, transcript.contentBytes, boundedText)
      const remainingReasoningBytes = Math.max(
        0,
        this.assistantTranscriptMaxBytes -
          nextContentBytes -
          transcript.toolCallsBytes
      )
      const previousReasoning = transcript.reasoning
      const nextReasoning = transcript.reasoningBytes <= remainingReasoningBytes
        ? previousReasoning
        : utf8Prefix(previousReasoning, remainingReasoningBytes)
      transcript.content = nextContent
      transcript.contentBytes = nextContentBytes
      transcript.reasoning = nextReasoning
      if (nextReasoning !== previousReasoning) {
        transcript.reasoningBytes = Buffer.byteLength(nextReasoning, "utf8")
      }
      truncated =
        boundedText.length !== text.length ||
        nextReasoning.length !== previousReasoning.length
    } else {
      const remainingBytes = Math.max(
        0,
        this.assistantTranscriptMaxBytes -
          transcript.contentBytes -
          transcript.toolCallsBytes -
          (replace ? 0 : transcript.reasoningBytes)
      )
      const boundedText = utf8Prefix(text, remainingBytes)
      transcript.reasoningBytes = replace
        ? Buffer.byteLength(boundedText, "utf8")
        : appendedUtf8Bytes(transcript.reasoning, transcript.reasoningBytes, boundedText)
      transcript.reasoning = replace ? boundedText : transcript.reasoning + boundedText
      truncated = boundedText.length !== text.length
    }

    const nextTotal = assistantTranscriptBytes(transcript)
    this.bufferedAssistantTranscriptBytes += nextTotal - previousTotal
    transcript.bytesSincePersist += Math.max(0, nextTotal - previousTotal)

    if (truncated && !transcript.truncated) {
      transcript.truncated = true
      this.options.logger.warn(
        {
          thread: transcript.threadId,
          turn: transcript.turnId,
          limit: this.assistantTranscriptMaxBytes,
        },
        "assistant transcript exceeded its byte limit and was truncated"
      )
    }
  }

  private updateAssistantTranscriptTool(
    transcript: BufferedAssistantTranscript,
    eventType: string,
    payload: Record<string, unknown>
  ): void {
    const phase = transcriptToolPhase(eventType, payload)
    if (!phase) return
    const previousTotal = assistantTranscriptBytes(transcript)
    const payloadToolName =
      readString(payload, "tool_name", "toolName", "name", "title") ??
      readString(payload, "itemType", "item_type", "kind")
    const explicitId = readString(
      payload,
      "tool_id",
      "toolId",
      "call_id",
      "callId",
      "item_id",
      "itemId",
      "id"
    )
    let index = explicitId
      ? transcript.toolCalls.findIndex((call) => call.id === explicitId)
      : -1
    if (index < 0 && phase !== "started") {
      for (let candidate = transcript.toolCalls.length - 1; candidate >= 0; candidate -= 1) {
        const call = transcript.toolCalls[candidate]
        if (
          call?.state === "input-available" &&
          (!payloadToolName || call.name === payloadToolName)
        ) {
          index = candidate
          break
        }
      }
    }
    const existing = index >= 0 ? transcript.toolCalls[index] : undefined
    // The first real name sticks. Later events carry the provider's title,
    // which for an ACP search is the pattern itself — no basis for a name.
    const toolName =
      existing && !isGenericToolName(existing.name)
        ? existing.name
        : (payloadToolName ?? existing?.name ?? "tool")
    const title = readString(payload, "title") ?? existing?.title
    // `kind` sometimes carries the item type on legacy payloads; only a
    // classification that says more than the item type is worth keeping.
    const itemType = readString(payload, "itemType", "item_type")
    const payloadKind =
      readString(payload, "kind") ??
      readString(asRecord(payload.data), "kind")
    const kind =
      (payloadKind && payloadKind !== itemType ? payloadKind : undefined) ??
      existing?.kind
    const id = explicitId ?? existing?.id ?? `tool-${transcript.toolCalls.length + 1}`
    const now =
      readString(payload, "createdAt", "created_at", "timestamp") ??
      new Date().toISOString()
    const providerKind =
      readString(payload, "providerKind", "provider_kind", "provider") ??
      transcript.providerKind
    const providerInstanceId =
      readString(payload, "providerInstanceId", "provider_instance_id") ??
      transcript.providerInstanceId
    const error = readString(payload, "error", "errorMessage", "message")
    const startedAt =
      existing?.startedAt ??
      readString(payload, "startedAt", "started_at") ??
      now
    const completedAt =
      phase === "started"
        ? existing?.completedAt
        : (readString(payload, "completedAt", "completed_at") ?? now)
    const input = boundedTranscriptToolValue(
      payload.input ?? payload.arguments ?? payload.args ?? existing?.input ?? {}
    )
    const outputSource =
      payload.output ?? payload.result ?? payload.data ?? payload.content
    const next: BufferedTranscriptToolCall = {
      id,
      name: toolName,
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
      input,
      ...(phase !== "started"
        ? { output: boundedTranscriptToolValue(outputSource ?? "") }
        : existing?.output !== undefined
          ? { output: existing.output }
          : {}),
      state:
        phase === "failed"
          ? "output-error"
          : phase === "completed"
            ? "output-available"
            : "input-available",
      ...(providerKind ? { providerKind } : {}),
      ...(providerInstanceId ? { providerInstanceId } : {}),
      turnId: transcript.turnId,
      startedAt,
      ...(completedAt ? { completedAt } : {}),
      ...(completedAt
        ? { durationMs: timestampDurationMs(startedAt, completedAt) }
        : {}),
      ...(phase === "failed" && error ? { error } : {}),
    }

    if (index >= 0) transcript.toolCalls[index] = next
    else transcript.toolCalls.push(next)
    if (transcript.toolCalls.length > MAX_TRANSCRIPT_TOOL_CALLS) {
      transcript.toolCalls.splice(
        0,
        transcript.toolCalls.length - MAX_TRANSCRIPT_TOOL_CALLS
      )
      transcript.truncated = true
    }

    const availableBytes = Math.max(
      0,
      this.assistantTranscriptMaxBytes -
        transcript.contentBytes -
        transcript.reasoningBytes
    )
    transcript.toolCallsBytes = transcriptToolCallsBytes(transcript.toolCalls)
    while (
      transcript.toolCalls.length > 0 &&
      transcript.toolCallsBytes > availableBytes
    ) {
      transcript.toolCalls.shift()
      transcript.toolCallsBytes = transcriptToolCallsBytes(transcript.toolCalls)
      transcript.truncated = true
    }
    const nextTotal = assistantTranscriptBytes(transcript)
    const addedBytes = nextTotal - previousTotal
    this.bufferedAssistantTranscriptBytes += addedBytes
    transcript.bytesSincePersist += Math.max(0, addedBytes)
  }

  /**
   * Each flush rewrites the whole message row, so a fixed 16 KiB cadence makes
   * a 1 MB response cost ~64 full rewrites (quadratic bytes). Scaling the
   * threshold with the transcript keeps it near a constant number of flushes
   * per doubling; the timer-based flush still bounds latency.
   */
  private assistantTranscriptFlushThreshold(
    transcript: BufferedAssistantTranscript
  ): number {
    return Math.max(
      this.assistantTranscriptFlushBytes,
      Math.floor(assistantTranscriptBytes(transcript) / 8)
    )
  }

  private scheduleAssistantTranscriptFlush(
    transcript: BufferedAssistantTranscript
  ): void {
    if (transcript.flushTimer) return
    transcript.flushTimer = setTimeout(() => {
      transcript.flushTimer = undefined
      this.flushAssistantTranscript(
        assistantTranscriptKey(transcript.threadId, transcript.turnId),
        false
      )
    }, ASSISTANT_TRANSCRIPT_FLUSH_DELAY_MS)
    transcript.flushTimer.unref?.()
  }

  private flushAssistantTranscript(key: string, terminal: boolean): boolean {
    const transcript = this.bufferedAssistantTranscripts.get(key)
    if (!transcript) return true
    if (!transcript.recoverySnapshot && !this.shouldPersistConversations()) {
      this.dropBufferedAssistantTranscript(key, transcript)
      return true
    }
    if (terminal) transcript.terminal = true
    if (transcript.flushTimer) {
      clearTimeout(transcript.flushTimer)
      transcript.flushTimer = undefined
    }
    let persisted = true
    if (
      transcript.content.length > 0 ||
      transcript.reasoning.length > 0 ||
      transcript.toolCalls.length > 0 ||
      // A replace-to-empty event still has to clear a previously saved row.
      transcript.persistedProjectionSequence >= 0
    ) {
      try {
        this.options.transcriptStore?.upsertMessage(
          assistantTranscriptRequest(transcript)
        )
        const snapshotAttributes = {
          provider: transcript.providerKind ?? "unknown",
          terminal: transcript.terminal === true,
        }
        backendMetrics.incrementCounter(
          PROVIDER_TRANSCRIPT_SNAPSHOTS_TOTAL,
          snapshotAttributes
        )
        backendMetrics.incrementCounter(
          PROVIDER_TRANSCRIPT_SNAPSHOT_BYTES_TOTAL,
          snapshotAttributes,
          assistantTranscriptBytes(transcript)
        )
        transcript.persistedProjectionSequence = transcript.projectionSequence
        transcript.bytesSincePersist = 0
      } catch (err) {
        persisted = false
        this.options.logger.warn(
          {
            err,
            thread: transcript.threadId,
            turn: transcript.turnId,
          },
          "failed to persist streamed assistant transcript"
        )
      }
    }
    if (
      terminal &&
      persisted &&
      this.bufferedAssistantTranscripts.delete(key)
    ) {
      this.bufferedAssistantTranscriptBytes = Math.max(
        0,
        this.bufferedAssistantTranscriptBytes -
          assistantTranscriptBytes(transcript)
      )
    } else if (persisted) {
      transcript.retryAttempts = 0
    } else if (transcript.terminal && !this.stopped) {
      this.scheduleAssistantTranscriptRetry(key, transcript)
    }
    return persisted
  }

  private scheduleAssistantTranscriptRetry(
    key: string,
    transcript: BufferedAssistantTranscript
  ): void {
    transcript.retryAttempts += 1
    if (transcript.retryAttempts > this.assistantTranscriptRetryMaxAttempts) {
      if (!this.spoolAssistantTranscript(key, transcript, "retry_exhausted")) {
        this.options.logger.error(
          {
            thread: transcript.threadId,
            turn: transcript.turnId,
            attempts: transcript.retryAttempts,
          },
          "assistant transcript persistence retries exhausted; recovery spool unavailable"
        )
        this.dropBufferedAssistantTranscript(key, transcript)
        this.markAssistantTranscriptEvicted(key, transcript)
        this.reportFatalTranscriptDurabilityFailure(
          transcript,
          "retry exhaustion and recovery spool failure"
        )
      }
      return
    }

    const delayMs = Math.min(
      this.assistantTranscriptRetryMaxMs,
      this.assistantTranscriptRetryBaseMs * 2 ** (transcript.retryAttempts - 1)
    )
    transcript.flushTimer = setTimeout(() => {
      transcript.flushTimer = undefined
      this.flushAssistantTranscript(key, true)
    }, delayMs)
    transcript.flushTimer.unref?.()
  }

  private spoolAssistantTranscript(
    key: string,
    transcript: BufferedAssistantTranscript,
    reason: "retry_exhausted" | "memory_pressure" | "shutdown"
  ): boolean {
    if (!this.options.transcriptRecoveryStore) return false
    let queued = false
    try {
      queued = this.options.transcriptRecoveryStore.enqueue(
        assistantTranscriptRequest(transcript),
        { reason, truncated: transcript.truncated === true }
      )
    } catch (err) {
      this.options.logger.error(
        { err, thread: transcript.threadId, turn: transcript.turnId, reason },
        "assistant transcript recovery spool threw while enqueueing"
      )
      return false
    }
    if (!queued) return false
    this.options.logger.error(
      {
        thread: transcript.threadId,
        turn: transcript.turnId,
        attempts: transcript.retryAttempts,
        reason,
      },
      "assistant transcript transferred to durable recovery spool"
    )
    this.dropBufferedAssistantTranscript(key, transcript)
    this.markAssistantTranscriptEvicted(key, transcript)
    return true
  }

  private reportFatalTranscriptDurabilityFailure(
    transcript: BufferedAssistantTranscript,
    detail: string
  ): void {
    if (!this.options.onFatalDurabilityFailure) return
    const error = new Error(
      `Assistant transcript durability failed for thread '${transcript.threadId}', turn '${transcript.turnId}': ${detail}.`
    )
    try {
      this.options.onFatalDurabilityFailure(error, {
        threadId: transcript.threadId,
        turnId: transcript.turnId,
      })
    } catch (callbackError) {
      this.options.logger.error(
        { err: callbackError, thread: transcript.threadId, turn: transcript.turnId },
        "fatal transcript durability callback failed"
      )
    }
  }

  private flushAssistantTranscriptsForThread(threadId: string): boolean {
    const prefix = `${encodeURIComponent(threadId)}:`
    let persisted = true
    for (const key of this.bufferedAssistantTranscripts.keys()) {
      if (key.startsWith(prefix)) {
        persisted = this.flushAssistantTranscript(key, true) && persisted
      }
    }
    for (const key of this.evictedAssistantTranscriptKeys) {
      if (key.startsWith(prefix))
        this.evictedAssistantTranscriptKeys.delete(key)
    }
    this.evictedAssistantTurnByThread.delete(threadId)
    return persisted
  }

  private trimBufferedAssistantTranscripts(): void {
    while (
      this.bufferedAssistantTranscripts.size >
        MAX_BUFFERED_ASSISTANT_TRANSCRIPTS ||
      this.bufferedAssistantTranscriptBytes >
        this.bufferedAssistantTranscriptsMaxBytes
    ) {
      const oldestKey = this.bufferedAssistantTranscripts.keys().next()
        .value as string | undefined
      if (!oldestKey) return
      const transcript = this.bufferedAssistantTranscripts.get(oldestKey)
      if (!transcript) return
      const persisted = this.flushAssistantTranscript(oldestKey, false)
      if (persisted) {
        this.dropBufferedAssistantTranscript(oldestKey, transcript)
        this.markAssistantTranscriptEvicted(oldestKey, transcript)
      } else if (!this.spoolAssistantTranscript(oldestKey, transcript, "memory_pressure")) {
        this.dropBufferedAssistantTranscript(oldestKey, transcript)
        this.markAssistantTranscriptEvicted(oldestKey, transcript)
        this.options.logger.error(
          {
            thread: transcript.threadId,
            turn: transcript.turnId,
            limit: this.bufferedAssistantTranscriptsMaxBytes,
          },
          "assistant transcript dropped after persistence failed at the hard memory limit"
        )
        this.reportFatalTranscriptDurabilityFailure(
          transcript,
          "hard memory limit and recovery spool failure"
        )
      }
    }
  }

  private dropBufferedAssistantTranscript(
    key: string,
    transcript: BufferedAssistantTranscript
  ): void {
    if (transcript.flushTimer) {
      clearTimeout(transcript.flushTimer)
      transcript.flushTimer = undefined
    }
    if (!this.bufferedAssistantTranscripts.delete(key)) return
    this.bufferedAssistantTranscriptBytes = Math.max(
      0,
      this.bufferedAssistantTranscriptBytes -
        assistantTranscriptBytes(transcript)
    )
  }

  private markAssistantTranscriptEvicted(
    key: string,
    transcript: BufferedAssistantTranscript
  ): void {
    this.evictedAssistantTurnByThread.set(
      transcript.threadId,
      transcript.turnId
    )
    this.evictedAssistantTranscriptKeys.delete(key)
    this.evictedAssistantTranscriptKeys.add(key)
    while (
      this.evictedAssistantTranscriptKeys.size >
      this.evictedAssistantTranscriptMaxKeys
    ) {
      const oldestKey = this.evictedAssistantTranscriptKeys.values().next()
        .value as string | undefined
      if (!oldestKey) return
      this.evictedAssistantTranscriptKeys.delete(oldestKey)
    }
  }

  private isAssistantTranscriptEvicted(
    key: string,
    threadId: string,
    turnId: string
  ): boolean {
    return (
      this.evictedAssistantTranscriptKeys.has(key) ||
      this.evictedAssistantTurnByThread.get(threadId) === turnId
    )
  }

  private persistThreadActivity(
    activity: ThreadActivityProjection,
    broadcast = true
  ): boolean {
    try {
      this.options.activityStore.upsert(activity)
      if (broadcast) {
        try {
          this.options.broadcaster.broadcast({
            channel: "thread.activity",
            data: threadActivityToWire(activity),
          })
        } catch (err) {
          this.options.logger.warn(
            { err, thread: activity.thread_id, kind: activity.kind },
            "failed to broadcast provider thread activity"
          )
        }
      }
      return true
    } catch (err) {
      this.options.logger.warn(
        { err, thread: activity.thread_id, kind: activity.kind },
        "failed to persist provider thread activity"
      )
      return false
    }
  }

  private logProviderRuntimeEvent(
    event: ProviderRuntimeEvent,
    eventMeta: ReturnType<typeof providerEventMeta>,
    clients: number
  ): void {
    const record = this.providerRuntimeLogRecord(event, eventMeta, clients)
    if (!record) return
    this.options.logger[record.level](record.bindings, record.message)
  }

  private providerRuntimeLogRecord(
    event: ProviderRuntimeEvent,
    eventMeta: ReturnType<typeof providerEventMeta>,
    clients: number
  ): ProviderRuntimeLogRecord | null {
    const traceAll =
      this.options.traceProviderEvents ??
      getBackendLoggingSettings().traceProviderEvents
    const payload = asRecord(event.payload)
    const base = providerRuntimeLogBindings(event, eventMeta, payload, clients)

    if (traceAll) {
      return {
        level: "info",
        message: "provider event",
        bindings: base,
      }
    }

    switch (event.event_type) {
      case "turn_started":
      case "turn.started":
        return { level: "info", message: "event started", bindings: base }
      case "turn_completed":
      case "turn.completed":
        this.clearReasoningStartForEvent(event, payload)
        return { level: "info", message: "event completed", bindings: base }
      case "turn_interrupted":
      case "turn.aborted":
        this.clearReasoningStartForEvent(event, payload)
        return { level: "warn", message: "event interrupted", bindings: base }
      case "turn_error":
      case "runtime.error":
        this.clearReasoningStartForEvent(event, payload)
        return { level: "error", message: "event failed", bindings: base }
      case "session.started":
      case "thread.started":
        return { level: "info", message: "session started", bindings: base }
      case "session.exited":
      case "session_exited":
        this.clearReasoningStartsForThread(event.thread_id)
        return { level: "info", message: "session ended", bindings: base }
      case "tool_call":
      case "tool.started":
      case "item.started":
      case "item_started":
        if (!isToolishProviderEvent(event.event_type, payload)) return null
        return { level: "info", message: "tool started", bindings: base }
      case "tool_result":
      case "tool.completed":
      case "item.completed":
      case "item_completed":
        if (!isToolishProviderEvent(event.event_type, payload)) return null
        return { level: "info", message: "tool completed", bindings: base }
      case "tool.failed":
        return { level: "warn", message: "tool failed", bindings: base }
      case "tool.denied":
        return { level: "warn", message: "tool denied", bindings: base }
      case "tool_approval_requested":
      case "approval.requested":
        return { level: "info", message: "approval requested", bindings: base }
      case "reasoning_delta":
      case "reasoning.delta":
      case "reasoning_replace":
      case "reasoning.replace":
        return this.reasoningStartedLogRecord(event, payload, base)
      case "turn.proposed.completed":
      case "plan_completed":
        return { level: "info", message: "plan completed", bindings: base }
      default:
        return null
    }
  }

  private reasoningStartedLogRecord(
    event: ProviderRuntimeEvent,
    payload: Record<string, unknown>,
    bindings: Record<string, unknown>
  ): ProviderRuntimeLogRecord | null {
    const key = reasoningStartKey(event, payload)
    if (this.loggedReasoningStarts.has(key)) return null
    this.loggedReasoningStarts.add(key)
    return {
      level: "info",
      message: "reasoning started",
      bindings,
    }
  }

  private clearReasoningStartForEvent(
    event: ProviderRuntimeEvent,
    payload: Record<string, unknown>
  ): void {
    this.loggedReasoningStarts.delete(reasoningStartKey(event, payload))
  }

  private clearReasoningStartsForThread(threadId: string): void {
    const prefix = `${encodeURIComponent(threadId)}:`
    for (const key of this.loggedReasoningStarts) {
      if (key.startsWith(prefix)) this.loggedReasoningStarts.delete(key)
    }
  }

  private ingestThreadMetadata(
    event: ProviderRuntimeEvent,
    strict = false
  ): boolean {
    if (event.event_type !== "thread.metadata.updated") return true
    const title = providerMetadataTitle(event.payload)
    const payload = asRecord(event.payload)
    const metadata = payload.metadata === undefined ? payload : asRecord(payload.metadata)
    const hasGoal = Object.prototype.hasOwnProperty.call(metadata, "goal")
    if (!title && !hasGoal) return true
    try {
      if (title) {
        this.options.threadMetadataStore?.updateThreadTitle(
          event.thread_id,
          title,
          providerMetadataUpdatedAt(event.payload)
        )
      }
      if (hasGoal) {
        this.options.threadMetadataStore?.updateThreadGoal?.(
          event.thread_id,
          metadata.goal,
          providerSessionLifecycleTarget(event)?.providerKind,
          providerMetadataUpdatedAt(event.payload)
        )
      }
      return true
    } catch (err) {
      this.options.logger.warn(
        { err, thread: event.thread_id, event_type: event.event_type },
        "failed to persist provider thread metadata"
      )
      if (strict) throw err
      return false
    }
  }

  private ingestSourceProposedPlanImplementation(
    event: ProviderRuntimeEvent,
    strict = false,
    broadcast = true
  ): boolean {
    if (
      event.event_type !== "turn_started" &&
      event.event_type !== "turn.started"
    ) {
      return true
    }
    const store = this.options.sourceProposedPlanImplementations
    if (!store) return true

    const target = providerSessionLifecycleTarget(event)
    if (!target) return true

    let current: ProviderRuntimeSessionLifecycleSnapshot | null = null
    try {
      current =
        this.options.sessionLifecycleStore?.get?.(
          target.threadId,
          target.providerInstanceId
        ) ?? null
    } catch (err) {
      this.options.logger.warn(
        { err, thread: event.thread_id, event_type: event.event_type },
        "failed to read provider session lifecycle before marking proposed plan implementation"
      )
      if (strict) throw err
      return false
    }

    if (
      !shouldApplyThreadLifecycle(
        event.event_type,
        current?.activeTurnId ?? null,
        target.turnId
      )
    ) {
      return true
    }

    const acceptedTurnId = readString(
      target.payload,
      "dispatchTurnId",
      "dispatch_turn_id",
      "turn_id",
      "turnId"
    )
    if (!acceptedTurnId) return true
    const pendingKey = {
      implementationThreadId: target.threadId,
      providerKind: target.providerKind,
      providerInstanceId: target.providerInstanceId,
      acceptedTurnId,
    }
    let pending: SourceProposedPlanImplementationInput | null
    try {
      pending = store.peekPending(pendingKey)
    } catch (err) {
      this.options.logger.warn(
        { err, thread: event.thread_id, event_type: event.event_type },
        "failed to read accepted source-plan implementation link"
      )
      if (strict) throw err
      return false
    }
    if (!pending) return true

    const implementedAt =
      readString(target.payload, "createdAt", "created_at") ??
      new Date().toISOString()
    this.sequence += 1
    const persisted = this.persistThreadActivity({
      activity_id: sourceProposedPlanImplementedActivityId(pending),
      thread_id: pending.sourceProposedPlan.threadId,
      turn_id: null,
      provider_instance_id:
        pending.providerInstanceId ?? target.providerInstanceId ?? null,
      kind: "turn.proposed.implemented",
      tone: "info",
      summary: "Plan implemented",
      payload: {
        sourceProposedPlan: pending.sourceProposedPlan,
        implementationThreadId: pending.implementationThreadId,
        implementedAt,
        providerKind: pending.providerKind,
        ...(pending.providerInstanceId
          ? { providerInstanceId: pending.providerInstanceId }
          : target.providerInstanceId
            ? { providerInstanceId: target.providerInstanceId }
            : {}),
      },
      sequence: this.sequence,
      created_at: implementedAt,
    }, broadcast)
    if (!persisted) return false
    try {
      store.ackPending(pendingKey)
    } catch (err) {
      this.options.logger.warn(
        { err, thread: event.thread_id, event_type: event.event_type },
        "failed to acknowledge source-plan implementation link"
      )
      if (strict) throw err
      return false
    }
    return true
  }

  private ingestSessionLifecycle(
    event: ProviderRuntimeEvent,
    strict = false
  ): boolean {
    const target = providerSessionLifecycleTarget(event)
    if (!target) return true
    let current: ProviderRuntimeSessionLifecycleSnapshot | null = null
    try {
      current =
        this.options.sessionLifecycleStore?.get?.(
          target.threadId,
          target.providerInstanceId
        ) ?? null
    } catch (err) {
      this.options.logger.warn(
        { err, thread: event.thread_id, event_type: event.event_type },
        "failed to read provider session lifecycle"
      )
      if (strict) throw err
      return false
    }

    const lifecycle = providerSessionLifecycle(event, target, current)
    if (!lifecycle) return true
    try {
      this.options.sessionLifecycleStore?.updateSessionLifecycle(lifecycle)
      return true
    } catch (err) {
      this.options.logger.warn(
        { err, thread: event.thread_id, event_type: event.event_type },
        "failed to persist provider session lifecycle"
      )
      if (strict) throw err
      return false
    }
  }

  private ingestProposedPlanBuffer(
    event: ProviderRuntimeEvent,
    sequence: number,
    broadcast: boolean
  ): void {
    const eventType = event.event_type
    if (
      eventType !== "turn.proposed.delta" &&
      eventType !== "turn_proposed_delta" &&
      eventType !== "turn.proposed.completed" &&
      eventType !== "turn_proposed_completed" &&
      eventType !== "turn_completed" &&
      eventType !== "turn.completed"
    ) {
      return
    }

    const payload = asRecord(event.payload)
    const key = proposedPlanBufferKey(event, payload)
    if (!key) return

    if (
      eventType === "turn.proposed.delta" ||
      eventType === "turn_proposed_delta"
    ) {
      const delta = readString(payload, "delta")
      if (!delta) return
      const existing =
        this.bufferedProposedPlans.get(key) ??
        this.restoreBufferedProposedPlan(event, payload, sequence)
      const previousBytes = existing?.bytes ?? 0
      const boundedDelta = utf8Prefix(
        delta,
        Math.max(0, this.proposedPlanMaxBytes - previousBytes)
      )
      const text = `${existing?.text ?? ""}${boundedDelta}`
      const bytes = Buffer.byteLength(text, "utf8")
      const truncated =
        existing?.truncated === true || boundedDelta.length !== delta.length
      const boundedPayload = { ...payload }
      delete boundedPayload.delta
      this.bufferedProposedPlans.set(key, {
        payload: { ...(existing?.payload ?? {}), ...boundedPayload },
        text,
        bytes,
        truncated,
      })
      this.bufferedProposedPlanBytes += bytes - previousBytes
      if (truncated && existing?.truncated !== true) {
        this.options.logger.warn(
          {
            thread: event.thread_id,
            plan: key,
            limit: this.proposedPlanMaxBytes,
          },
          "proposed plan exceeded its byte limit and was truncated"
        )
      }
      this.trimBufferedProposedPlans()
      return
    }

    if (
      eventType === "turn.proposed.completed" ||
      eventType === "turn_proposed_completed"
    ) {
      this.deleteBufferedProposedPlan(key)
      return
    }

    const buffered =
      this.bufferedProposedPlans.get(key) ??
      this.restoreBufferedProposedPlan(event, payload, sequence)
    const planMarkdown = buffered?.text.trim()
    if (!buffered || !planMarkdown) return
    this.deleteBufferedProposedPlan(key)

    this.sequence += 1
    const syntheticActivity = projectProviderEventToThreadActivity(
      {
        event_type: "turn.proposed.completed",
        thread_id: event.thread_id,
        payload: {
          ...buffered.payload,
          ...payload,
          planMarkdown,
        },
      },
      this.sequence
    )
    if (syntheticActivity) {
      if (!this.persistThreadActivity(syntheticActivity, broadcast)) {
        throw new Error("Failed to persist the completed proposed plan.")
      }
    }
  }

  private consumeBufferedProposedPlanCompletion(
    event: ProviderRuntimeEvent,
    sequence: number
  ): BufferedProposedPlanCompletion {
    const eventType = event.event_type
    if (
      eventType !== "turn.proposed.completed" &&
      eventType !== "turn_proposed_completed"
    ) {
      return { activity: null, suppressDefaultActivity: false }
    }

    const payload = asRecord(event.payload)
    const key = proposedPlanBufferKey(event, payload)
    if (!key) return { activity: null, suppressDefaultActivity: false }

    const buffered =
      this.bufferedProposedPlans.get(key) ??
      this.restoreBufferedProposedPlan(event, payload, sequence)
    if (!buffered) return { activity: null, suppressDefaultActivity: false }
    this.deleteBufferedProposedPlan(key)

    const planMarkdown =
      buffered.text.trim() ||
      readString(payload, "planMarkdown", "plan_markdown")?.trim()
    if (!planMarkdown) {
      return { activity: null, suppressDefaultActivity: true }
    }

    return {
      activity: projectProviderEventToThreadActivity(
        {
          event_type: eventType,
          thread_id: event.thread_id,
          payload: {
            ...buffered.payload,
            ...payload,
            planMarkdown,
          },
        },
        sequence
      ),
      suppressDefaultActivity: true,
    }
  }

  private restoreBufferedProposedPlan(
    event: ProviderRuntimeEvent,
    payload: Record<string, unknown>,
    beforeSequence: number
  ): BufferedProposedPlan | null {
    const listByThread = this.options.activityStore.listByThread
    if (!listByThread) return null
    const targetKey = proposedPlanBufferKey(event, payload)
    if (!targetKey) return null

    const activities = listByThread
      .call(this.options.activityStore, event.thread_id)
      .filter(
        (activity) =>
          activity.kind === "turn.proposed.delta" &&
          typeof activity.sequence === "number" &&
          activity.sequence < beforeSequence
      )
      .sort(
        (left, right) =>
          (left.sequence ?? Number.NEGATIVE_INFINITY) -
          (right.sequence ?? Number.NEGATIVE_INFINITY)
      )

    let text = ""
    let restoredPayload: Record<string, unknown> = {}
    let truncated = false
    for (const activity of activities) {
      const activityPayload = asRecord(activity.payload)
      if (
        proposedPlanBufferKey(
          {
            event_type: "turn.proposed.delta",
            thread_id: activity.thread_id,
            payload: activityPayload,
          },
          activityPayload
        ) !== targetKey
      ) {
        continue
      }
      const delta = readString(activityPayload, "delta")
      if (!delta) continue
      const boundedDelta = utf8Prefix(
        delta,
        Math.max(
          0,
          this.proposedPlanMaxBytes - Buffer.byteLength(text, "utf8")
        )
      )
      text += boundedDelta
      truncated ||= boundedDelta.length !== delta.length
      const metadata = { ...activityPayload }
      delete metadata.delta
      restoredPayload = { ...restoredPayload, ...metadata }
    }
    if (!text) return null

    const restored: BufferedProposedPlan = {
      payload: restoredPayload,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated,
    }
    this.bufferedProposedPlans.set(targetKey, restored)
    this.bufferedProposedPlanBytes += restored.bytes
    this.trimBufferedProposedPlans()
    return this.bufferedProposedPlans.get(targetKey) ?? null
  }

  private trimBufferedProposedPlans(): void {
    while (
      this.bufferedProposedPlans.size > MAX_BUFFERED_PROPOSED_PLANS ||
      this.bufferedProposedPlanBytes > this.bufferedProposedPlansMaxBytes
    ) {
      const oldestKey = this.bufferedProposedPlans.keys().next().value as
        | string
        | undefined
      if (!oldestKey) return
      this.deleteBufferedProposedPlan(oldestKey)
    }
  }

  private deleteBufferedProposedPlan(key: string): void {
    const buffered = this.bufferedProposedPlans.get(key)
    if (!buffered || !this.bufferedProposedPlans.delete(key)) return
    this.bufferedProposedPlanBytes = Math.max(
      0,
      this.bufferedProposedPlanBytes - buffered.bytes
    )
  }

  private clearBufferedProposedPlansForSessionExit(
    event: ProviderRuntimeEvent
  ): void {
    if (
      event.event_type !== "session.exited" &&
      event.event_type !== "session_exited"
    ) {
      return
    }
    const prefix = `${encodeURIComponent(event.thread_id)}:`
    for (const key of this.bufferedProposedPlans.keys()) {
      if (key.startsWith(prefix)) {
        this.deleteBufferedProposedPlan(key)
      }
    }
  }

  private shouldPersistConversations(): boolean {
    try {
      return this.options.shouldPersistConversations?.() ?? true
    } catch (err) {
      this.options.logger.warn(
        { err },
        "conversation persistence policy check failed; suppressing persistence"
      )
      return false
    }
  }

  private discardConversationBuffers(threadId: string): void {
    const prefix = `${encodeURIComponent(threadId)}:`
    for (const [key, transcript] of this.bufferedAssistantTranscripts) {
      if (key.startsWith(prefix)) {
        this.dropBufferedAssistantTranscript(key, transcript)
      }
    }
    for (const key of this.bufferedProposedPlans.keys()) {
      if (key.startsWith(prefix)) this.deleteBufferedProposedPlan(key)
    }
    for (const key of this.evictedAssistantTranscriptKeys) {
      if (key.startsWith(prefix)) this.evictedAssistantTranscriptKeys.delete(key)
    }
    this.activeTurnByThread.delete(threadId)
    this.evictedAssistantTurnByThread.delete(threadId)
  }
}

export function threadActivityToWire(activity: ThreadActivityProjection): {
  readonly id: string
  readonly threadId: string
  readonly turnId: string | null
  readonly providerInstanceId: string | null
  readonly kind: string
  readonly tone: ThreadActivityProjection["tone"]
  readonly summary: string
  readonly payload: unknown
  readonly sequence: number | null
  readonly createdAt: string
} {
  return {
    id: activity.activity_id,
    threadId: activity.thread_id,
    turnId: activity.turn_id,
    providerInstanceId: activity.provider_instance_id ?? null,
    kind: activity.kind,
    tone: activity.tone,
    summary: activity.summary,
    payload: activity.payload,
    sequence: activity.sequence ?? null,
    createdAt: activity.created_at,
  }
}

export function providerAssistantMessageId(
  threadId: string,
  turnId: string
): string {
  return `provider-assistant:${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`
}

function assistantTranscriptRequest(
  transcript: BufferedAssistantTranscript
): ThreadMessageUpsertRequest {
  return {
    thread_id: transcript.threadId,
    message: {
      message_id: providerAssistantMessageId(
        transcript.threadId,
        transcript.turnId
      ),
      turn_id: transcript.turnId,
      role: "assistant",
      content: transcript.content,
      created_at: transcript.createdAt,
      extra: {
        providerRuntimeSequence: transcript.projectionSequence,
        ...(transcript.assistantTextBoundaryPending
          ? { assistantTextBoundaryPending: true }
          : {}),
        ...(transcript.reasoning ? { reasoning: transcript.reasoning } : {}),
        ...(transcript.toolCalls.length > 0
          ? { toolCalls: transcript.toolCalls }
          : {}),
        ...(transcript.providerKind
          ? { providerKind: transcript.providerKind }
          : {}),
        ...(transcript.providerInstanceId
          ? { providerInstanceId: transcript.providerInstanceId }
          : {}),
        ...(transcript.status ? { status: transcript.status } : {}),
        ...(transcript.truncated ? { transcriptTruncated: true } : {}),
      },
    },
  }
}

function assistantTranscriptKey(threadId: string, turnId: string): string {
  return `${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return ""
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value

  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = value.slice(0, middle)
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = middle
    else high = middle - 1
  }
  let end = low
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1
  return value.slice(0, end)
}

function assistantParagraphSeparator(previous: string, next: string): string {
  const trailing = previous.slice(-4).match(/(?:\r?\n)*$/)?.[0].match(/\n/g)?.length ?? 0
  const leading = next.slice(0, 4).match(/^(?:\r?\n)*/)?.[0].match(/\n/g)?.length ?? 0
  return "\n".repeat(Math.max(0, 2 - trailing - leading))
}

function isAssistantMessageBoundary(
  eventType: string,
  payload: Record<string, unknown>
): boolean {
  if (eventType !== "item.completed" && eventType !== "item_completed") return false
  const kind = (readString(payload, "itemType", "item_type", "kind") ?? "")
    .toLowerCase().replace(/[^a-z]/g, "")
  return kind === "assistantmessage" || kind === "agentmessage" ||
    kind === "assistant" || payload.role === "assistant"
}

function isAssistantContentEvent(
  eventType: string,
  payload: Record<string, unknown>
): boolean {
  if (
    eventType !== "content_delta" &&
    eventType !== "content.delta" &&
    eventType !== "content_replace" &&
    eventType !== "content.replace"
  ) {
    return false
  }
  const streamKind = readString(payload, "streamKind", "stream_kind", "kind")
  return (
    !streamKind ||
    streamKind === "assistant" ||
    streamKind === "assistant_text" ||
    streamKind === "text"
  )
}

function isReasoningContentEvent(eventType: string): boolean {
  return (
    eventType === "reasoning_delta" ||
    eventType === "reasoning.delta" ||
    eventType === "reasoning_replace" ||
    eventType === "reasoning.replace"
  )
}

function transcriptToolPhase(
  eventType: string,
  payload: Record<string, unknown>
): "started" | "completed" | "failed" | null {
  if (!isToolishProviderEvent(eventType, payload)) return null
  if (eventType === "tool.failed") return "failed"
  if (
    eventType === "tool_result" ||
    eventType === "tool.completed" ||
    eventType === "item.completed" ||
    eventType === "item_completed"
  ) {
    return readString(payload, "error", "errorMessage")
      ? "failed"
      : "completed"
  }
  if (
    eventType === "tool_call" ||
    eventType === "tool_call_delta" ||
    eventType === "tool.started" ||
    eventType === "item.started" ||
    eventType === "item_started"
  ) {
    return "started"
  }
  return null
}

function boundedTranscriptToolValue(value: unknown): unknown {
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? String(value ?? "")
  } catch {
    serialized = String(value ?? "")
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_TRANSCRIPT_TOOL_VALUE_BYTES) {
    return value
  }
  const suffix = "\n[tool value truncated]"
  return `${utf8Prefix(
    serialized,
    MAX_TRANSCRIPT_TOOL_VALUE_BYTES - Buffer.byteLength(suffix, "utf8")
  )}${suffix}`
}

function persistedTranscriptToolCalls(
  value: unknown
): BufferedTranscriptToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: BufferedTranscriptToolCall[] = []
  for (const candidate of value.slice(-MAX_TRANSCRIPT_TOOL_CALLS)) {
    const record = asRecord(candidate)
    const id = readString(record, "id", "toolId", "tool_id")
    const name = readString(record, "name", "toolName", "tool_name")
    if (!id || !name) continue
    const rawState = readString(record, "state")
    const state: BufferedTranscriptToolCall["state"] =
      rawState === "output-error" || rawState === "output-available"
        ? rawState
        : "input-available"
    const title = readString(record, "title")
    const kind = readString(record, "kind")
    calls.push({
      id,
      name,
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
      input: boundedTranscriptToolValue(record.input),
      ...(record.output !== undefined
        ? { output: boundedTranscriptToolValue(record.output) }
        : {}),
      state,
      ...(readString(record, "providerKind", "provider_kind")
        ? {
            providerKind: readString(
              record,
              "providerKind",
              "provider_kind"
            ),
          }
        : {}),
      ...(readString(record, "providerInstanceId", "provider_instance_id")
        ? {
            providerInstanceId: readString(
              record,
              "providerInstanceId",
              "provider_instance_id"
            ),
          }
        : {}),
      ...(readString(record, "turnId", "turn_id")
        ? { turnId: readString(record, "turnId", "turn_id") }
        : {}),
      ...(readString(record, "startedAt", "started_at")
        ? { startedAt: readString(record, "startedAt", "started_at") }
        : {}),
      ...(readString(record, "completedAt", "completed_at")
        ? { completedAt: readString(record, "completedAt", "completed_at") }
        : {}),
      ...(typeof record.durationMs === "number" &&
      Number.isFinite(record.durationMs)
        ? { durationMs: Math.max(0, record.durationMs) }
        : {}),
      ...(readString(record, "error")
        ? { error: readString(record, "error") }
        : {}),
    })
  }
  return calls
}

function transcriptToolCallsBytes(
  calls: ReadonlyArray<BufferedTranscriptToolCall>
): number {
  if (calls.length === 0) return 0
  try {
    return Buffer.byteLength(JSON.stringify(calls), "utf8")
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function timestampDurationMs(
  startedAt: string,
  completedAt: string
): number | undefined {
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : undefined
}

function providerTranscriptText(
  eventType: string,
  payload: Record<string, unknown>
): string | undefined {
  if (isReplaceEvent(eventType)) {
    return payloadText(payload, "text", "content", "delta")
  }
  return payloadText(payload, "delta", "text", "content")
}

function isReplaceEvent(eventType: string): boolean {
  return eventType.endsWith("_replace") || eventType.endsWith(".replace")
}

function payloadText(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof payload[key] === "string") return payload[key]
  }
  return undefined
}

function terminalTurnStatus(eventType: string): string {
  switch (eventType) {
    case "turn_interrupted":
    case "turn.aborted":
      return "interrupted"
    case "turn_error":
      return "failed"
    default:
      return "completed"
  }
}

function providerEventMeta(event: ProviderRuntimeEvent): {
  readonly event_type: string
  readonly thread: string
} {
  return {
    event_type: event.event_type,
    thread: event.thread_id,
  }
}

function journalEntryMeta(entry: ProviderRuntimeJournalEntry): {
  readonly event_type: string
  readonly thread: string
} {
  return {
    event_type: journalEntryEventType(entry),
    thread: journalEntryThreadId(entry),
  }
}

function failureSourceOfLegacy(
  event: ProviderRuntimeEvent
): ProviderRuntimeFailureSource {
  const payload = asRecord(event.payload)
  return {
    threadId: event.thread_id,
    eventType: event.event_type,
    providerKind: readString(payload, "providerKind", "provider_kind"),
    providerInstanceId: readString(
      payload,
      "providerInstanceId",
      "provider_instance_id"
    ),
    turnId: readString(payload, "turn_id", "turnId"),
  }
}

function failureSourceOfEntry(
  entry: ProviderRuntimeJournalEntry
): ProviderRuntimeFailureSource {
  if (entry.shape === "legacy") return failureSourceOfLegacy(entry.event)
  const event = entry.event
  return {
    threadId: event.threadId,
    eventType: event.type,
    providerKind: event.providerKind,
    providerInstanceId: event.providerInstanceId,
    turnId: event.turnId,
  }
}

function providerRuntimeLogBindings(
  event: ProviderRuntimeEvent,
  eventMeta: ReturnType<typeof providerEventMeta>,
  payload: Record<string, unknown>,
  clients: number
): Record<string, unknown> {
  return {
    channel: "provider.runtimeEvent",
    event: eventMeta.event_type,
    thread: eventMeta.thread,
    turn: readString(payload, "turn_id", "turnId", "activeTurnId"),
    provider:
      readString(payload, "providerKind", "provider_kind", "provider") ??
      undefined,
    instance:
      readString(payload, "providerInstanceId", "provider_instance_id") ??
      undefined,
    tool:
      readString(payload, "tool_name", "toolName", "name", "title") ??
      undefined,
    clients,
  }
}

function reasoningStartKey(
  event: ProviderRuntimeEvent,
  payload: Record<string, unknown>
): string {
  return assistantTranscriptKey(event.thread_id, readString(payload, "turn_id", "turnId") ?? "__thread__")
}

function isToolishProviderEvent(
  eventType: string,
  payload: Record<string, unknown>
): boolean {
  if (
    eventType === "tool_call" ||
    eventType === "tool_call_delta" ||
    eventType === "tool_result" ||
    eventType.startsWith("tool.")
  ) {
    return true
  }
  const itemType = readString(payload, "itemType", "item_type", "type")
    ?.trim()
    .toLowerCase()
  return Boolean(
    itemType &&
      ["tool", "command", "file", "search", "read", "write", "patch"].some(
        (part) => itemType.includes(part)
      )
  )
}

function providerMetadataTitle(payload: unknown): string | null {
  const record = asRecord(payload)
  const title = record.name ?? record.title
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : null
}

function providerMetadataUpdatedAt(payload: unknown): string | undefined {
  const record = asRecord(payload)
  const updatedAt =
    record.updatedAt ??
    record.updated_at ??
    record.createdAt ??
    record.created_at
  return typeof updatedAt === "string" && updatedAt.length > 0
    ? updatedAt
    : undefined
}

function proposedPlanBufferKey(
  event: ProviderRuntimeEvent,
  payload: Record<string, unknown>
): string | null {
  const planKey =
    readString(payload, "planId", "plan_id") ??
    readString(payload, "turn_id", "turnId") ??
    readString(payload, "itemId", "item_id") ??
    "__thread__"
  return planKey.length > 0 ? assistantTranscriptKey(event.thread_id, planKey) : null
}

function compactProvider(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function providerKindFromPayload(
  payload: Record<string, unknown>
): ProviderRuntimeLifecycleKind | undefined {
  const explicit = readString(payload, "providerKind", "provider_kind")
  const provider = readString(payload, "provider")
  return canonicalProviderKindAlias(explicit ?? provider) ?? undefined
}

function sourceProposedPlanImplementedActivityId(
  input: SourceProposedPlanImplementationInput
): string {
  return [
    input.sourceProposedPlan.threadId,
    "turn.proposed.implemented",
    input.sourceProposedPlan.planId,
    input.implementationThreadId,
  ]
    .map((part) => part.replace(/\s+/g, "_"))
    .join("::")
}

function sourcePlanImplementationMatches(
  pending: SourceProposedPlanImplementationInput,
  input: {
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId?: string | null
  }
): boolean {
  if (
    input.providerKind &&
    pendingProviderKindKey(pending.providerKind) !==
      pendingProviderKindKey(input.providerKind)
  ) {
    return false
  }
  if (
    input.acceptedTurnId &&
    pending.acceptedTurnId !== input.acceptedTurnId
  ) {
    return false
  }
  if (
    pending.providerInstanceId &&
    input.providerInstanceId &&
    pending.providerInstanceId !== input.providerInstanceId
  ) {
    return false
  }
  if (pending.providerInstanceId && !input.providerInstanceId) return false
  return true
}

function pendingProviderKindKey(value: string): string {
  const key = compactProvider(value)
  switch (key) {
    case "codexcli":
      return "codex_cli"
    case "claudeagent":
    case "claudecli":
      return "claude"
    case "anthropiccli":
      return "anthropic_cli"
    default:
      return key
  }
}

interface ProviderSessionLifecycleTarget {
  readonly threadId: string
  readonly providerKind: ProviderRuntimeLifecycleKind
  readonly providerInstanceId: string
  readonly turnId?: string
  readonly runtimeMode?: string
  readonly payload: Record<string, unknown>
}

function providerSessionLifecycleTarget(
  event: ProviderRuntimeEvent
): ProviderSessionLifecycleTarget | null {
  const payload = asRecord(event.payload)
  const providerKind = providerKindFromPayload(payload)
  if (!providerKind) return null
  return {
    threadId: event.thread_id,
    providerKind,
    providerInstanceId:
      readString(payload, "providerInstanceId", "provider_instance_id") ??
      providerKind,
    turnId:
      readString(payload, "turn_id", "turnId") ??
      readString(payload, "activeTurnId", "active_turn_id"),
    runtimeMode: readString(payload, "runtimeMode", "runtime_mode"),
    payload,
  }
}

function providerSessionLifecycle(
  event: ProviderRuntimeEvent,
  target: ProviderSessionLifecycleTarget,
  current: ProviderRuntimeSessionLifecycleSnapshot | null
):
  | Parameters<
      ProviderRuntimeSessionLifecycleStore["updateSessionLifecycle"]
    >[0]
  | null {
  if (
    !shouldApplyThreadLifecycle(
      event.event_type,
      current?.activeTurnId ?? null,
      target.turnId
    )
  ) {
    return null
  }

  const payload = target.payload
  const base = {
    threadId: target.threadId,
    providerKind: target.providerKind,
    providerInstanceId: target.providerInstanceId,
    ...(target.runtimeMode ? { runtimeMode: target.runtimeMode } : {}),
  }

  switch (event.event_type) {
    case "session.started":
    case "thread.started":
    case "session.configured":
      return {
        ...base,
        status: current?.activeTurnId ? "running" : "ready",
        ...(current?.activeTurnId
          ? { activeTurnId: current.activeTurnId }
          : {}),
      }
    case "session.state.changed":
    case "session_state_changed": {
      const state = readString(payload, "state", "status")
      const status = sessionStatusFromRuntimeState(state)
      if (!status) return null
      return {
        ...base,
        status,
        ...(status === "error"
          ? { lastError: "Provider session entered an error state." }
          : status === "ready"
            ? { lastError: null }
            : {}),
      }
    }
    case "session.exited":
    case "session_exited": {
      return {
        ...base,
        status: "stopped",
        activeTurnId: null,
      }
    }
    case "turn_started":
    case "turn.started":
      return { ...base, status: "running", activeTurnId: target.turnId ?? null }
    case "turn_completed":
    case "turn.completed": {
      const turnState = normalizeRuntimeTurnState(
        readString(payload, "state", "status")
      )
      if (turnState === "failed") {
        return {
          ...base,
          status: "error",
          activeTurnId: null,
          lastError: "Provider turn failed.",
        }
      }
      return { ...base, status: "ready", activeTurnId: null, lastError: null }
    }
    case "turn_interrupted":
    case "turn.aborted":
      return {
        ...base,
        status: "interrupted",
        activeTurnId: null,
        lastError: "Provider turn was interrupted.",
      }
    case "turn_error":
      return {
        ...base,
        status: "error",
        activeTurnId: null,
        lastError: "Provider turn failed.",
      }
    case "runtime.error":
      return {
        ...base,
        status: "error",
        activeTurnId: target.turnId ?? null,
        lastError: "Provider runtime error.",
      }
    default:
      return null
  }
}

interface ProviderDispatchTerminalProjection {
  readonly providerInstanceId: string | null
  readonly providerTurnId: string
  readonly status: "completed" | "failed"
  readonly error: string
}

function providerDispatchTerminalProjection(
  event: ProviderRuntimeEvent
): ProviderDispatchTerminalProjection | null {
  const eventType = event.event_type.trim().toLowerCase()
  // A failed tool or status update does not settle its enclosing turn.
  if (!isTerminalJournalEventType(eventType)) return null
  const payload = event.payload
  const correlatedDispatchTurnId = readString(
    payload,
    "dispatchTurnId",
    "dispatch_turn_id"
  )
  const providerTurnId =
    correlatedDispatchTurnId ?? readString(payload, "turn_id", "turnId")
  if (!providerTurnId) return null
  const providerInstanceId =
    readString(payload, "providerInstanceId", "provider_instance_id") ?? null

  const status = readString(
    payload,
    "status",
    "state",
    "exitKind"
  )?.toLowerCase()
  const error =
    readString(payload, "error", "errorMessage", "message", "reason") ??
    (status ? `Provider turn ended with status '${status}'.` : "Provider turn failed.")
  if (
    status === "failed" ||
    status === "error" ||
    status === "timed_out" ||
    status === "interrupted" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "aborted" ||
    eventType === "turn_error" ||
    eventType === "turn_interrupted" ||
    eventType === "turn.aborted" ||
    ((eventType === "session.exited" || eventType === "session_exited") &&
      correlatedDispatchTurnId !== undefined)
  ) {
    return { providerInstanceId, providerTurnId, status: "failed", error }
  }
  if (eventType === "turn_completed" || eventType === "turn.completed") {
    return {
      providerInstanceId,
      providerTurnId,
      status: "completed",
      error: "",
    }
  }
  return null
}

function sameId(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return left != null && right != null && left === right
}

function shouldApplyThreadLifecycle(
  eventType: string,
  activeTurnId: string | null,
  eventTurnId: string | undefined
): boolean {
  const conflictsWithActiveTurn =
    activeTurnId !== null &&
    eventTurnId !== undefined &&
    !sameId(activeTurnId, eventTurnId)
  const missingTurnForActiveTurn =
    activeTurnId !== null && eventTurnId === undefined

  switch (eventType) {
    case "session.exited":
    case "session_exited":
    case "session.started":
    case "thread.started":
    case "session.configured":
      return true
    case "turn_started":
    case "turn.started":
      return !conflictsWithActiveTurn
    case "turn_completed":
    case "turn.completed":
    case "turn_interrupted":
    case "turn.aborted":
      return !(conflictsWithActiveTurn || missingTurnForActiveTurn)
    case "runtime.error":
      return (
        activeTurnId === null ||
        eventTurnId === undefined ||
        sameId(activeTurnId, eventTurnId)
      )
    case "turn_error":
      return !conflictsWithActiveTurn
    default:
      return true
  }
}

function normalizeRuntimeTurnState(
  state: string | undefined
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (state) {
    case "failed":
    case "error":
    case "timed_out":
      return "failed"
    case "interrupted":
      return "interrupted"
    case "cancelled":
    case "canceled":
    case "stopped":
      return "cancelled"
    default:
      return "completed"
  }
}

function sessionStatusFromRuntimeState(
  state: string | undefined
): ProviderRuntimeLifecycleStatus | null {
  switch (state) {
    case "starting":
      return "starting"
    case "running":
    case "waiting":
      return "running"
    case "ready":
      return "ready"
    case "interrupted":
      return "interrupted"
    case "stopped":
      return "stopped"
    case "closed":
      return "closed"
    case "error":
      return "error"
    default:
      return null
  }
}

function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(code)
}

function appendedUtf8Bytes(previous: string, previousBytes: number, delta: string): number {
  // A surrogate pair split across provider deltas encodes to four bytes, not
  // the six replacement-character bytes counted by the fragments separately.
  const joinsPair = /[\uD800-\uDBFF]$/.test(previous.slice(-1)) && /^[\uDC00-\uDFFF]/.test(delta)
  return previousBytes + Buffer.byteLength(delta, "utf8") - (joinsPair ? 2 : 0)
}
