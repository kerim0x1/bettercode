import { randomUUID } from "node:crypto"
import type { ProviderAdapterRegistry } from "./registry"
import type { ProviderAdapter } from "./adapter"
import type {
  ModelDefinition,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
} from "./types"
import { parseProviderKind } from "./types"
import { withCircuitBreaker } from "./circuitBreaker"
import { providerEventBus } from "./events"
import { logger } from "../observability/logger"
import { HttpError } from "../http/errors"
import type { ThreadTurnCoordinator } from "./threadTurnCoordinator"
import {
  bindAgentPermissionRuntimeContext,
  clearAgentPermissionRuntimeContext,
  runWithAgentPermissionRuntimeContext,
} from "./agent-permission-runtime"

export interface ProviderStatus {
  provider: ProviderKind
  name: string
  configured: boolean
  /** Auth-flow kind reported by the adapter — `"api-key"`, `"cli"`,
   *  `"local-server"`, `"oauth"`, or anything custom an adapter introduces.
   *  The renderer uses this for fallback tooltip copy when `hint` is absent. */
  authType?: string
  /** Adapter-specific human-readable setup instruction for the renderer to
   *  surface on disabled model picker items. */
  hint?: string
}

// ---------------------------------------------------------------------------
// Model-list cache — avoids calling adapter.availableModels() on every
// request.  Static adapters return instantly but Codex hits account/read,
// so a 5-minute TTL keeps things fast without going stale.
// ---------------------------------------------------------------------------

interface ModelCacheEntry {
  models: ModelDefinition[]
  fetchedAt: number
}

const MODEL_CACHE_TTL_MS = 15 * 60 * 1000

/**
 * M5: hard ceiling on a single provider turn dispatched via `dispatchTurn`.
 * If the adapter / SDK call hangs at a non-cancellable point, the renderer
 * was previously waiting forever for completion events that never came.
 * Ten minutes is well past every legitimate streaming completion observed
 * in the codebase but short enough to surface stuck turns within a UX-
 * tolerable window.  Test/dev override via env var keeps the suite snappy.
 */
const TURN_HARD_TIMEOUT_MS = Number(
  process.env.BETTERC0DE_TURN_HARD_TIMEOUT_MS ?? 10 * 60 * 1000
)

export interface ProviderServiceOptions {
  readonly turnTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly durableTurnCount?: (threadId: string) => number
  readonly threadTurnCoordinator?: ThreadTurnCoordinator
  readonly beforeTurn?: (event: ProviderRuntimeEvent) => Promise<void>
  readonly preDispatchPolicy?: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly projectPath?: string | null
    readonly appMode?: string | null
    readonly providerKind: ProviderKind
  }) =>
    | {
        readonly decision: "allow" | "deny"
        readonly reason?: string
        readonly toolName?: string
      }
    | Promise<{
        readonly decision: "allow" | "deny"
        readonly reason?: string
        readonly toolName?: string
      }>
  readonly afterTurn?: (event: ProviderRuntimeEvent) => Promise<void>
}

export interface LegacyProviderTurnHandle {
  readonly turnId: string
  readonly completion: Promise<void>
  /** Resolves only after terminal hooks and interrupt finalization complete. */
  readonly settled: Promise<void>
}

interface ActiveProviderTurn {
  readonly token: symbol
  readonly provider: ProviderKind
  readonly adapter: ProviderAdapter
  readonly turnId: string
  readonly sharedToken?: symbol
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
  readonly rejectSettled: (error: unknown) => void
  readonly dispatchQuiesced: Promise<void>
  readonly resolveDispatchQuiesced: () => void
  terminal: boolean
  settlementStarted: boolean
  cancelRequested: boolean
  adapterDispatchStarted: boolean
  backendQuarantined: boolean
  interruptPromise?: Promise<void>
  completion?: Promise<void>
}

class ProviderTurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`turn timed out after ${timeoutMs}ms`)
    this.name = "ProviderTurnTimeoutError"
  }
}

class ProviderTurnDispatchCancelledError extends Error {
  constructor(readonly turnId: string) {
    super(`provider turn '${turnId}' was cancelled before dispatch completed`)
    this.name = "ProviderTurnDispatchCancelledError"
  }
}

class ProviderShutdownTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`legacy provider shutdown timed out after ${timeoutMs}ms`)
    this.name = "ProviderShutdownTimeoutError"
  }
}

class ProviderInterruptTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`legacy provider interrupt timed out after ${timeoutMs}ms`)
    this.name = "ProviderInterruptTimeoutError"
  }
}

/** Port of rust-backend/src/provider/service.rs::ProviderService. */
export class ProviderService {
  private readonly modelCache = new Map<ProviderKind, ModelCacheEntry>()
  private readonly activeTurns = new Map<string, ActiveProviderTurn>()
  private readonly quarantinedAdapters = new Map<ProviderAdapter, unknown>()
  private readonly maintenanceByThread = new Set<string>()
  private readonly turnTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly durableTurnCount: (threadId: string) => number
  private readonly threadTurnCoordinator?: ThreadTurnCoordinator
  private readonly beforeTurn?: ProviderServiceOptions["beforeTurn"]
  private readonly preDispatchPolicy?: ProviderServiceOptions["preDispatchPolicy"]
  private readonly afterTurn?: ProviderServiceOptions["afterTurn"]
  private acceptingWork = true

  constructor(
    private readonly registry: ProviderAdapterRegistry,
    options: ProviderServiceOptions = {}
  ) {
    const configuredTimeout = options.turnTimeoutMs ?? TURN_HARD_TIMEOUT_MS
    this.turnTimeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.floor(configuredTimeout)
        : 10 * 60 * 1000
    const configuredShutdownTimeout = options.shutdownTimeoutMs ?? 5_000
    this.shutdownTimeoutMs =
      Number.isFinite(configuredShutdownTimeout) &&
      configuredShutdownTimeout > 0
        ? Math.floor(configuredShutdownTimeout)
        : 5_000
    this.durableTurnCount = options.durableTurnCount ?? (() => 0)
    this.threadTurnCoordinator = options.threadTurnCoordinator
    this.beforeTurn = options.beforeTurn
    this.preDispatchPolicy = options.preDispatchPolicy
    this.afterTurn = options.afterTurn
  }

  resolveProviderKind(raw: string): ProviderKind {
    const kind = parseProviderKind(raw)
    if (!kind) throw new HttpError(400, `Unknown provider kind: ${raw}`)
    return kind
  }

  assertCanDispatch(threadId: string, kind: ProviderKind): void {
    this.assertAcceptingWork()
    const adapter = this.registry.get(kind)
    if (!adapter) {
      throw new HttpError(
        404,
        `No adapter registered for ${kind}`,
        "provider_not_found"
      )
    }
    this.assertAdapterNotQuarantined(adapter)
    if (!adapter.isConfigured()) {
      throw new HttpError(
        400,
        `${adapter.displayName()} is not configured`,
        "provider_not_configured"
      )
    }
    if (
      this.maintenanceByThread.has(threadId) ||
      this.activeTurns.has(threadId)
    ) {
      throw new HttpError(
        409,
        `Thread '${threadId}' already has active provider work.`,
        "turn_active"
      )
    }
  }

  dispatchTurn(
    input: ProviderSendTurnInput,
    kind: ProviderKind,
    options: {
      readonly sharedToken?: symbol
      readonly onAccepted?: (turnId: string) => void
    } = {}
  ): string {
    const handle = this.dispatchTurnWithHandle(input, kind, options)
    // Compatibility callers historically received only the id. Keep their
    // detached failure behavior while the HTTP route uses the handle below to
    // persist a late adapter rejection in the dispatch outbox.
    void handle.completion.catch(() => {})
    return handle.turnId
  }

  dispatchTurnWithHandle(
    input: ProviderSendTurnInput,
    kind: ProviderKind,
    options: {
      readonly sharedToken?: symbol
      readonly onAccepted?: (turnId: string) => void
    } = {}
  ): LegacyProviderTurnHandle {
    this.assertAcceptingWork()
    const adapter = this.registry.get(kind)
    if (!adapter) {
      throw new HttpError(
        404,
        `No adapter registered for ${kind}`,
        "provider_not_found"
      )
    }
    this.assertAdapterNotQuarantined(adapter)
    if (!adapter.isConfigured()) {
      throw new HttpError(
        400,
        `${adapter.displayName()} is not configured`,
        "provider_not_configured"
      )
    }
    if (this.maintenanceByThread.has(input.thread_id)) {
      throw new HttpError(
        409,
        `Thread '${input.thread_id}' is undergoing provider maintenance.`,
        "turn_active"
      )
    }
    const existing = this.activeTurns.get(input.thread_id)
    if (existing) {
      throw new HttpError(
        409,
        `Thread '${input.thread_id}' already has an active provider turn (${existing.provider}).`,
        "turn_active"
      )
    }
    const admissionToken = Symbol(input.thread_id)
    const sharedToken =
      options.sharedToken ??
      this.threadTurnCoordinator?.reserveTurn(input.thread_id, `legacy:${kind}`)
    if (this.threadTurnCoordinator && !sharedToken) {
      throw new HttpError(
        409,
        `Thread '${input.thread_id}' already has active provider work.`,
        "turn_active"
      )
    }
    const turnId = randomUUID()
    let resolveDispatchQuiesced!: () => void
    const dispatchQuiesced = new Promise<void>((resolve) => {
      resolveDispatchQuiesced = resolve
    })
    let resolveSettled!: () => void
    let rejectSettled!: (error: unknown) => void
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve
      rejectSettled = reject
    })
    // Detached compatibility callers do not receive the handle. Observe the
    // rejection internally while preserving the public promise's state.
    void settled.catch(() => {})
    const activeTurn: ActiveProviderTurn = {
      token: admissionToken,
      provider: kind,
      adapter,
      turnId,
      ...(sharedToken ? { sharedToken } : {}),
      settled,
      resolveSettled,
      rejectSettled,
      dispatchQuiesced,
      resolveDispatchQuiesced,
      terminal: false,
      settlementStarted: false,
      cancelRequested: false,
      adapterDispatchStarted: false,
      backendQuarantined: false,
    }
    this.activeTurns.set(input.thread_id, activeTurn)
    try {
      options.onAccepted?.(turnId)
    } catch (error) {
      this.releaseActiveTurn(input.thread_id, activeTurn)
      activeTurn.resolveDispatchQuiesced()
      activeTurn.resolveSettled()
      throw error
    }

    // M5: race the turn against a hard timeout.  Without this, a hung
    // adapter promise never settles and the renderer waits forever — no
    // turn_error event is ever emitted because the .catch below never fires.
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new ProviderTurnTimeoutError(this.turnTimeoutMs)),
        this.turnTimeoutMs
      )
      if (timeoutHandle.unref) timeoutHandle.unref()
    })
    let syntheticTerminalEvent: ProviderRuntimeEvent | undefined
    const dispatch = this.sendTurn(
      input,
      kind,
      turnId,
      () => {
        const active = this.activeTurns.get(input.thread_id)
        return (
          active?.token === admissionToken &&
          !active.terminal &&
          !active.settlementStarted
        )
      },
      async (event) => {
        syntheticTerminalEvent = event
      },
      {
        isCancelled: () => activeTurn.cancelRequested,
        onAdapterDispatchStarted: () => {
          activeTurn.adapterDispatchStarted = true
        },
      },
      adapter
    )
    void dispatch.then(
      () => activeTurn.resolveDispatchQuiesced(),
      () => activeTurn.resolveDispatchQuiesced()
    )
    const completion = Promise.race([dispatch, timeoutPromise])
      .then(async () => {
        const active = this.activeTurns.get(input.thread_id)
        if (
          active?.token === admissionToken &&
          !active.terminal &&
          !active.settlementStarted
        ) {
          await this.finalizeActiveTurn(
            input.thread_id,
            active,
            syntheticTerminalEvent
          )
        }
      })
      .catch(async (err) => {
        const publicMessage =
          err instanceof ProviderTurnTimeoutError
            ? "Provider turn timed out."
            : "Provider turn failed."
        if (!(err instanceof ProviderTurnDispatchCancelledError)) {
          logger.error(
            {
              errorType: err instanceof Error ? err.name : typeof err,
              provider: kind,
              thread: input.thread_id,
            },
            "provider turn dispatch failed"
          )
        }
        const active = this.activeTurns.get(input.thread_id)
        if (
          active?.token === admissionToken &&
          !active.terminal &&
          !active.settlementStarted
        ) {
          active.cancelRequested = true
          const terminalEvent: ProviderRuntimeEvent = {
            event_type: "turn_error",
            thread_id: input.thread_id,
            payload: {
              error: publicMessage,
              turn_id: turnId,
              dispatchTurnId: turnId,
              provider_kind: kind,
              status:
                err instanceof ProviderTurnTimeoutError
                  ? "timed_out"
                  : "failed",
            },
          }
          await this.finalizeActiveTurn(
            input.thread_id,
            active,
            terminalEvent,
            err,
            active.adapterDispatchStarted
              ? () => this.interruptAdapter(active.adapter, input.thread_id)
              : undefined
          )
        }
        throw err
      })
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      })
    void completion.catch(() => {})
    activeTurn.completion = completion
    void settled.then(
      () => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      },
      () => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    )
    return { turnId, completion, settled }
  }

  async sendTurn(
    input: ProviderSendTurnInput,
    kind: ProviderKind,
    turnId = randomUUID(),
    canComplete: () => boolean = () => true,
    finalizeTerminal?: (event: ProviderRuntimeEvent) => Promise<void>,
    control?: {
      readonly isCancelled: () => boolean
      readonly onAdapterDispatchStarted: () => void
    },
    adapterOverride?: ProviderAdapter
  ): Promise<void> {
    const adapter = adapterOverride ?? this.registry.get(kind)
    if (!adapter) {
      throw new HttpError(
        404,
        `No adapter registered for ${kind}`,
        "provider_not_found"
      )
    }
    const managesOwnTurnLifecycle = adapter.managesOwnTurnLifecycle?.() ?? false

    // Per-thread monotonic turn counter (Phase 1 Objective 6 foundation).
    // Attached to `turn_started` / `turn_completed` bus payloads so
    // CheckpointService + diff hook in later phases can correlate
    // pre-turn state (captureBeforeTurn) with the matching post-turn
    // completion event without race conditions.
    const turnIndex = managesOwnTurnLifecycle
      ? null
      : this.nextTurnIndex(input.thread_id)
    const turnStartedEvent: ProviderRuntimeEvent = {
      event_type: "turn_started",
      thread_id: input.thread_id,
      payload: {
        turn_id: turnId,
        dispatchTurnId: turnId,
        ...(turnIndex !== null ? { turn_index: turnIndex } : {}),
        provider_kind: kind,
        ...(input.project_path ? { project_path: input.project_path } : {}),
      },
    }
    try {
      await this.beforeTurn?.(turnStartedEvent)
    } catch (error) {
      if (turnIndex !== null) {
        this.rollbackTurnIndex(input.thread_id, turnIndex)
      }
      throw error
    }
    this.throwIfTurnDispatchCancelled(turnId, control)
    if (turnIndex !== null) {
      providerEventBus.emitEvent(turnStartedEvent)
    }
    this.throwIfTurnDispatchCancelled(turnId, control)

    let completionEmitted = false
    const markCompleted = async () => {
      if (completionEmitted || turnIndex === null || !canComplete()) return
      completionEmitted = true
      const terminalEvent: ProviderRuntimeEvent = {
        event_type: "turn_completed",
        thread_id: input.thread_id,
        payload: {
          turn_id: turnId,
          dispatchTurnId: turnId,
          turn_index: turnIndex,
          provider_kind: kind,
        },
      }
      if (finalizeTerminal) {
        await finalizeTerminal(terminalEvent)
      } else {
        await this.afterTurn?.(terminalEvent)
        providerEventBus.emitEvent(terminalEvent)
      }
    }

    const permissionContext = {
      threadId: input.thread_id,
      workspacePath: input.project_path,
      appMode: input.app_mode,
      chatMode: input.chat_mode,
      permissionLevel: input.permission_level,
    }
    const permissionContextToken =
      bindAgentPermissionRuntimeContext(permissionContext)
    try {
      await runWithAgentPermissionRuntimeContext(
        permissionContext,
        async () => {
          const policyDecision = await this.preDispatchPolicy?.({
            threadId: input.thread_id,
            turnId,
            projectPath: input.project_path,
            appMode: input.app_mode,
            providerKind: kind,
          })
          this.throwIfTurnDispatchCancelled(turnId, control)
          if (policyDecision?.decision === "deny") {
            providerEventBus.emitEvent({
              event_type: "tool.denied",
              thread_id: input.thread_id,
              payload: {
                providerKind: kind,
                toolName: policyDecision.toolName?.trim() || "AgentMode",
                reason:
                  policyDecision.reason?.trim() ||
                  "Provider dispatch was denied by the workspace policy.",
                turn_id: turnId,
              },
            })
            if (turnIndex === null && canComplete()) {
              const terminalEvent: ProviderRuntimeEvent = {
                event_type: "turn_completed",
                thread_id: input.thread_id,
                payload: {
                  turn_id: turnId,
                  dispatchTurnId: turnId,
                  provider_kind: kind,
                },
              }
              if (finalizeTerminal) {
                await finalizeTerminal(terminalEvent)
              } else {
                await this.afterTurn?.(terminalEvent)
                providerEventBus.emitEvent(terminalEvent)
              }
            } else {
              await markCompleted()
            }
            return
          }

          await withCircuitBreaker(kind, () => {
            this.throwIfTurnDispatchCancelled(turnId, control)
            control?.onAdapterDispatchStarted()
            return adapter.sendMessage(input)
          })
          await markCompleted()
        }
      )
    } finally {
      clearAgentPermissionRuntimeContext(
        input.thread_id,
        permissionContextToken
      )
    }
  }

  private throwIfTurnDispatchCancelled(
    turnId: string,
    control:
      | {
          readonly isCancelled: () => boolean
        }
      | undefined
  ): void {
    if (!control?.isCancelled()) return
    throw new ProviderTurnDispatchCancelledError(turnId)
  }

  private readonly turnCounters = new Map<string, number>()

  private nextTurnIndex(threadId: string): number {
    const durable = Math.max(0, Math.trunc(this.durableTurnCount(threadId)))
    const next = Math.max(this.turnCounters.get(threadId) ?? 0, durable) + 1
    this.turnCounters.set(threadId, next)
    return next
  }

  private rollbackTurnIndex(threadId: string, allocated: number): void {
    if (this.turnCounters.get(threadId) !== allocated) return
    const previous = Math.max(0, allocated - 1)
    if (previous === 0) this.turnCounters.delete(threadId)
    else this.turnCounters.set(threadId, previous)
  }

  async interruptThread(threadId: string): Promise<boolean> {
    const active = this.activeTurns.get(threadId)
    if (!active) return false
    await this.interrupt(active.provider, threadId)
    return true
  }

  async interruptTurnIfActive(
    threadId: string,
    expectedTurnId: string
  ): Promise<boolean> {
    const active = this.activeTurns.get(threadId)
    if (!active || active.turnId !== expectedTurnId) return false
    await this.interrupt(active.provider, threadId)
    return true
  }

  forgetThread(threadId: string): void {
    this.turnCounters.delete(threadId)
  }

  async withThreadMaintenance<T>(
    threadId: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    const active = this.activeTurns.get(threadId)
    if (active) {
      throw new HttpError(
        409,
        `Thread '${threadId}' already has an active provider turn (${active.provider}).`,
        "turn_active"
      )
    }
    if (this.maintenanceByThread.has(threadId)) {
      throw new HttpError(
        409,
        `Thread '${threadId}' is already undergoing provider maintenance.`,
        "turn_active"
      )
    }
    this.maintenanceByThread.add(threadId)
    try {
      return await operation()
    } finally {
      this.maintenanceByThread.delete(threadId)
    }
  }

  async withThreadTeardown<T>(
    threadId: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    if (this.maintenanceByThread.has(threadId)) {
      throw new HttpError(
        409,
        `Thread '${threadId}' is already undergoing provider maintenance.`,
        "turn_active"
      )
    }
    this.maintenanceByThread.add(threadId)
    try {
      await this.interruptThread(threadId)
      return await operation()
    } finally {
      this.maintenanceByThread.delete(threadId)
    }
  }

  async interrupt(kind: ProviderKind, threadId: string): Promise<void> {
    const adapter = this.registry.get(kind)
    if (!adapter) {
      throw new HttpError(
        404,
        `No adapter registered for ${kind}`,
        "provider_not_found"
      )
    }
    const active = this.activeTurns.get(threadId)
    if (!active || active.provider !== kind) {
      await adapter.interrupt(threadId)
      return
    }

    if (active.settlementStarted) {
      await this.waitForInterruptBoundary(active.settled)
      return
    }
    active.cancelRequested = true
    active.terminal = true
    if (!active.interruptPromise) {
      const interruptPromise = (async () => {
        let interruptFailure: unknown
        let hardStopFailure: unknown
        if (active.adapterDispatchStarted) {
          try {
            await this.interruptAdapter(active.adapter, threadId)
          } catch (error) {
            interruptFailure = error
            try {
              await this.hardStopAdapter(active.adapter)
            } catch (stopError) {
              hardStopFailure = stopError
              this.quarantineAdapter(
                active,
                combineLegacyProviderFailures([error, stopError])
              )
            }
          }
        }
        const terminalEvent: ProviderRuntimeEvent = {
          event_type: "turn_interrupted",
          thread_id: threadId,
          payload: {
            turn_id: active.turnId,
            dispatchTurnId: active.turnId,
            provider_kind: kind,
            status:
              interruptFailure || hardStopFailure
                ? "interrupt_failed"
                : "interrupted",
          },
        }
        const finalizationFailure = combineLegacyProviderFailures([
          interruptFailure,
          hardStopFailure,
        ])
        void this.finalizeActiveTurn(
          threadId,
          active,
          terminalEvent,
          finalizationFailure
        )
        if (hardStopFailure !== undefined) throw finalizationFailure
        try {
          await this.waitForInterruptBoundary(active.dispatchQuiesced)
        } catch (error) {
          const failure = combineLegacyProviderFailures([
            finalizationFailure,
            error,
          ])
          this.quarantineAdapter(active, failure)
          throw failure
        }
        await this.waitForInterruptBoundary(active.settled)
      })()
      active.interruptPromise = interruptPromise
    }
    await active.interruptPromise
  }

  private async interruptAdapter(
    adapter: ProviderAdapter,
    threadId: string
  ): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new ProviderInterruptTimeoutError(this.shutdownTimeoutMs)),
        this.shutdownTimeoutMs
      )
      if (timeoutHandle.unref) timeoutHandle.unref()
    })
    try {
      await Promise.race([
        Promise.resolve().then(() => adapter.interrupt(threadId)),
        timeout,
      ])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private async hardStopAdapter(adapter: ProviderAdapter): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new ProviderInterruptTimeoutError(this.shutdownTimeoutMs)),
        this.shutdownTimeoutMs
      )
      if (timeoutHandle.unref) timeoutHandle.unref()
    })
    try {
      await Promise.race([
        Promise.resolve().then(() => adapter.interruptAll()),
        timeout,
      ])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private finalizeActiveTurn(
    threadId: string,
    active: ActiveProviderTurn,
    terminalEvent?: ProviderRuntimeEvent,
    initialFailure?: unknown,
    cleanup?: () => Promise<void>
  ): Promise<void> {
    if (active.settlementStarted) return active.settled
    active.settlementStarted = true
    active.terminal = true

    void (async () => {
      const failures: unknown[] = []
      if (initialFailure !== undefined) failures.push(initialFailure)

      if (cleanup) {
        try {
          await cleanup()
        } catch (error) {
          failures.push(error)
        }
      }

      // An interrupt attempted during beforeTurn is intentionally a no-op at
      // the adapter. The cancellation checks above must first prove that no
      // send began; once sendMessage began, its promise must actually quiesce
      // before the admission/workspace fence can be released.
      await active.dispatchQuiesced
      if (terminalEvent) {
        try {
          providerEventBus.emitEvent(terminalEvent)
        } catch (error) {
          failures.push(error)
        }
        try {
          await this.afterTurn?.(terminalEvent)
        } catch (error) {
          failures.push(error)
        }
      }
      this.releaseActiveTurn(threadId, active)
      if (failures.length === 0) {
        active.resolveSettled()
      } else if (failures.length === 1) {
        active.rejectSettled(failures[0])
      } else {
        active.rejectSettled(
          new AggregateError(
            failures,
            "Provider turn and its terminal finalization failed"
          )
        )
      }
    })()

    return active.settled
  }

  private releaseActiveTurn(
    threadId: string,
    active: ActiveProviderTurn
  ): void {
    if (this.activeTurns.get(threadId)?.token !== active.token) return
    this.activeTurns.delete(threadId)
    if (active.sharedToken) {
      this.threadTurnCoordinator?.releaseTurn(threadId, active.sharedToken)
    }
  }

  /** Interrupt every in-flight turn across all providers. Returns the total
   *  number of turns that were aborted. */
  async interruptAll(): Promise<number> {
    this.beginShutdown()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new ProviderShutdownTimeoutError(this.shutdownTimeoutMs)),
        this.shutdownTimeoutMs
      )
    })
    const shutdown = this.interruptAllActiveTurns()

    try {
      return await Promise.race([shutdown, timeout])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private async interruptAllActiveTurns(): Promise<number> {
    const active = [...this.activeTurns.entries()]
    const interruptResults = await Promise.allSettled(
      active.map(([threadId, turn]) => this.interrupt(turn.provider, threadId))
    )
    const [registryResult] = await Promise.allSettled([
      Promise.resolve().then(() => this.registry.interruptAll()),
    ])
    const completionResults = await Promise.allSettled(
      active
        .filter(([, turn]) => !turn.backendQuarantined)
        .map(([, turn]) => turn.settled)
    )
    const interruptFailures: unknown[] = interruptResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    let residual = 0
    if (registryResult.status === "rejected") {
      interruptFailures.push(registryResult.reason)
    } else {
      residual = registryResult.value
    }
    if (interruptFailures.length > 0) {
      throw new AggregateError(
        interruptFailures,
        "One or more legacy provider shutdown operations failed"
      )
    }
    // A rejected completion is expected after interruption. Waiting for every
    // promise to settle is what prevents late DB/event writes during teardown.
    void completionResults
    return active.length + residual
  }

  beginShutdown(): void {
    this.acceptingWork = false
  }

  private assertAdapterNotQuarantined(adapter: ProviderAdapter): void {
    const failure = this.quarantinedAdapters.get(adapter)
    if (failure === undefined) return
    throw new HttpError(
      503,
      "Provider backend is temporarily unavailable.",
      "provider_backend_quarantined"
    )
  }

  private quarantineAdapter(
    active: ActiveProviderTurn,
    failure: unknown
  ): void {
    active.backendQuarantined = true
    if (!this.quarantinedAdapters.has(active.adapter)) {
      this.quarantinedAdapters.set(active.adapter, failure)
    }
  }

  private async waitForInterruptBoundary(
    operation: Promise<void>
  ): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new ProviderInterruptTimeoutError(this.shutdownTimeoutMs)),
        this.shutdownTimeoutMs
      )
      if (timeoutHandle.unref) timeoutHandle.unref()
    })
    try {
      await Promise.race([operation, timeout])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private assertAcceptingWork(): void {
    if (this.acceptingWork) return
    throw new HttpError(
      503,
      "Provider service is shutting down.",
      "provider_shutting_down"
    )
  }

  async respondToApproval(
    kind: ProviderKind,
    threadId: string,
    requestId: string,
    decision: "approve" | "deny"
  ): Promise<void> {
    const adapter = this.registry.get(kind)
    if (!adapter) {
      throw new HttpError(
        404,
        `No adapter registered for ${kind}`,
        "provider_not_found"
      )
    }
    if (!adapter.respondToApproval) {
      throw new HttpError(
        422,
        `${adapter.displayName()} does not support approval responses`,
        "provider_capability_unsupported"
      )
    }
    await adapter.respondToApproval(threadId, requestId, decision)
  }

  async respondToUserInput(
    kind: ProviderKind,
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>
  ): Promise<void> {
    const adapter = this.registry.get(kind)
    if (!adapter) {
      throw new HttpError(
        404,
        `No adapter registered for ${kind}`,
        "provider_not_found"
      )
    }
    if (!adapter.respondToUserInput) {
      throw new HttpError(
        422,
        `${adapter.displayName()} does not support user-input responses`,
        "provider_capability_unsupported"
      )
    }
    await adapter.respondToUserInput(threadId, requestId, answers)
  }

  listProviders(): ProviderKind[] {
    return this.registry.all().map((a) => a.providerKind())
  }

  /**
   * Returns the aggregated model list across all registered adapters.
   * Results are cached per-provider for {@link MODEL_CACHE_TTL_MS} (15 min).
   *
   * @param force  When `true`, bypass the cache and re-fetch from every adapter.
   */
  listModels(force?: boolean): ModelDefinition[] {
    const now = Date.now()
    const result: ModelDefinition[] = []

    for (const adapter of this.registry.all()) {
      const kind = adapter.providerKind()
      const cached = this.modelCache.get(kind)

      if (!force && cached && now - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
        result.push(...cached.models)
        continue
      }

      const models = adapter.availableModels()
      this.modelCache.set(kind, { models, fetchedAt: now })
      result.push(...models)
    }

    return result
  }

  /** Fetch authenticated API inventories together while keeping the legacy
   * `/models` array shape. An adapter without discovery keeps its own list. */
  async listModelsLive(force = false): Promise<ModelDefinition[]> {
    const results = await Promise.all(
      this.registry
        .all()
        .map(async (adapter) =>
          adapter.discoverModels
            ? adapter.discoverModels(force)
            : adapter.availableModels()
        )
    )
    return results.flat()
  }

  /** Invalidate the model-list cache for a single provider so the next
   *  {@link listModels} call re-fetches from that adapter. */
  refreshModels(kind: ProviderKind): void {
    this.modelCache.delete(kind)
  }

  getStatus(): ProviderStatus[] {
    return this.registry.all().map((a) => {
      const meta = typeof a.authMeta === "function" ? a.authMeta() : undefined
      return {
        provider: a.providerKind(),
        name: a.displayName(),
        configured: a.isConfigured(),
        authType: meta?.authType,
        hint: meta?.hint,
      }
    })
  }
}

function combineLegacyProviderFailures(
  failures: ReadonlyArray<unknown>
): unknown | undefined {
  const defined = failures.filter((failure) => failure !== undefined)
  if (defined.length === 0) return undefined
  if (defined.length === 1) return defined[0]
  return new AggregateError(
    defined,
    "Legacy provider interruption and hard-stop both failed"
  )
}
