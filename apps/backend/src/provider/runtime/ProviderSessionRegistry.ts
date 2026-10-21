import {
  threadId as toThreadId,
  type ProviderAdapterShape,
  type ProviderKind,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadId,
} from "./contracts"
import {
  ProviderBackendQuarantinedError,
  ProviderSessionAdmissionCapacityError,
  ProviderSessionCapacityError,
  ProviderSessionInspectionError,
  ProviderStaleSessionCleanupError,
} from "./ProviderHubErrors"
import type {
  ProviderHubSessionSnapshot,
  ProviderRuntimeInstance,
} from "./ProviderHubTypes"
import { ProviderUpdateError } from "./ProviderMaintenanceCoordinator"
import type {
  ProviderSessionBinding,
  ProviderSessionBindingStore,
} from "./ProviderSessionBindingStore"
import { selectRecoveryBinding } from "./ProviderSessionRecovery"
import type { ProviderTurnCapacity } from "./ProviderTurnCapacity"
import { normalizeRuntimeMode } from "./providerTurnOptions"

/** What the session registry needs from the hub that owns the instances. */
export interface ProviderSessionRegistryHost {
  /** The registered instances: a live iterator, not a snapshot. */
  instances(): IterableIterator<ProviderRuntimeInstance>
  getInstance(instanceId: string): ProviderRuntimeInstance | undefined
  isQuarantined(adapter: ProviderAdapterShape): boolean
  quarantineOf(
    adapter: ProviderAdapterShape
  ): { readonly failure: ProviderBackendQuarantinedError } | undefined
  /** Quarantined, retiring, or failed to retire: not safe to enumerate. */
  isRetainedAdapter(adapter: ProviderAdapterShape): boolean
  isAcceptingWork(): boolean
  assertAcceptingWork(operation: string): void
  /** Bounds one adapter call and quarantines the backend on its deadline. */
  runSessionOperation<T>(
    instance: ProviderRuntimeInstance,
    label: string,
    operation: () => Promise<T>
  ): Promise<T>
  raceInterruptBudget<T>(operation: () => Promise<T>, label: string): Promise<T>
  emitSessionStarted(input: {
    readonly threadId: string
    readonly providerKind: ProviderKind
    readonly providerInstanceId: string
    readonly resumeCursor?: unknown
  }): void
  emitSessionExited(input: {
    readonly threadId: string
    readonly providerKind: ProviderKind
    readonly providerInstanceId: string
    readonly reason: string
  }): void
  /** The admission queue drained; a deferred instance replacement may apply. */
  onSessionAdmissionIdle(): void
}

interface ProviderSessionAdmissionWaiter {
  readonly resolve: (release: () => void) => void
  readonly reject: (error: unknown) => void
}

/**
 * Provider sessions per thread: creating, recovering, switching and stopping
 * them through one serialized admission queue, the live-session accounting
 * that capacity checks rely on, and the persisted-binding view of sessions.
 * The hub keeps the instances, the quarantine and the turn lifecycle, and
 * reaches all of that through {@link ProviderSessionRegistryHost}.
 */
export class ProviderSessionRegistry {
  private readonly suppressedSessionExitCorrelation = new Map<string, number>()
  private readonly knownLiveSessions = new Map<
    ProviderAdapterShape,
    Set<string>
  >()
  private readonly sessionAdmissionWaiters: ProviderSessionAdmissionWaiter[] =
    []
  private sessionAdmissionActive = false

  constructor(
    private readonly host: ProviderSessionRegistryHost,
    private readonly capacity: Pick<
      ProviderTurnCapacity,
      "assertSessionCapacity" | "sessionAdmissionQueueMaxEntries"
    >
  ) {}

  /** A session admission is running, or one is queued. */
  hasAdmissionActivity(): boolean {
    return (
      this.sessionAdmissionActive || this.sessionAdmissionWaiters.length > 0
    )
  }

  /** The backend confirmed that every session it owned is gone. */
  forgetAdapter(adapter: ProviderAdapterShape): void {
    this.knownLiveSessions.delete(adapter)
  }

  async listSessions(
    bindings?: ProviderSessionBindingStore
  ): Promise<ProviderHubSessionSnapshot[]> {
    const sessions: ProviderHubSessionSnapshot[] = []
    const seen = new Set<string>()

    for (const instance of this.host.instances()) {
      if (
        !instance.enabled ||
        instance.unavailableReason ||
        this.host.isQuarantined(instance.adapter) ||
        !instance.adapter.isConfigured()
      ) {
        continue
      }
      const activeSessions = await this.host.runSessionOperation(
        instance,
        "listSessions",
        () => readAdapterSessions(instance.adapter)
      )
      for (const session of activeSessions) {
        const providerInstanceId = instance.instanceId
        const binding = bindings?.get(session.threadId, providerInstanceId)
        const snapshot: ProviderHubSessionSnapshot = {
          ...session,
          providerInstanceId,
          providerKind:
            instance.provider ??
            binding?.providerKind ??
            instance.adapter.provider,
          instanceId: instance.instanceId,
          driver: instance.driver,
          displayName: instance.displayName ?? instance.adapter.displayName,
          resumeCursor:
            session.resumeCursor !== undefined
              ? session.resumeCursor
              : (binding?.resumeCursor ?? null),
          continuationKey:
            session.continuationKey !== undefined
              ? session.continuationKey
              : (binding?.continuationKey ?? null),
          ...(binding?.runtimeMode ? { runtimeMode: binding.runtimeMode } : {}),
          generation: binding?.generation ?? 0,
          active: true,
          persisted: !!binding,
        }
        sessions.push(snapshot)
        seen.add(sessionSnapshotKey(snapshot.threadId, providerInstanceId))
      }
    }

    if (bindings) {
      for (const binding of bindings.list()) {
        const key = sessionSnapshotKey(
          binding.threadId,
          binding.providerInstanceId
        )
        if (seen.has(key)) continue
        const instance = this.host.getInstance(binding.providerInstanceId)
        sessions.push({
          threadId: binding.threadId,
          providerInstanceId: binding.providerInstanceId,
          providerThreadId: binding.providerThreadId,
          resumeCursor: binding.resumeCursor,
          continuationKey: binding.continuationKey,
          status: binding.status,
          cwd: binding.cwd,
          activeTurnId: binding.activeTurnId,
          createdAt: parseTimestamp(binding.createdAt),
          updatedAt: parseTimestamp(binding.updatedAt),
          providerKind: binding.providerKind,
          instanceId: binding.providerInstanceId,
          driver: instance?.driver ?? binding.providerKind,
          displayName:
            instance?.displayName ??
            instance?.adapter.displayName ??
            binding.providerInstanceId,
          runtimeMode: binding.runtimeMode,
          generation: binding.generation,
          active: false,
          persisted: true,
        })
      }
    }

    return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async switchProviderForThread(input: {
    readonly instance: ProviderRuntimeInstance
    readonly thread: ThreadId
    readonly bindings: ProviderSessionBindingStore
    readonly sourceBinding: ProviderSessionBinding
    readonly context: Pick<
      ProviderSendTurnInput,
      "modelSelection" | "projectPath"
    > & { readonly runtimeMode?: string | null }
  }): Promise<void> {
    await this.withSessionAdmission(async () => {
      await this.stopSessionsForThreadUnderAdmission({
        threadId: input.thread,
        reason: `provider switched to ${input.instance.instanceId}`,
      })
      const generation = input.bindings.rotateGenerationForProviderSwitch(
        input.thread,
        input.sourceBinding.providerInstanceId
      )
      if (generation === null) {
        throw new ProviderSessionInspectionError(
          `Provider binding for thread '${input.thread}' changed while switching providers.`
        )
      }
      await this.recoverSessionForThreadUnderAdmission({
        instance: input.instance,
        thread: input.thread,
        bindings: input.bindings,
        context: input.context,
      })
    })
  }

  async stopStaleSessionsForThread(input: {
    readonly threadId: string
    readonly currentInstanceId: string
  }): Promise<void> {
    const threadId = toThreadId(input.threadId)
    const currentAdapter = this.host.getInstance(
      input.currentInstanceId
    )?.adapter
    await this.withSessionAdmission(() =>
      this.stopSessionsForThreadUnderAdmission({
        threadId,
        ...(currentAdapter ? { preservedAdapter: currentAdapter } : {}),
        reason: `stale session replaced by ${input.currentInstanceId}`,
      })
    )
  }

  private async stopSessionsForThreadUnderAdmission(input: {
    readonly threadId: ThreadId
    readonly preservedAdapter?: ProviderAdapterShape
    readonly reason: string
  }): Promise<void> {
    const inspectedAdapters = new Set<ProviderAdapterShape>()
    if (input.preservedAdapter) inspectedAdapters.add(input.preservedAdapter)
    for (const instance of this.host.instances()) {
      if (inspectedAdapters.has(instance.adapter)) continue
      inspectedAdapters.add(instance.adapter)
      const quarantine = this.host.quarantineOf(instance.adapter)
      if (quarantine) {
        // A quarantined backend cannot be asked to stop anything, so a stale
        // session it may own for this thread blocks the turn (fail closed).
        // A quarantined backend with no session for this thread is not this
        // turn's problem: it used to block every turn on every provider.
        let ownsThread = this.knownLiveSessions
          .get(instance.adapter)
          ?.has(input.threadId)
        if (!ownsThread) {
          try {
            ownsThread = instance.adapter.hasSession(input.threadId)
          } catch {
            ownsThread = true
          }
        }
        if (ownsThread) throw quarantine.failure
        continue
      }
      try {
        const hasSession = instance.adapter.hasSession(input.threadId)
        const listedSession = await this.readLiveAdapterSession(
          instance,
          input.threadId
        )
        if (hasSession !== Boolean(listedSession)) {
          throw new ProviderSessionInspectionError(
            `Provider instance '${instance.instanceId}' reported inconsistent session state for '${input.threadId}'.`
          )
        }
        if (!hasSession) continue
        await this.withSessionExitCorrelationSuppressed(
          input.threadId,
          instance.instanceId,
          () =>
            this.host.runSessionOperation(instance, "stopSession", () =>
              instance.adapter.stopSession(input.threadId)
            )
        )
        this.forgetKnownLiveSession(instance.adapter, input.threadId)
        this.host.emitSessionExited({
          threadId: input.threadId,
          providerKind: instance.provider ?? instance.adapter.provider,
          providerInstanceId: instance.instanceId,
          reason: input.reason,
        })
      } catch (error) {
        throw new ProviderStaleSessionCleanupError(
          instance.instanceId,
          input.threadId,
          error
        )
      }
    }
  }

  async recoverSessionForThread(input: {
    readonly instance: ProviderRuntimeInstance
    readonly thread: ThreadId
    readonly bindings?: ProviderSessionBindingStore
    readonly context?: Pick<
      ProviderSendTurnInput,
      "modelSelection" | "projectPath"
    > & { readonly runtimeMode?: string | null }
  }): Promise<boolean> {
    return this.withSessionAdmission(() =>
      this.recoverSessionForThreadUnderAdmission(input)
    )
  }

  private async recoverSessionForThreadUnderAdmission(input: {
    readonly instance: ProviderRuntimeInstance
    readonly thread: ThreadId
    readonly bindings?: ProviderSessionBindingStore
    readonly context?: Pick<
      ProviderSendTurnInput,
      "modelSelection" | "projectPath"
    > & { readonly runtimeMode?: string | null }
  }): Promise<boolean> {
    this.host.assertAcceptingWork("create or recover provider session")
    const providerKind =
      input.instance.provider ?? input.instance.adapter.provider
    const directBinding =
      input.bindings?.get(input.thread, input.instance.instanceId) ?? null
    const recoveryBinding = input.bindings
      ? selectRecoveryBinding({
          bindings: input.bindings,
          thread: input.thread,
          providerKind,
          providerInstanceId: input.instance.instanceId,
          continuationKey: input.instance.continuationKey ?? null,
          directBinding,
        })
      : null
    let stoppedActiveSession: ProviderSession | null = null
    let hasActiveSession: boolean
    try {
      hasActiveSession = input.instance.adapter.hasSession(input.thread)
    } catch (error) {
      throw new ProviderSessionInspectionError(
        `Could not inspect provider session '${input.thread}' for instance '${input.instance.instanceId}'.`,
        error
      )
    }
    if (hasActiveSession) {
      const activeSession = await this.readLiveAdapterSession(
        input.instance,
        input.thread
      )
      if (!activeSession) {
        throw new ProviderSessionInspectionError(
          `Provider instance '${input.instance.instanceId}' reported session '${input.thread}' in hasSession() but omitted it from listSessions().`
        )
      }
      if (
        !(await input.instance.adapter.needsSessionConfigurationRefresh?.({
          threadId: input.thread,
          cwd: input.context?.projectPath ?? activeSession.cwd,
        })) &&
        !shouldRestartActiveSessionForContext(activeSession, {
          cwd:
            input.context?.projectPath ??
            directBinding?.cwd ??
            recoveryBinding?.cwd,
          runtimeMode:
            input.context?.runtimeMode ??
            // Historical bindings may contain a default mode even when the
            // running adapter never reported one. Only an explicit request can
            // require changing that unknown mode during an active session.
            (normalizeRuntimeMode(activeSession.runtimeMode)
              ? (directBinding?.runtimeMode ?? recoveryBinding?.runtimeMode)
              : undefined),
        })
      ) {
        return true
      }
      await this.withSessionExitCorrelationSuppressed(
        input.thread,
        input.instance.instanceId,
        () =>
          this.host.runSessionOperation(input.instance, "stopSession", () =>
            input.instance.adapter.stopSession(input.thread)
          )
      )
      stoppedActiveSession = activeSession
    }
    const startBinding = recoveryBinding ?? directBinding
    if (!startBinding && !input.context) return false

    const startInput = {
      threadId: input.thread,
      cwd:
        input.context?.projectPath ?? directBinding?.cwd ?? startBinding?.cwd,
      ...(input.context?.modelSelection
        ? { modelSelection: input.context.modelSelection }
        : directBinding?.modelSelection
          ? { modelSelection: directBinding.modelSelection }
          : startBinding?.modelSelection
            ? {
                modelSelection: {
                  ...startBinding.modelSelection,
                  instanceId: input.instance.instanceId,
                },
              }
            : {}),
      resumeCursor:
        recoveryBinding?.resumeCursor ??
        (recoveryBinding?.providerThreadId
          ? { providerThreadId: recoveryBinding.providerThreadId }
          : null),
      runtimeMode:
        input.context?.runtimeMode ??
        directBinding?.runtimeMode ??
        startBinding?.runtimeMode,
    }
    if (!stoppedActiveSession) {
      const liveSessions = await this.inspectLiveSessionsForAdmission(
        input.instance
      )
      const targetSessions =
        liveSessions.get(input.instance.adapter) ?? new Set<string>()
      if (targetSessions.has(input.thread)) {
        throw new ProviderSessionInspectionError(
          `Provider instance '${input.instance.instanceId}' reported inconsistent state for session '${input.thread}'.`
        )
      }
      this.capacity.assertSessionCapacity(input.instance, liveSessions)
    }
    this.host.assertAcceptingWork("create or recover provider session")
    let session: ProviderSession
    try {
      session = await this.host.runSessionOperation(
        input.instance,
        "startSession",
        () => input.instance.adapter.startSession(startInput)
      )
    } catch (err) {
      if (!(err instanceof ProviderBackendQuarantinedError)) {
        try {
          await this.host.runSessionOperation(
            input.instance,
            "startSession",
            () =>
              restoreStoppedSession(
                input.instance.adapter,
                stoppedActiveSession
              )
          )
        } catch {
          // The original start failure is the one the turn should see.
        }
      }
      throw err
    }
    this.rememberKnownLiveSession(input.instance.adapter, input.thread)
    let startedSessionVisible: boolean
    try {
      startedSessionVisible = input.instance.adapter.hasSession(input.thread)
    } catch (error) {
      throw new ProviderSessionInspectionError(
        `Could not confirm newly started provider session '${input.thread}' for instance '${input.instance.instanceId}'.`,
        error
      )
    }
    const confirmedSession = await this.readLiveAdapterSession(
      input.instance,
      input.thread
    )
    if (!startedSessionVisible || !confirmedSession) {
      throw new ProviderSessionInspectionError(
        `Provider instance '${input.instance.instanceId}' did not expose newly started session '${input.thread}' consistently.`
      )
    }
    if (stoppedActiveSession) {
      this.host.emitSessionExited({
        threadId: input.thread,
        providerKind,
        providerInstanceId: input.instance.instanceId,
        reason: "session context changed",
      })
    }
    input.bindings?.setProviderThreadId({
      threadId: input.thread,
      providerKind,
      providerInstanceId: input.instance.instanceId,
      providerThreadId: session.providerThreadId,
      resumeCursor:
        session.resumeCursor !== undefined
          ? session.resumeCursor
          : (recoveryBinding?.resumeCursor ?? null),
      continuationKey:
        session.continuationKey ?? input.instance.continuationKey ?? null,
    })
    input.bindings?.updateSessionLifecycle({
      threadId: input.thread,
      providerKind,
      providerInstanceId: input.instance.instanceId,
      status: session.status,
      activeTurnId: session.activeTurnId,
    })
    this.host.emitSessionStarted({
      threadId: input.thread,
      providerKind,
      providerInstanceId: input.instance.instanceId,
      resumeCursor: session.resumeCursor ?? recoveryBinding?.resumeCursor,
    })
    return true
  }

  private async withSessionExitCorrelationSuppressed<T>(
    threadId: string,
    providerInstanceId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = this.sessionExitCorrelationKey(threadId, providerInstanceId)
    this.suppressedSessionExitCorrelation.set(
      key,
      (this.suppressedSessionExitCorrelation.get(key) ?? 0) + 1
    )
    try {
      return await operation()
    } finally {
      const remaining =
        (this.suppressedSessionExitCorrelation.get(key) ?? 1) - 1
      if (remaining <= 0) this.suppressedSessionExitCorrelation.delete(key)
      else this.suppressedSessionExitCorrelation.set(key, remaining)
    }
  }

  isSessionExitCorrelationSuppressed(
    threadId: string,
    providerInstanceId: string
  ): boolean {
    return (
      (this.suppressedSessionExitCorrelation.get(
        this.sessionExitCorrelationKey(threadId, providerInstanceId)
      ) ?? 0) > 0
    )
  }

  private sessionExitCorrelationKey(
    threadId: string,
    providerInstanceId: string
  ): string {
    return `${threadId}\u0000${providerInstanceId}`
  }

  private async withSessionAdmission<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const release = await this.acquireSessionAdmission()
    try {
      this.host.assertAcceptingWork("create or recover provider session")
      return await operation()
    } finally {
      release()
    }
  }

  private acquireSessionAdmission(): Promise<() => void> {
    this.host.assertAcceptingWork("create or recover provider session")
    if (!this.sessionAdmissionActive) {
      this.sessionAdmissionActive = true
      return Promise.resolve(() => this.releaseSessionAdmission())
    }
    if (
      this.sessionAdmissionWaiters.length >=
      this.capacity.sessionAdmissionQueueMaxEntries
    ) {
      throw new ProviderSessionAdmissionCapacityError(
        this.capacity.sessionAdmissionQueueMaxEntries
      )
    }
    return new Promise<() => void>((resolve, reject) => {
      this.sessionAdmissionWaiters.push({ resolve, reject })
    })
  }

  private releaseSessionAdmission(): void {
    if (!this.host.isAcceptingWork()) {
      this.rejectSessionAdmissionWaiters()
      this.sessionAdmissionActive = false
      return
    }
    const next = this.sessionAdmissionWaiters.shift()
    if (next) {
      next.resolve(() => this.releaseSessionAdmission())
      return
    }
    this.sessionAdmissionActive = false
    this.host.onSessionAdmissionIdle()
  }

  rejectSessionAdmissionWaiters(): void {
    const failure = new ProviderUpdateError(
      "Cannot create or recover provider session: provider service is shutting down.",
      503
    )
    for (const waiter of this.sessionAdmissionWaiters.splice(0)) {
      waiter.reject(failure)
    }
  }

  private async inspectLiveSessionsForAdmission(
    target: ProviderRuntimeInstance
  ): Promise<Map<ProviderAdapterShape, Set<string>>> {
    if (this.host.isRetainedAdapter(target.adapter)) {
      // A retained backend can still own sessions that are no longer safe to
      // enumerate. Blocking new sessions on it is the only fail-closed
      // accounting — but only on it: one adapter's failed retirement used to
      // refuse every session on every other provider, hub-wide.
      throw new ProviderSessionCapacityError("retained_backend")
    }

    const adapters = new Set<ProviderAdapterShape>([
      ...Array.from(this.host.instances(), (instance) => instance.adapter),
      ...this.knownLiveSessions.keys(),
    ])
    const result = new Map<ProviderAdapterShape, Set<string>>()
    for (const adapter of adapters) {
      const live = new Set<string>()
      for (const threadId of this.knownLiveSessions.get(adapter) ?? []) {
        live.add(threadId)
      }
      if (this.host.isRetainedAdapter(adapter)) {
        // Cannot ask it; count what we know it still owns so the global cap
        // stays conservative rather than optimistic.
        result.set(adapter, live)
        continue
      }
      const owner =
        Array.from(this.host.instances()).find(
          (candidate) => candidate.adapter === adapter
        ) ?? null
      const sessions = owner
        ? await this.host.runSessionOperation(owner, "listSessions", () =>
            readAdapterSessions(adapter)
          )
        : await this.host.raceInterruptBudget(
            () => readAdapterSessions(adapter),
            "listSessions"
          )
      for (const session of sessions) live.add(session.threadId)
      result.set(adapter, live)
    }
    return result
  }

  private rememberKnownLiveSession(
    adapter: ProviderAdapterShape,
    threadId: string
  ): void {
    let sessions = this.knownLiveSessions.get(adapter)
    if (!sessions) {
      sessions = new Set()
      this.knownLiveSessions.set(adapter, sessions)
    }
    sessions.add(threadId)
  }

  forgetKnownLiveSession(
    adapter: ProviderAdapterShape,
    threadId: string
  ): void {
    const sessions = this.knownLiveSessions.get(adapter)
    if (!sessions) return
    sessions.delete(threadId)
    if (sessions.size === 0) this.knownLiveSessions.delete(adapter)
  }

  persistActiveSessionsBeforeStopAll(
    bindings: ProviderSessionBindingStore | undefined,
    sessions: ReadonlyArray<ProviderHubSessionSnapshot>
  ): void {
    if (!bindings) return
    for (const session of sessions) {
      if (!session.active) continue
      const providerInstanceId =
        session.providerInstanceId ?? session.instanceId
      bindings.upsert({
        threadId: session.threadId,
        providerInstanceId,
        providerKind: session.providerKind,
        providerThreadId: session.providerThreadId,
        resumeCursor: session.resumeCursor ?? null,
        continuationKey: session.continuationKey ?? null,
        status: session.status,
        activeTurnId: session.activeTurnId,
        runtimeMode: session.runtimeMode ?? null,
        cwd: session.cwd ?? null,
      })
    }
  }

  markPersistedSessionsStopped(
    bindings: ProviderSessionBindingStore | undefined,
    stopFailureByAdapter: ReadonlyMap<ProviderAdapterShape, unknown>
  ): void {
    if (!bindings) return
    for (const binding of bindings.list()) {
      const instance = this.host.getInstance(binding.providerInstanceId)
      const stopFailure = instance
        ? stopFailureByAdapter.get(instance.adapter)
        : undefined
      if (stopFailure !== undefined) {
        bindings.updateSessionLifecycle({
          threadId: binding.threadId,
          providerInstanceId: binding.providerInstanceId,
          providerKind: binding.providerKind,
          status: "error",
          activeTurnId: binding.activeTurnId,
          lastError: "Provider session could not be stopped.",
        })
        continue
      }
      bindings.updateSessionLifecycle({
        threadId: binding.threadId,
        providerInstanceId: binding.providerInstanceId,
        providerKind: binding.providerKind,
        status: "stopped",
        activeTurnId: null,
      })
    }
  }

  private async readLiveAdapterSession(
    instance: ProviderRuntimeInstance,
    thread: ThreadId
  ): Promise<ProviderSession | null> {
    const sessions = await this.host.runSessionOperation(
      instance,
      "listSessions",
      () => readAdapterSessions(instance.adapter)
    )
    return sessions.find((session) => session.threadId === thread) ?? null
  }
}

async function readAdapterSessions(
  adapter: ProviderAdapterShape
): Promise<ReadonlyArray<ProviderSession>> {
  if (!adapter.listSessions) {
    throw new ProviderSessionInspectionError(
      `Provider adapter '${adapter.displayName}' cannot enumerate live sessions.`
    )
  }
  try {
    const sessions = await adapter.listSessions()
    if (!Array.isArray(sessions)) {
      throw new Error("listSessions() returned a non-array value")
    }
    for (const session of sessions) {
      if (
        !session ||
        typeof session !== "object" ||
        typeof session.threadId !== "string" ||
        session.threadId.length === 0
      ) {
        throw new Error("listSessions() returned an invalid session")
      }
    }
    return sessions
  } catch (error) {
    if (error instanceof ProviderSessionInspectionError) throw error
    throw new ProviderSessionInspectionError(
      `Could not enumerate live sessions for provider adapter '${adapter.displayName}'.`,
      error
    )
  }
}

async function restoreStoppedSession(
  adapter: ProviderAdapterShape,
  session: ProviderSession | null
): Promise<void> {
  if (!session) return
  try {
    await adapter.startSession({
      threadId: toThreadId(session.threadId),
      cwd: session.cwd,
      resumeCursor:
        session.resumeCursor ??
        (session.providerThreadId
          ? { providerThreadId: session.providerThreadId }
          : null),
      runtimeMode: session.runtimeMode ?? null,
    })
  } catch {
    // Best effort only: the original failure still describes why the requested
    // restart failed, and callers should surface that error.
  }
}

function shouldRestartActiveSessionForContext(
  activeSession: ProviderSession | null,
  context: {
    readonly cwd?: string | null
    readonly runtimeMode?: string | null
  }
): boolean {
  if (!activeSession) return false
  const activeCwd = normalizeSessionCwd(activeSession.cwd)
  const requestedCwd = normalizeSessionCwd(context.cwd)
  if (!!activeCwd && !!requestedCwd && activeCwd !== requestedCwd) return true
  const activeRuntimeMode = normalizeRuntimeMode(activeSession.runtimeMode)
  const requestedRuntimeMode = normalizeRuntimeMode(context.runtimeMode)
  return !!requestedRuntimeMode && activeRuntimeMode !== requestedRuntimeMode
}

function normalizeSessionCwd(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function sessionSnapshotKey(
  threadId: string,
  providerInstanceId: string
): string {
  return `${threadId}\u0000${providerInstanceId}`
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}
