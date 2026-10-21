import type { LegacyProviderEvent } from "../provider/types"
import {
  captureCheckpoint,
  deleteCheckpointRefs,
  diffCheckpoints,
  hasCheckpointRef,
  isGitOutputLimitError,
  isRepo,
  summarizeCheckpointDiff,
  type CaptureCheckpointInput,
  type CheckpointDiffSummary,
  type DiffCheckpointsInput,
} from "../services/git"
import { isProjectSnapshotEnabled } from "../services/workspace"
import {
  checkpointRefForThreadTurn,
  parseTurnDiffFilesFromUnifiedDiff,
  type TurnDiffFileSummary,
} from "@betterc0de/schema"
import type { CheckpointRefCleanupIntent } from "./CheckpointRefCleanupStore"
import type { CheckpointRefOperationGate } from "./CheckpointRefOperationGate"

/**
 * The reactor observes the `"projected"` lane: the legacy view ingestion
 * publishes after it has processed an event — journaled first whenever
 * journaling applies (with auto-save off, or for transcript-lane deltas,
 * there is no journal row, but the reactor still needs `turn_started`). Its
 * own emissions (`turn.diff.updated`, `checkpoint.captured`) go out on the
 * raw `"event"` lane and come back through ingestion like any other event.
 */
export interface ProviderRuntimeEventBusLike {
  on(
    eventName: "projected",
    listener: (event: LegacyProviderEvent) => void
  ): unknown
  off(
    eventName: "projected",
    listener: (event: LegacyProviderEvent) => void
  ): unknown
  emitEvent?(event: LegacyProviderEvent): void
}

export interface CheckpointReactorThreadStore {
  getThreadProjectPath(threadId: string): string | null
}

export interface CheckpointReactorLogger {
  warn(bindings: Record<string, unknown>, message: string): void
  error(bindings: Record<string, unknown>, message: string): void
}

export interface CheckpointRefCleanupJournal {
  enqueue(input: {
    threadId: string
    cwd: string
    checkpointRefs: readonly string[]
  }): readonly CheckpointRefCleanupIntent[] | void
  complete?(cwd: string, checkpointRefs: readonly string[]): void
  completeIntent?(intent: CheckpointRefCleanupIntent): boolean
  recordFailure?(cwd: string, checkpointRef: string, error: unknown): void
  recordIntentFailure?(
    intent: CheckpointRefCleanupIntent,
    error: unknown
  ): boolean
  retainBaseline?(input: {
    threadId: string
    cwd: string
    checkpointRef: string
  }): unknown
  getBaseline?(threadId: string): {
    readonly cwd: string
    readonly checkpointRef: string
  } | null
}

export interface DurableCheckpointTurnAdmission {
  readonly threadId: string
  readonly turnKey: string
  readonly turnId: string | null
  readonly dispatchTurnId: string | null
  readonly turnCount: number
  readonly cwd: string
  readonly baseCheckpointRef: string
  readonly checkpointRef: string
}

export interface CheckpointReactorOptions {
  readonly eventBus: ProviderRuntimeEventBusLike
  readonly threads: CheckpointReactorThreadStore
  readonly logger: CheckpointReactorLogger
  readonly captureCheckpoint?: (input: CaptureCheckpointInput) => Promise<void>
  readonly diffCheckpoints?: (
    input: DiffCheckpointsInput
  ) => Promise<{ diff: string; truncated?: boolean }>
  readonly hasCheckpointRef?: (input: {
    cwd: string
    checkpointRef: string
  }) => Promise<boolean>
  readonly summarizeCheckpointDiff?: (
    input: DiffCheckpointsInput
  ) => Promise<CheckpointDiffSummary>
  readonly deleteCheckpointRefs?: (input: {
    cwd: string
    checkpointRefs: string[]
  }) => Promise<void>
  readonly isGitRepo?: (cwd: string) => Promise<boolean>
  readonly isSnapshotEnabled?: (cwd: string) => Promise<boolean>
  readonly emitEvent?: (event: LegacyProviderEvent) => void
  readonly cleanupJournal?: CheckpointRefCleanupJournal
  readonly refOperationGate?: CheckpointRefOperationGate
  readonly allocateTurnSlot?: (
    threadId: string,
    explicitTurnIndex?: number
  ) => { readonly slot: number; readonly turnCount: number }
  readonly reconcileTurnSlot?: (threadId: string) => void
  readonly recordTurnAdmission?: (
    admission: DurableCheckpointTurnAdmission
  ) => void
  readonly completeTurnAdmission?: (input: {
    readonly threadId: string
    readonly turnKey: string
    readonly turnCount: number
    readonly checkpointRef: string
  }) => void
  readonly failTurnAdmission?: (
    threadId: string,
    turnKey: string,
    error: unknown
  ) => void
  readonly listTurnAdmissions?: () => readonly DurableCheckpointTurnAdmission[]
}

interface PendingCheckpoint {
  readonly key: string
  readonly threadId: string
  readonly turnId: string | null
  readonly dispatchTurnId: string | null
  readonly checkpointTurnCount: number
  readonly cwd: string
  readonly baseCheckpointRef: string
  readonly checkpointRef: string
  readonly baseline: Promise<readonly CheckpointRefCleanupIntent[]>
  baselineRetained: boolean
  admissionRecorded: boolean
}

const MAX_FORGOTTEN_THREAD_TOMBSTONES = 4_096
const MAX_TERMINAL_FAILURES = 4_096
/** The only event types `ingestSerial` acts on; everything else is a no-op. */
const CHECKPOINT_REACTOR_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn_started",
  "turn_completed",
  "turn_interrupted",
  "turn.aborted",
  "session.exited",
  "turn_error",
])

export class CheckpointReactor {
  private readonly pending = new Map<string, PendingCheckpoint>()
  private readonly localTurnSlots = new Map<string, number>()
  private readonly queuesByThread = new Map<string, Promise<void>>()
  private readonly threadTokens = new Map<string, symbol>()
  private readonly forgottenThreads = new Set<string>()
  private readonly terminalFailures = new Map<string, unknown>()
  private generation = 0
  private unsubscribe: (() => void) | null = null
  private stopped = false
  private stopPromise: Promise<void> | null = null

  private readonly captureCheckpointFn: (
    input: CaptureCheckpointInput
  ) => Promise<void>
  private readonly diffCheckpointsFn: (
    input: DiffCheckpointsInput
  ) => Promise<{ diff: string; truncated?: boolean }>
  private readonly hasCheckpointRefFn: (input: {
    cwd: string
    checkpointRef: string
  }) => Promise<boolean>
  private readonly summarizeCheckpointDiffFn: (
    input: DiffCheckpointsInput
  ) => Promise<CheckpointDiffSummary>
  private readonly deleteCheckpointRefsFn: (input: {
    cwd: string
    checkpointRefs: string[]
  }) => Promise<void>
  private readonly isGitRepoFn: (cwd: string) => Promise<boolean>
  private readonly isSnapshotEnabledFn: (cwd: string) => Promise<boolean>

  constructor(private readonly options: CheckpointReactorOptions) {
    this.captureCheckpointFn = options.captureCheckpoint ?? captureCheckpoint
    this.diffCheckpointsFn = options.diffCheckpoints ?? diffCheckpoints
    this.hasCheckpointRefFn =
      options.hasCheckpointRef ??
      (options.captureCheckpoint ? async () => false : hasCheckpointRef)
    this.summarizeCheckpointDiffFn =
      options.summarizeCheckpointDiff ?? summarizeCheckpointDiff
    this.deleteCheckpointRefsFn =
      options.deleteCheckpointRefs ??
      (options.captureCheckpoint ? async () => undefined : deleteCheckpointRefs)
    this.isGitRepoFn =
      options.isGitRepo ?? (async (cwd) => (await isRepo(cwd)).is_repo)
    this.isSnapshotEnabledFn =
      options.isSnapshotEnabled ?? isProjectSnapshotEnabled
  }

  start(): () => void {
    if (this.unsubscribe) {
      return () => {
        void this.stop()
      }
    }
    this.stopped = false
    this.stopPromise = null
    const listener = (event: LegacyProviderEvent) => {
      void this.observe(event).catch((err) => {
        this.options.logger.error(
          { err, event_type: event.event_type, thread: event.thread_id },
          "checkpoint reactor failed to ingest provider event"
        )
      })
    }
    this.options.eventBus.on("projected", listener)
    this.unsubscribe = () => {
      this.options.eventBus.off("projected", listener)
      this.unsubscribe = null
    }
    return () => {
      void this.stop()
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopInternal()
    return this.stopPromise
  }

  private async stopInternal(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.generation += 1
    this.threadTokens.clear()
    await Promise.allSettled([...this.queuesByThread.values()])
    const pending = [...this.pending.values()]
    this.pending.clear()
    await Promise.allSettled(
      pending.map(async (checkpoint) => {
        await checkpoint.baseline.catch(() => undefined)
        if (checkpoint.admissionRecorded) {
          this.markAdmissionFailed(
            checkpoint,
            new Error(
              "Backend stopped before the admitted checkpoint turn reached a durable boundary."
            )
          )
          return
        }
        await this.cleanupBaselineRef(checkpoint)
        this.reconcileTurnSlot(checkpoint.threadId)
      })
    )
    this.localTurnSlots.clear()
    this.queuesByThread.clear()
    this.forgottenThreads.clear()
    this.terminalFailures.clear()
  }

  async forgetThread(threadId: string): Promise<void> {
    this.rememberForgottenThread(threadId)
    this.threadTokens.delete(threadId)
    await this.queuesByThread.get(threadId)?.catch(() => undefined)
    const cleanup: Promise<void>[] = []
    for (const [key, pending] of this.pending) {
      if (pending.threadId === threadId) {
        this.pending.delete(key)
        cleanup.push(
          pending.baseline
            .catch(() => undefined)
            .then(() => this.cleanupBaselineRef(pending))
        )
      }
    }
    await Promise.allSettled(cleanup)
    this.localTurnSlots.delete(threadId)
    this.queuesByThread.delete(threadId)
    for (const key of this.terminalFailures.keys()) {
      if (key.startsWith(`${JSON.stringify(threadId)}::`))
        this.terminalFailures.delete(key)
    }
  }

  isCheckpointRefActive(checkpointRef: string): boolean {
    for (const pending of this.pending.values()) {
      if (
        pending.baseCheckpointRef === checkpointRef ||
        pending.checkpointRef === checkpointRef
      ) {
        return true
      }
    }
    return false
  }

  /**
   * Recover turns that crossed the durable pre-turn admission barrier but did
   * not project their post-turn diff before the previous process exited.
   * Startup invokes this before cleanup workers or HTTP admission begin.
   */
  async recoverPendingAdmissions(): Promise<number> {
    const admissions = this.options.listTurnAdmissions?.() ?? []
    let recovered = 0
    for (const admission of admissions) {
      const retainedBaseline =
        this.options.cleanupJournal?.getBaseline?.(admission.threadId) ?? null
      const pending: PendingCheckpoint = {
        key: admission.turnKey,
        threadId: admission.threadId,
        turnId: admission.turnId,
        dispatchTurnId: admission.dispatchTurnId,
        checkpointTurnCount: admission.turnCount,
        cwd: admission.cwd,
        baseCheckpointRef: admission.baseCheckpointRef,
        checkpointRef: admission.checkpointRef,
        baseline: Promise.resolve([]),
        baselineRetained:
          retainedBaseline?.cwd === admission.cwd &&
          retainedBaseline.checkpointRef === admission.baseCheckpointRef,
        admissionRecorded: true,
      }
      try {
        await this.withCheckpointRefLocks(
          pending.cwd,
          [pending.checkpointRef],
          async () => {
            this.options.cleanupJournal?.enqueue({
              threadId: pending.threadId,
              cwd: pending.cwd,
              checkpointRefs: [pending.checkpointRef],
            })
            const checkpointAlreadyCaptured = await this.hasCheckpointRefFn({
              cwd: pending.cwd,
              checkpointRef: pending.checkpointRef,
            })
            if (!checkpointAlreadyCaptured) {
              await this.captureCheckpointFn({
                cwd: pending.cwd,
                checkpointRef: pending.checkpointRef,
              })
            }
          }
        )
        const { diff, files, truncated, totalFiles, filesTruncated } =
          await this.loadCheckpointDiff({
            cwd: pending.cwd,
            fromCheckpointRef: pending.baseCheckpointRef,
            toCheckpointRef: pending.checkpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
          })
        const recoveryEvent: LegacyProviderEvent = {
          event_type: "turn_interrupted",
          thread_id: pending.threadId,
          payload: {
            ...(pending.turnId ? { turn_id: pending.turnId } : {}),
            ...(pending.dispatchTurnId
              ? { dispatchTurnId: pending.dispatchTurnId }
              : {}),
            recovery: "checkpoint_admission_recovered_after_restart",
          },
        }
        this.emitDiffUpdated(
          recoveryEvent,
          pending,
          diff,
          files,
          truncated,
          totalFiles,
          filesTruncated
        )
        this.emitCheckpointCaptured(
          recoveryEvent,
          pending,
          "error",
          files,
          truncated,
          totalFiles,
          filesTruncated
        )
        this.completeAdmission(pending)
        pending.admissionRecorded = false
        if (!pending.baselineRetained) {
          await this.cleanupCheckpointRefs(pending, [pending.baseCheckpointRef])
        }
        recovered += 1
      } catch (error) {
        const admissionFailure = this.markAdmissionFailed(pending, error)
        throw admissionFailure
          ? new AggregateError(
              [error, admissionFailure],
              `Failed to recover checkpoint admission '${pending.key}' for thread '${pending.threadId}'.`
            )
          : error
      }
    }
    return recovered
  }

  async ingest(event: LegacyProviderEvent): Promise<void> {
    await this.enqueueEvent(event, false, false, false)
  }

  /**
   * Awaited admission hook used immediately before a provider is allowed to
   * mutate the workspace. Unlike the event-bus observer, capture failures
   * propagate to the caller and prevent provider dispatch.
   */
  async prepareTurn(event: LegacyProviderEvent): Promise<void> {
    await this.enqueueEvent(event, true, false, false)
  }

  /**
   * Awaited terminal hook. Event-bus ingestion may have observed the same
   * terminal event first, so completion failures are retained long enough for
   * this durability barrier to report the original failure to the turn owner.
   */
  async finalizeTurn(event: LegacyProviderEvent): Promise<void> {
    await this.enqueueEvent(event, false, true, false)
  }

  private async observe(event: LegacyProviderEvent): Promise<void> {
    await this.enqueueEvent(event, false, false, true)
  }

  private async enqueueEvent(
    event: LegacyProviderEvent,
    requireBaseline: boolean,
    propagateTerminalFailure: boolean,
    deferTerminalCapture: boolean
  ): Promise<void> {
    if (this.stopped || this.forgottenThreads.has(event.thread_id)) return
    // Every provider event reaches this observer, including each streamed
    // token. Only lifecycle events do any work in ingestSerial, so bail before
    // allocating a token, two map writes and a promise link per delta.
    if (!CHECKPOINT_REACTOR_EVENT_TYPES.has(event.event_type)) return
    const generation = this.generation
    const threadToken =
      this.threadTokens.get(event.thread_id) ?? Symbol(event.thread_id)
    this.threadTokens.set(event.thread_id, threadToken)
    const previous =
      this.queuesByThread.get(event.thread_id) ?? Promise.resolve()
    const queued = previous
      .catch(() => undefined)
      .then(() =>
        this.ingestSerial(
          event,
          generation,
          threadToken,
          requireBaseline,
          propagateTerminalFailure,
          deferTerminalCapture
        )
      )
    this.queuesByThread.set(event.thread_id, queued)
    try {
      await queued
    } finally {
      if (this.queuesByThread.get(event.thread_id) === queued) {
        this.queuesByThread.delete(event.thread_id)
        if (this.threadTokens.get(event.thread_id) === threadToken) {
          this.threadTokens.delete(event.thread_id)
        }
      }
    }
  }

  private async ingestSerial(
    event: LegacyProviderEvent,
    generation: number,
    threadToken: symbol,
    requireBaseline: boolean,
    propagateTerminalFailure: boolean,
    deferTerminalCapture: boolean
  ): Promise<void> {
    if (!this.isCurrentGeneration(event.thread_id, generation, threadToken)) {
      return
    }
    if (event.event_type === "turn_started") {
      await this.captureBaseline(
        event,
        generation,
        threadToken,
        requireBaseline
      )
      return
    }

    if (event.event_type === "turn_completed") {
      if (deferTerminalCapture) return
      await this.captureCompletion(
        event,
        isFailedTurnStatus(event.payload) ? "error" : "ready",
        generation,
        threadToken
      )
      if (propagateTerminalFailure) this.throwTerminalFailure(event)
      return
    }

    if (
      event.event_type === "turn_interrupted" ||
      event.event_type === "turn.aborted" ||
      event.event_type === "session.exited"
    ) {
      if (deferTerminalCapture) return
      await this.captureCompletion(event, "error", generation, threadToken)
      if (propagateTerminalFailure) this.throwTerminalFailure(event)
      return
    }

    if (event.event_type === "turn_error") {
      if (isFailedTurnStatus(event.payload)) {
        if (deferTerminalCapture) return
        await this.captureCompletion(event, "error", generation, threadToken)
        if (propagateTerminalFailure) this.throwTerminalFailure(event)
      }
    }
  }

  private async captureBaseline(
    event: LegacyProviderEvent,
    generation: number,
    threadToken: symbol,
    requireBaseline: boolean
  ): Promise<void> {
    const key = turnKey(event)
    if (!key) return
    const mapKey = pendingMapKey(event.thread_id, key)
    if (this.pending.has(mapKey)) return

    const cwd = resolveCwd(event, this.options.threads)
    if (!cwd) return

    let snapshotEnabled = true
    try {
      snapshotEnabled = await this.isSnapshotEnabledFn(cwd)
    } catch {
      snapshotEnabled = true
    }
    if (!this.isCurrentGeneration(event.thread_id, generation, threadToken)) {
      return
    }
    if (!snapshotEnabled) return

    let isGit = false
    try {
      isGit = await this.isGitRepoFn(cwd)
    } catch (error) {
      if (requireBaseline) throw error
      isGit = false
    }
    if (!this.isCurrentGeneration(event.thread_id, generation, threadToken)) {
      return
    }
    if (!isGit) return

    const turnIndex = payloadNumber(event.payload, "turn_index", "turnIndex")
    let slot: number
    let checkpointTurnCount: number
    try {
      if (this.options.allocateTurnSlot) {
        const allocated = this.options.allocateTurnSlot(
          event.thread_id,
          turnIndex
        )
        slot = allocated.slot
        checkpointTurnCount = allocated.turnCount
      } else if (turnIndex !== undefined) {
        slot = Math.max(0, Math.trunc(turnIndex) - 1)
        checkpointTurnCount = slot + 1
        this.observeLocalTurnSlot(event.thread_id, checkpointTurnCount)
      } else {
        slot = this.nextLocalTurnSlot(event.thread_id)
        checkpointTurnCount = slot + 1
      }
    } catch (err) {
      this.options.logger.error(
        { err, thread: event.thread_id },
        "failed to allocate durable checkpoint turn slot"
      )
      if (requireBaseline) throw err
      return
    }
    const baseCheckpointRef = checkpointRefForThreadTurn(
      event.thread_id,
      slot * 2
    )
    const checkpointRef = checkpointRefForThreadTurn(
      event.thread_id,
      slot * 2 + 1
    )
    const retainedBaseline =
      checkpointTurnCount === 1
        ? this.options.cleanupJournal?.getBaseline?.(event.thread_id)
        : null
    if (
      retainedBaseline &&
      (retainedBaseline.cwd !== cwd ||
        retainedBaseline.checkpointRef !== baseCheckpointRef)
    ) {
      throw new Error(
        `Thread '${event.thread_id}' has an incompatible retained checkpoint baseline.`
      )
    }
    const baseline =
      retainedBaseline != null
        ? Promise.resolve([] as readonly CheckpointRefCleanupIntent[])
        : this.withCheckpointRefLocks(cwd, [baseCheckpointRef], async () => {
            const intents =
              this.options.cleanupJournal?.enqueue({
                threadId: event.thread_id,
                cwd,
                checkpointRefs: [baseCheckpointRef],
              }) ?? []
            await this.captureCheckpointFn({
              cwd,
              checkpointRef: baseCheckpointRef,
            })
            return intents
          })

    const pending: PendingCheckpoint = {
      key,
      threadId: event.thread_id,
      turnId: payloadString(event.payload, "turn_id", "turnId") ?? null,
      dispatchTurnId:
        payloadString(event.payload, "dispatchTurnId", "dispatch_turn_id") ??
        null,
      checkpointTurnCount,
      cwd,
      baseCheckpointRef,
      checkpointRef,
      baseline,
      baselineRetained: retainedBaseline != null,
      admissionRecorded: false,
    }
    this.terminalFailures.delete(mapKey)
    this.pending.set(mapKey, pending)

    try {
      const baselineIntents = await baseline
      if (!this.isCurrentGeneration(event.thread_id, generation, threadToken)) {
        if (this.pending.get(mapKey) === pending) {
          this.pending.delete(mapKey)
        }
        await this.cleanupBaselineRef(pending)
        this.reconcileTurnSlot(event.thread_id)
        return
      }
      if (
        !pending.baselineRetained &&
        pending.checkpointTurnCount === 1 &&
        this.options.cleanupJournal?.retainBaseline
      ) {
        this.options.cleanupJournal.retainBaseline({
          threadId: pending.threadId,
          cwd: pending.cwd,
          checkpointRef: pending.baseCheckpointRef,
        })
        pending.baselineRetained = true
        this.completeCleanupIntents(baselineIntents)
      }
      if (this.options.recordTurnAdmission) {
        this.options.recordTurnAdmission({
          threadId: pending.threadId,
          turnKey: pending.key,
          turnId: pending.turnId,
          dispatchTurnId: pending.dispatchTurnId,
          turnCount: pending.checkpointTurnCount,
          cwd: pending.cwd,
          baseCheckpointRef: pending.baseCheckpointRef,
          checkpointRef: pending.checkpointRef,
        })
        pending.admissionRecorded = true
      }
    } catch (err) {
      if (this.pending.get(mapKey) === pending) {
        this.pending.delete(mapKey)
      }
      await this.cleanupBaselineRef(pending)
      this.reconcileTurnSlot(event.thread_id)
      this.options.logger.warn(
        { err, thread: event.thread_id, cwd, checkpointRef: baseCheckpointRef },
        "failed to capture checkpoint baseline"
      )
      if (requireBaseline) throw err
    }
  }

  private async captureCompletion(
    event: LegacyProviderEvent,
    status: "ready" | "missing" | "error",
    generation: number,
    threadToken: symbol
  ): Promise<void> {
    const key = turnKey(event)
    if (!key) return
    const mapKey = pendingMapKey(event.thread_id, key)
    const pending = this.pending.get(mapKey)
    if (!pending) return

    let outputAttempted = false
    let completed = false
    const failures: unknown[] = []
    try {
      await pending.baseline
      if (!this.isCurrentGeneration(event.thread_id, generation, threadToken)) {
        return
      }
      outputAttempted = true
      await this.withCheckpointRefLocks(
        pending.cwd,
        [pending.checkpointRef],
        async () => {
          this.options.cleanupJournal?.enqueue({
            threadId: pending.threadId,
            cwd: pending.cwd,
            checkpointRefs: [pending.checkpointRef],
          })
          await this.captureCheckpointFn({
            cwd: pending.cwd,
            checkpointRef: pending.checkpointRef,
          })
        }
      )
      if (!this.isCurrentGeneration(event.thread_id, generation, threadToken)) {
        return
      }
      const { diff, files, truncated, totalFiles, filesTruncated } =
        await this.loadCheckpointDiff({
          cwd: pending.cwd,
          fromCheckpointRef: pending.baseCheckpointRef,
          toCheckpointRef: pending.checkpointRef,
          fallbackFromToHead: false,
          ignoreWhitespace: false,
        })
      if (!this.isCurrentGeneration(event.thread_id, generation, threadToken)) {
        return
      }
      this.emitDiffUpdated(
        event,
        pending,
        diff,
        files,
        truncated,
        totalFiles,
        filesTruncated
      )
      this.emitCheckpointCaptured(
        event,
        pending,
        status,
        files,
        truncated,
        totalFiles,
        filesTruncated
      )
      this.completeAdmission(pending)
      pending.admissionRecorded = false
      completed = true
    } catch (err) {
      failures.push(err)
      const admissionFailure = this.markAdmissionFailed(pending, err)
      if (admissionFailure) failures.push(admissionFailure)
      this.options.logger.warn(
        { err, thread: pending.threadId, cwd: pending.cwd },
        "failed to capture turn checkpoint completion"
      )
    } finally {
      if (this.pending.get(mapKey) === pending) {
        this.pending.delete(mapKey)
      }
      try {
        // An admitted turn's baseline is recovery state. Never delete it
        // until its output diff has been durably projected and acknowledged.
        if (completed || !pending.admissionRecorded) {
          await this.cleanupCheckpointRefs(pending, [
            ...(!pending.baselineRetained ? [pending.baseCheckpointRef] : []),
            ...(!completed && outputAttempted ? [pending.checkpointRef] : []),
          ])
        }
      } catch (err) {
        failures.push(err)
      }
    }
    if (failures.length === 0) {
      this.terminalFailures.delete(mapKey)
      return
    }
    this.rememberTerminalFailure(
      mapKey,
      failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "Checkpoint completion and cleanup both failed"
          )
    )
    if (!pending.admissionRecorded) {
      this.reconcileTurnSlot(event.thread_id)
    }
  }

  private async cleanupBaselineRef(pending: PendingCheckpoint): Promise<void> {
    if (pending.baselineRetained) return
    await this.cleanupCheckpointRefs(pending, [pending.baseCheckpointRef])
  }

  private async cleanupCheckpointRefs(
    pending: PendingCheckpoint,
    checkpointRefs: string[]
  ): Promise<void> {
    const uniqueRefs = [...new Set(checkpointRefs)].sort()
    if (uniqueRefs.length === 0) return
    await this.withCheckpointRefLocks(pending.cwd, uniqueRefs, async () => {
      const intents =
        this.options.cleanupJournal?.enqueue({
          threadId: pending.threadId,
          cwd: pending.cwd,
          checkpointRefs: uniqueRefs,
        }) ?? []
      try {
        await this.deleteCheckpointRefsFn({
          cwd: pending.cwd,
          checkpointRefs: uniqueRefs,
        })
        if (intents.length > 0 && this.options.cleanupJournal?.completeIntent) {
          for (const intent of intents) {
            this.options.cleanupJournal.completeIntent(intent)
          }
        } else {
          this.options.cleanupJournal?.complete?.(pending.cwd, uniqueRefs)
        }
      } catch (err) {
        for (const checkpointRef of uniqueRefs) {
          const intent = intents.find(
            (candidate) => candidate.checkpointRef === checkpointRef
          )
          if (intent && this.options.cleanupJournal?.recordIntentFailure) {
            this.options.cleanupJournal.recordIntentFailure(intent, err)
          } else {
            this.options.cleanupJournal?.recordFailure?.(
              pending.cwd,
              checkpointRef,
              err
            )
          }
        }
        this.options.logger.warn(
          {
            err,
            thread: pending.threadId,
            checkpointRefs: uniqueRefs,
          },
          "failed to clean up checkpoint refs"
        )
      }
    })
  }

  private completeCleanupIntents(
    intents: readonly CheckpointRefCleanupIntent[]
  ): void {
    for (const intent of intents) {
      if (this.options.cleanupJournal?.completeIntent) {
        this.options.cleanupJournal.completeIntent(intent)
      } else {
        this.options.cleanupJournal?.complete?.(intent.cwd, [
          intent.checkpointRef,
        ])
      }
    }
  }

  private completeAdmission(pending: PendingCheckpoint): void {
    if (!pending.admissionRecorded) return
    if (!this.options.completeTurnAdmission) {
      throw new Error(
        `Checkpoint admission '${pending.key}' cannot be completed without a durable admission store.`
      )
    }
    this.options.completeTurnAdmission({
      threadId: pending.threadId,
      turnKey: pending.key,
      turnCount: pending.checkpointTurnCount,
      checkpointRef: pending.checkpointRef,
    })
  }

  private markAdmissionFailed(
    pending: PendingCheckpoint,
    error: unknown
  ): unknown | null {
    if (!pending.admissionRecorded) return null
    try {
      this.options.failTurnAdmission?.(pending.threadId, pending.key, error)
      return null
    } catch (admissionError) {
      this.options.logger.error(
        {
          err: admissionError,
          thread: pending.threadId,
          turnKey: pending.key,
        },
        "failed to persist checkpoint admission failure"
      )
      return admissionError
    }
  }

  private async withCheckpointRefLocks<T>(
    cwd: string,
    checkpointRefs: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const gate = this.options.refOperationGate
    if (!gate || checkpointRefs.length === 0) return operation()
    const refs = [...new Set(checkpointRefs)].sort()
    const acquire = (index: number): Promise<T> => {
      const checkpointRef = refs[index]
      if (checkpointRef === undefined) return operation()
      return gate.withRef(cwd, checkpointRef, () => acquire(index + 1))
    }
    return acquire(0)
  }

  private observeLocalTurnSlot(threadId: string, nextSlot: number): void {
    this.localTurnSlots.set(
      threadId,
      Math.max(this.localTurnSlots.get(threadId) ?? 0, nextSlot)
    )
  }

  private reconcileTurnSlot(threadId: string): void {
    try {
      this.options.reconcileTurnSlot?.(threadId)
    } catch (err) {
      this.options.logger.error(
        { err, thread: threadId },
        "failed to reconcile durable checkpoint turn slot"
      )
    }
  }

  private isCurrentGeneration(
    threadId: string,
    generation: number,
    threadToken: symbol
  ): boolean {
    return (
      generation === this.generation &&
      threadToken === this.threadTokens.get(threadId)
    )
  }

  private rememberForgottenThread(threadId: string): void {
    // IDs are immutable, and the thread store still rejects any late event
    // after an old tombstone is evicted. Keep a bounded hot set to suppress
    // events already queued around teardown without retaining every deleted
    // thread for the lifetime of the backend.
    this.forgottenThreads.delete(threadId)
    this.forgottenThreads.add(threadId)
    while (this.forgottenThreads.size > MAX_FORGOTTEN_THREAD_TOMBSTONES) {
      const oldest = this.forgottenThreads.values().next().value
      if (oldest === undefined) break
      this.forgottenThreads.delete(oldest)
    }
  }

  private rememberTerminalFailure(mapKey: string, error: unknown): void {
    this.terminalFailures.delete(mapKey)
    this.terminalFailures.set(mapKey, error)
    while (this.terminalFailures.size > MAX_TERMINAL_FAILURES) {
      const oldest = this.terminalFailures.keys().next().value
      if (oldest === undefined) break
      this.terminalFailures.delete(oldest)
    }
  }

  private throwTerminalFailure(event: LegacyProviderEvent): void {
    const key = turnKey(event)
    if (!key) return
    const mapKey = pendingMapKey(event.thread_id, key)
    if (!this.terminalFailures.has(mapKey)) return
    throw this.terminalFailures.get(mapKey)
  }

  private nextLocalTurnSlot(threadId: string): number {
    const next = this.localTurnSlots.get(threadId) ?? 0
    this.localTurnSlots.set(threadId, next + 1)
    return next
  }

  private async loadCheckpointDiff(input: DiffCheckpointsInput): Promise<{
    diff: string
    files: TurnDiffFileSummary[]
    truncated: boolean
    totalFiles?: number
    filesTruncated?: boolean
  }> {
    // `diffCheckpoints` now bounds its own output (2 MB) and reports
    // `truncated` instead of throwing; a partial patch must not be stored as
    // if it were the whole turn, so fall back to the file summary either way.
    try {
      const { diff, truncated } = await this.diffCheckpointsFn(input)
      if (!truncated) {
        return {
          diff,
          files: [...parseTurnDiffFilesFromUnifiedDiff(diff)],
          truncated: false,
        }
      }
    } catch (error) {
      if (!isGitOutputLimitError(error)) throw error
    }
    {
      const summary = await this.summarizeCheckpointDiffFn(input)
      this.options.logger.warn(
        {
          cwd: input.cwd,
          files: summary.totalFiles,
          filesTruncated: summary.filesTruncated,
        },
        "checkpoint patch exceeded the output limit; retaining a bounded file summary"
      )
      return {
        diff: "",
        files: [...summary.files],
        truncated: true,
        totalFiles: summary.totalFiles,
        filesTruncated: summary.filesTruncated,
      }
    }
  }

  private emitDiffUpdated(
    event: LegacyProviderEvent,
    pending: PendingCheckpoint,
    unifiedDiff: string,
    files: TurnDiffFileSummary[],
    truncated = false,
    totalFiles?: number,
    filesTruncated?: boolean
  ): void {
    this.emit({
      event_type: "turn.diff.updated",
      thread_id: pending.threadId,
      payload: {
        ...providerPayloadFields(event.payload),
        source: "checkpoint_reactor",
        unifiedDiff,
        files,
        ...(truncated
          ? {
              diffTruncated: true,
              diffTruncationReason: "output_limit",
              diffFileCount: totalFiles ?? files.length,
              diffFilesTruncated: filesTruncated === true,
            }
          : {}),
        checkpointRef: pending.checkpointRef,
        baseCheckpointRef: pending.baseCheckpointRef,
        ...(pending.turnId ? { turn_id: pending.turnId } : {}),
        turn_index: pending.checkpointTurnCount,
        checkpointTurnCount: pending.checkpointTurnCount,
      },
    })
  }

  private emitCheckpointCaptured(
    event: LegacyProviderEvent,
    pending: PendingCheckpoint,
    status: "ready" | "missing" | "error",
    files: TurnDiffFileSummary[],
    truncated = false,
    totalFiles?: number,
    filesTruncated?: boolean
  ): void {
    this.emit({
      event_type: "checkpoint.captured",
      thread_id: pending.threadId,
      payload: {
        ...providerPayloadFields(event.payload),
        source: "checkpoint_reactor",
        status,
        files,
        ...(truncated
          ? {
              diffTruncated: true,
              diffTruncationReason: "output_limit",
              diffFileCount: totalFiles ?? files.length,
              diffFilesTruncated: filesTruncated === true,
            }
          : {}),
        checkpointRef: pending.checkpointRef,
        baseCheckpointRef: pending.baseCheckpointRef,
        ...(pending.turnId ? { turn_id: pending.turnId } : {}),
        turn_index: pending.checkpointTurnCount,
        checkpointTurnCount: pending.checkpointTurnCount,
      },
    })
  }

  private emit(event: LegacyProviderEvent): void {
    if (this.options.emitEvent) {
      this.options.emitEvent(event)
      return
    }
    this.options.eventBus.emitEvent?.(event)
  }
}

function resolveCwd(
  event: LegacyProviderEvent,
  threads: CheckpointReactorThreadStore
): string | null {
  const payloadCwd = payloadString(
    event.payload,
    "cwd",
    "projectPath",
    "project_path"
  )
  if (payloadCwd) return payloadCwd
  return threads.getThreadProjectPath(event.thread_id)
}

function turnKey(event: LegacyProviderEvent): string | null {
  const turnId = payloadString(
    event.payload,
    "dispatchTurnId",
    "dispatch_turn_id",
    "turn_id",
    "turnId"
  )
  if (turnId) return `turn:${turnId}`
  const turnIndex = payloadNumber(event.payload, "turn_index", "turnIndex")
  if (turnIndex !== undefined) return `index:${turnIndex}`
  return null
}

function pendingMapKey(threadId: string, key: string): string {
  return `${JSON.stringify(threadId)}::${JSON.stringify(key)}`
}

function payloadString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

function payloadNumber(
  payload: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function providerPayloadFields(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(payload.providerKind ? { providerKind: payload.providerKind } : {}),
    ...(payload.provider_kind ? { provider_kind: payload.provider_kind } : {}),
    ...(payload.providerInstanceId
      ? { providerInstanceId: payload.providerInstanceId }
      : {}),
    ...(payload.provider_instance_id
      ? { provider_instance_id: payload.provider_instance_id }
      : {}),
    ...(payload.dispatchTurnId
      ? { dispatchTurnId: payload.dispatchTurnId }
      : {}),
    ...(payload.dispatch_turn_id
      ? { dispatch_turn_id: payload.dispatch_turn_id }
      : {}),
  }
}

function isFailedTurnStatus(payload: Record<string, unknown>): boolean {
  const status = payloadString(payload, "status", "state")
  return status === "failed" || status === "error"
}
