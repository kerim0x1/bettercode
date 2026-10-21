import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { logger } from "../../observability/logger"
import { canonicalProviderKindAlias } from "./providerKindAliases"
import {
  type ApprovalRequestId,
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderInstanceMetadata,
  type ProviderKind,
  type ProviderModel,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ThreadId,
  approvalRequestId as toApprovalRequestId,
  threadId as toThreadId,
} from "./contracts"
import {
  observeAsync,
  providerTurnMetricAttributes,
  PROVIDER_TURN_DURATION_MS,
  PROVIDER_TURNS_TOTAL,
} from "../../observability/metrics"
import type { ProviderSessionBindingStore } from "./ProviderSessionBindingStore"
import { findConflictingProviderBinding } from "./ProviderSessionRecovery"
import { runtimeModeForTurn } from "./providerTurnOptions"
import type { EventNdjsonLogger } from "./EventNdjsonLogger"
import { HubAuditLog } from "./HubAuditLog"
import type {
  ProviderMaintenanceCommandResult,
  ProviderMaintenanceCommandRunnerInput,
  ProviderMaintenanceCapabilities,
} from "./ProviderMaintenance"
import {
  ProviderMaintenanceCoordinator,
  ProviderUpdateError,
} from "./ProviderMaintenanceCoordinator"
import {
  ProviderMetadataCapacityError,
  ProviderMetadataInputError,
} from "./ProviderMetadataCache"
import type { ProjectProviderPolicy } from "./projectProviderPolicy"
import { ProviderCatalogs } from "./ProviderCatalogs"
import type { ThreadTurnCoordinator } from "../threadTurnCoordinator"
import {
  hubTurnLifecycleHooks,
  type TurnLifecyclePolicy,
} from "../turnLifecyclePolicy"
import {
  normalizeTurnLimits,
  TURN_IDLE_TIMEOUT_DEFAULT_MS,
  TURN_MAX_DURATION_DEFAULT_MS,
} from "../turnLimits"
import {
  bindAgentPermissionRuntimeContext,
  clearAgentPermissionRuntimeContext,
  runWithAgentPermissionRuntimeContext,
} from "../agent-permission-runtime"
import { HubApprovalRequests } from "./HubApprovalRequests"
import { HubApprovalRouter } from "./HubApprovalRouter"
import * as SessionBudget from "./ProviderSessionOperationBudget"
import {
  ProviderBackendQuarantinedError,
  ProviderInstanceUnavailableError,
  ProviderOperationDeadlineError,
  ProviderSessionAdmissionCapacityError,
  ProviderSessionCapacityError,
  ProviderSessionInspectionError,
  ProviderStaleSessionCleanupError,
  ProviderTurnCapacityError,
  ProviderTurnConflictError,
  ProviderTurnDispatchCancelledError,
  ProviderTurnDispatchInputError,
  promiseWithDeadline,
  publicProviderDispatchErrorMessage,
} from "./ProviderHubErrors"
import type {
  ProviderHubSessionSnapshot,
  ProviderPreDispatchPolicyDecision,
  ProviderPreDispatchPolicyInput,
  ProviderRuntimeInstance,
  ProviderRuntimeInstanceSnapshot,
  ProviderTurnHandle,
} from "./ProviderHubTypes"
import { ProviderSessionRegistry } from "./ProviderSessionRegistry"
import {
  ProviderStatusService,
  isProviderMetadataChangedEvent,
  readProviderMetadataChangedCwd,
} from "./ProviderStatusService"
import { ProviderTurnCapacity } from "./ProviderTurnCapacity"

// The hub's data shapes and errors live in ProviderHubTypes / ProviderHubErrors
// so the modules split out of the hub can share them without importing it.
// Routes, `index.ts` and the tests keep importing them from here.
export type {
  ProviderHubSessionSnapshot,
  ProviderPreDispatchPolicyDecision,
  ProviderPreDispatchPolicyInput,
  ProviderRuntimeInstance,
  ProviderRuntimeInstanceSnapshot,
  ProviderRuntimeInstanceStatusProbe,
  ProviderTurnHandle,
} from "./ProviderHubTypes"
export type { ProviderCapacityScope } from "./ProviderHubErrors"

export interface ProviderHubOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape>
  readonly instances?: ReadonlyArray<ProviderRuntimeInstance>
  readonly statusCacheDir?: string | null
  readonly canonicalEventLogger?: EventNdjsonLogger | null
  readonly latestProviderVersionResolver?: (
    capabilities: ProviderMaintenanceCapabilities
  ) => Promise<string | null>
  readonly providerMaintenanceCommandRunner?: (
    input: ProviderMaintenanceCommandRunnerInput
  ) => Promise<ProviderMaintenanceCommandResult>
  readonly projectProviderPolicyLoader?: (
    cwd: string
  ) => Promise<ProjectProviderPolicy | null>
  readonly refreshInstances?: (input: {
    readonly instanceId?: string
  }) =>
    | ReadonlyArray<ProviderRuntimeInstance>
    | Promise<ReadonlyArray<ProviderRuntimeInstance>>
  /**
   * Inactivity watchdog for a turn: it fires only when the provider emitted
   * no event for the thread for this long, and it is paused while an
   * approval, plan approval or question waits for the user. Long agentic
   * runs that keep streaming are never cut off by it.
   */
  readonly turnTimeoutMs?: number
  /** Absolute ceiling for one turn, whatever its activity. */
  readonly turnMaxDurationMs?: number
  readonly threadTurnCoordinator?: ThreadTurnCoordinator
  /**
   * The checkpoint, trust and admission hooks shared with the direct-API
   * provider stack (see `provider/turnLifecyclePolicy.ts`). Production wiring
   * passes this; the three hooks below override its parts individually.
   */
  readonly turnLifecycle?: TurnLifecyclePolicy
  readonly beforeTurn?: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly projectPath?: string | null
    readonly providerKind: ProviderKind
    readonly providerInstanceId: string
  }) => Promise<void>
  /**
   * Provider-neutral policy boundary immediately before adapter.sendTurn().
   * Returning deny emits canonical tool.denied and completes the admission
   * normally without entering the adapter.
   */
  readonly preDispatchPolicy?: (
    input: ProviderPreDispatchPolicyInput
  ) =>
    | ProviderPreDispatchPolicyDecision
    | Promise<ProviderPreDispatchPolicyDecision>
  /** Runs after a correlated terminal event has been emitted to subscribers. */
  readonly afterTurn?: (event: ProviderRuntimeEvent) => Promise<void>
  readonly interruptTimeoutMs?: number
  /** Optional lower operational limits; values cannot exceed the hard caps. */
  readonly metadataConcurrencyLimit?: number
  readonly metadataQueueMaxEntries?: number
  readonly metadataInFlightMaxEntries?: number
  readonly listInstancesInFlightMaxEntries?: number
  /** Optional lower operational limits; values cannot exceed immutable caps. */
  readonly maxActiveTurns?: number
  readonly maxActiveTurnsPerProvider?: number
  /**
   * Applies to the selected runtime target. Instances sharing one adapter
   * share this limit because they ultimately consume the same backend.
   */
  readonly maxActiveTurnsPerInstance?: number
  readonly maxLiveSessions?: number
  /**
   * Applies to the selected runtime target. Instances sharing one adapter
   * share this limit so aliases cannot multiply backend session capacity.
   */
  readonly maxLiveSessionsPerInstance?: number
  readonly sessionAdmissionQueueMaxEntries?: number
  readonly onEvent?: (
    event: ProviderRuntimeEvent,
    provider: ProviderKind
  ) => void
}

// These errors moved with their modules (maintenance coordinator, metadata
// cache, hub errors); callers (routes, `index.ts`) still import them from here.
export {
  ProviderBackendQuarantinedError,
  ProviderInstanceUnavailableError,
  ProviderMetadataCapacityError,
  ProviderMetadataInputError,
  ProviderSessionAdmissionCapacityError,
  ProviderSessionCapacityError,
  ProviderSessionInspectionError,
  ProviderStaleSessionCleanupError,
  ProviderTurnCapacityError,
  ProviderTurnConflictError,
  ProviderUpdateError,
}

interface ProviderTurnAdmission {
  readonly admissionId: string
  readonly providerKind: ProviderKind
  providerInstanceId: string | null
  providerInstance: ProviderRuntimeInstance | null
  providerInstanceGeneration: number | null
  providerTurnId: string | null
  phase: "pending" | "active" | "interrupting"
  /** Inactivity watchdog; re-checked lazily against `lastActivityAt`. */
  timeoutHandle: ReturnType<typeof setTimeout> | null
  /** Absolute turn ceiling. */
  deadlineHandle: ReturnType<typeof setTimeout> | null
  lastActivityAt: number
  /** Open user-facing requests; the inactivity watchdog waits for them. */
  readonly pendingRequestIds: Set<string>
  completion: Promise<void> | null
  readonly dispatchQuiesced: Promise<void>
  readonly resolveDispatchQuiesced: () => void
  readonly terminalObserved: Promise<void>
  readonly resolveTerminalObserved: () => void
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
  readonly rejectSettled: (error: unknown) => void
  settlementStarted: boolean
  cancelRequested: boolean
  adapterDispatchStarted: boolean
  interruptPromise: Promise<void> | null
  pendingTerminalEvent: ProviderRuntimeEvent | null
  backendQuarantined: boolean
  quarantineFinalizerStarted: boolean
  readonly sharedToken?: symbol
}

interface ProviderBackendQuarantine {
  readonly quarantinedAt: number
  readonly reason: string
  readonly failure: ProviderBackendQuarantinedError
}

export class ProviderHub {
  /** No provider event for this long interrupts the turn as timed out. */
  static readonly TURN_IDLE_TIMEOUT_DEFAULT_MS = TURN_IDLE_TIMEOUT_DEFAULT_MS
  /** Generous absolute ceiling; streaming turns are bounded only by this. */
  static readonly TURN_MAX_DURATION_DEFAULT_MS = TURN_MAX_DURATION_DEFAULT_MS
  private readonly byProvider = new Map<ProviderKind, ProviderAdapterShape>()
  private readonly byInstance = new Map<string, ProviderRuntimeInstance>()
  private readonly quarantinedAdapters = new Map<
    ProviderAdapterShape,
    ProviderBackendQuarantine
  >()
  private readonly activeTurnSettlements = new Set<Promise<void>>()
  private readonly adapterSubscriptions = new Map<
    ProviderAdapterShape,
    () => void
  >()
  private readonly retiringAdapters = new Map<
    ProviderAdapterShape,
    Promise<void>
  >()
  /**
   * Keyed by the adapter whose retirement failed. An entry blocks pending
   * replacement and new-session admission until that adapter retires on a
   * later attempt or is dropped from the registry; it used to be an
   * append-only list that blocked forever after one failure.
   */
  private readonly retiredAdapterFailures = new Map<
    ProviderAdapterShape,
    unknown
  >()
  private readonly confirmedRetiredAdapters = new Set<ProviderAdapterShape>()
  private readonly bus = new EventEmitter()
  private readonly capacity: ProviderTurnCapacity
  private readonly sessions: ProviderSessionRegistry
  private readonly status: ProviderStatusService
  private readonly approvals: HubApprovalRouter
  private readonly onEvent?: (
    event: ProviderRuntimeEvent,
    provider: ProviderKind
  ) => void
  private readonly auditLog: HubAuditLog
  private readonly maintenance: ProviderMaintenanceCoordinator
  private readonly catalogs: ProviderCatalogs
  private readonly refreshInstances?: ProviderHubOptions["refreshInstances"]
  private readonly turnsByThread = new Map<string, ProviderTurnAdmission>()
  private readonly maintenanceByThread = new Set<string>()
  private providerInstanceGeneration = 0
  private pendingInstanceReplacement: ReadonlyArray<ProviderRuntimeInstance> | null =
    null
  private readonly turnTimeoutMs: number
  private readonly turnMaxDurationMs: number
  private readonly interruptTimeoutMs: number
  private readonly threadTurnCoordinator?: ThreadTurnCoordinator
  private readonly beforeTurn?: ProviderHubOptions["beforeTurn"]
  private readonly preDispatchPolicy?: ProviderHubOptions["preDispatchPolicy"]
  private readonly afterTurn?: ProviderHubOptions["afterTurn"]
  private acceptingWork = true
  private stopPromise: Promise<void> | null = null

  constructor(options: ProviderHubOptions) {
    this.onEvent = options.onEvent
    this.auditLog = new HubAuditLog(options.canonicalEventLogger ?? null)
    this.maintenance = new ProviderMaintenanceCoordinator(
      {
        getInstance: (instanceId) => this.byInstance.get(instanceId) ?? null,
        isQuarantined: (adapter) => this.quarantinedAdapters.has(adapter),
        listInstances: (input) => this.listInstances(input),
        refreshAndDrain: (instanceId) =>
          this.refreshProviderRuntimeInstance(instanceId),
        assertAcceptingWork: (operation) => this.assertAcceptingWork(operation),
      },
      {
        latestProviderVersionResolver: options.latestProviderVersionResolver,
        providerMaintenanceCommandRunner:
          options.providerMaintenanceCommandRunner,
      }
    )
    this.catalogs = new ProviderCatalogs(options.projectProviderPolicyLoader)
    this.refreshInstances = options.refreshInstances
    this.threadTurnCoordinator = options.threadTurnCoordinator
    const lifecycle = options.turnLifecycle
      ? hubTurnLifecycleHooks(options.turnLifecycle)
      : undefined
    this.beforeTurn = options.beforeTurn ?? lifecycle?.beforeTurn
    this.preDispatchPolicy =
      options.preDispatchPolicy ?? lifecycle?.preDispatchPolicy
    this.afterTurn = options.afterTurn ?? lifecycle?.afterTurn
    const turnLimits = normalizeTurnLimits({
      idleTimeoutMs: options.turnTimeoutMs,
      maxDurationMs: options.turnMaxDurationMs,
    })
    this.turnTimeoutMs = turnLimits.idleTimeoutMs
    this.turnMaxDurationMs = turnLimits.maxDurationMs
    this.interruptTimeoutMs = Math.max(
      1,
      Math.floor(options.interruptTimeoutMs ?? 5_000)
    )
    this.status = new ProviderStatusService(
      {
        instances: () => this.byInstance.values(),
        getInstance: (instanceId) => this.byInstance.get(instanceId),
        isQuarantined: (adapter) => this.quarantinedAdapters.has(adapter),
        retirementFailureOf: (adapter) =>
          this.retiredAdapterFailures.get(adapter),
        assertAcceptingWork: (operation) => this.assertAcceptingWork(operation),
      },
      {
        statusCacheDir: options.statusCacheDir,
        catalogs: this.catalogs,
        maintenance: this.maintenance,
        interruptTimeoutMs: this.interruptTimeoutMs,
        metadataConcurrencyLimit: options.metadataConcurrencyLimit,
        metadataQueueMaxEntries: options.metadataQueueMaxEntries,
        metadataInFlightMaxEntries: options.metadataInFlightMaxEntries,
        listInstancesInFlightMaxEntries:
          options.listInstancesInFlightMaxEntries,
      }
    )
    this.capacity = new ProviderTurnCapacity(options)
    this.sessions = new ProviderSessionRegistry(
      {
        instances: () => this.byInstance.values(),
        getInstance: (instanceId) => this.byInstance.get(instanceId),
        isQuarantined: (adapter) => this.quarantinedAdapters.has(adapter),
        quarantineOf: (adapter) => this.quarantinedAdapters.get(adapter),
        isRetainedAdapter: (adapter) => this.isRetainedAdapter(adapter),
        isAcceptingWork: () => this.acceptingWork,
        assertAcceptingWork: (operation) => this.assertAcceptingWork(operation),
        runSessionOperation: <T>(
          instance: ProviderRuntimeInstance,
          label: string,
          operation: () => Promise<T>
        ) => this.runSessionOperation(instance, label, operation),
        raceInterruptBudget: <T>(operation: () => Promise<T>, label: string) =>
          this.raceInterruptBudget(operation, label),
        emitSessionStarted: (input) => this.emitSessionStarted(input),
        emitSessionExited: (input) => this.emitSessionExited(input),
        onSessionAdmissionIdle: () =>
          this.applyPendingInstanceReplacementIfIdle(),
      },
      this.capacity
    )
    this.approvals = new HubApprovalRouter(
      new HubApprovalRequests({
        emit: (event, provider) => this.emitRuntimeEvent(event, provider),
        onError: (event, instanceId, provider, error) =>
          this.emitAndForwardError({
            threadId: event.threadId,
            providerKind: event.providerKind ?? provider,
            providerInstanceId: event.providerInstanceId ?? instanceId,
            message: publicProviderDispatchErrorMessage(error),
          }),
      }),
      {
        resolveInstance: (input) => this.resolveInstance(input),
        recoverSessionForThread: (input) =>
          this.sessions.recoverSessionForThread(input),
        activeTurnInstanceId: (thread) =>
          this.turnsByThread.get(thread)?.providerInstanceId,
      }
    )
    const instances =
      options.instances ??
      (options.adapters ?? []).map((adapter) => ({
        instanceId: adapter.provider,
        driver: adapter.provider,
        provider: adapter.provider,
        displayName: adapter.displayName,
        enabled: true,
        adapter,
      }))
    this.setInstancesInternal(instances)
  }

  replaceInstances(instances: ReadonlyArray<ProviderRuntimeInstance>): void {
    if (
      this.turnsByThread.size > 0 ||
      this.retiringAdapters.size > 0 ||
      this.sessions.hasAdmissionActivity()
    ) {
      // A turn is bound to the adapter generation that accepted it. Replacing
      // the registry here would unsubscribe that generation before its final
      // receipt and could route a later interrupt to a different process.
      this.pendingInstanceReplacement = [...instances]
      return
    }

    const nextAdapters = new Set(instances.map((instance) => instance.adapter))
    const removed = Array.from(this.byInstance.values()).filter(
      (instance, index, all) =>
        !nextAdapters.has(instance.adapter) &&
        all.findIndex((candidate) => candidate.adapter === instance.adapter) ===
          index
    )
    const unretired = removed.filter(
      (instance) => !this.confirmedRetiredAdapters.has(instance.adapter)
    )
    if (unretired.length > 0) {
      // Do not activate a replacement while a removed backend may still own
      // processes that can mutate the same workspace. Keep the old registry
      // and subscriptions live until every retirement is confirmed.
      this.pendingInstanceReplacement = [...instances]
      for (const instance of unretired) {
        this.retireAdapter(instance.adapter, instance)
      }
      return
    }
    this.setInstancesInternal(instances)
    for (const instance of removed) {
      this.confirmedRetiredAdapters.delete(instance.adapter)
    }
  }

  private setInstancesInternal(
    instances: ReadonlyArray<ProviderRuntimeInstance>
  ): void {
    this.providerInstanceGeneration += 1
    const generation = this.providerInstanceGeneration
    const previousAdapters = new Set(
      Array.from(this.byInstance.values()).map((i) => i.adapter)
    )
    const nextAdapters = new Set(instances.map((i) => i.adapter))
    for (const adapter of previousAdapters) {
      const unsubscribe = this.adapterSubscriptions.get(adapter)
      try {
        unsubscribe?.()
      } finally {
        this.adapterSubscriptions.delete(adapter)
      }
    }
    this.byProvider.clear()
    this.byInstance.clear()
    for (const adapter of this.quarantinedAdapters.keys()) {
      if (!nextAdapters.has(adapter) && !this.retiringAdapters.has(adapter)) {
        this.quarantinedAdapters.delete(adapter)
      }
    }
    for (const adapter of this.retiredAdapterFailures.keys()) {
      // The failed backend is no longer registered; its failure must not
      // keep blocking admission for the generation that replaced it.
      if (!nextAdapters.has(adapter) && !this.retiringAdapters.has(adapter)) {
        this.retiredAdapterFailures.delete(adapter)
      }
    }
    this.status.retainInstances(
      new Set(instances.map((instance) => instance.instanceId))
    )

    const subscribedAdapters = new Set<ProviderAdapterShape>()

    for (const instance of instances) {
      this.byInstance.set(instance.instanceId, instance)
      if (
        instance.enabled &&
        instance.provider &&
        !this.byProvider.has(instance.provider)
      ) {
        this.byProvider.set(instance.provider, instance.adapter)
      }
      if (subscribedAdapters.has(instance.adapter)) continue
      subscribedAdapters.add(instance.adapter)
      const unsubscribe = instance.adapter.subscribe((event) => {
        const correlated = this.correlateRuntimeEventWithInstance(
          instance,
          event
        )
        if (!correlated.ok) {
          this.emitAndForwardError({
            threadId: event.threadId,
            providerKind: instance.provider ?? instance.adapter.provider,
            providerInstanceId: instance.instanceId,
            message: correlated.error,
          })
          return
        }
        let normalized = correlated.event
        if (normalized.type === "session.exited") {
          this.sessions.forgetKnownLiveSession(
            instance.adapter,
            normalized.threadId
          )
        }
        const admission = this.turnsByThread.get(normalized.threadId)
        if (admission) this.observeTurnActivity(admission, normalized)
        const suppressSessionExitCorrelation =
          normalized.type === "session.exited" &&
          this.sessions.isSessionExitCorrelationSuppressed(
            normalized.threadId,
            normalized.providerInstanceId ?? instance.instanceId
          )
        const lifecycleEvent =
          normalized.type === "turn.started" ||
          normalized.type === "turn.completed" ||
          normalized.type === "turn.aborted" ||
          normalized.type === "session.exited"
        const admissionLifecycleEvent =
          !suppressSessionExitCorrelation &&
          lifecycleEvent &&
          this.isAdmissionLifecycleEventCorrelated(
            admission,
            normalized,
            generation
          )
        if (
          admission &&
          lifecycleEvent &&
          !suppressSessionExitCorrelation &&
          !admissionLifecycleEvent
        ) {
          this.emitAndForwardError({
            threadId: normalized.threadId,
            providerKind:
              normalized.providerKind ??
              instance.provider ??
              instance.adapter.provider,
            providerInstanceId:
              normalized.providerInstanceId ?? instance.instanceId,
            message: `Rejected uncorrelated ${normalized.type} event while provider turn '${admission.admissionId}' is active.`,
          })
          return
        }
        if (admissionLifecycleEvent && admission) {
          const rawPayload = (
            normalized as unknown as { readonly payload?: unknown }
          ).payload
          normalized = {
            ...normalized,
            payload: {
              ...(rawPayload &&
              typeof rawPayload === "object" &&
              !Array.isArray(rawPayload)
                ? rawPayload
                : {}),
              dispatchTurnId: admission.admissionId,
            },
          } as ProviderRuntimeEvent
        }
        const terminalAdmission = suppressSessionExitCorrelation
          ? null
          : this.observeTurnLifecycle(normalized, generation)
        if (isProviderMetadataChangedEvent(normalized)) {
          this.invalidateInstanceMetadata(
            normalized.providerInstanceId ?? instance.instanceId,
            readProviderMetadataChangedCwd(normalized)
          )
        }
        let terminalEmissionFailure: unknown
        try {
          this.emitRuntimeEvent(normalized, instance.provider)
          this.approvals.observe(instance, normalized)
        } catch (error) {
          // A listener failure — the ingestion lane rethrows for a terminal
          // event whose journal or projection failed — must not propagate
          // into the adapter's emit loop: that loop skips its own
          // bookkeeping (`activeDispatchTurnId`, the `session.exited` that
          // follows) when a listener throws. The failure is recorded on the
          // admission in `finally` so the turn settles as failed, not as
          // recorded; here it is only logged.
          terminalEmissionFailure = error
          logger.error(
            {
              err: error,
              thread: normalized.threadId,
              eventType: normalized.type,
              providerInstanceId:
                normalized.providerInstanceId ?? instance.instanceId,
              terminal: terminalAdmission !== null,
            },
            terminalAdmission
              ? "provider runtime event listener failed on a terminal event; the turn settles as failed"
              : "provider runtime event listener failed; event dropped for that listener"
          )
        } finally {
          if (terminalAdmission) {
            void this.finishClaimedTurnAdmission(
              normalized.threadId,
              terminalAdmission,
              normalized,
              terminalEmissionFailure
            ).catch(() => {
              // The public settled promise carries emission/hook failures.
            })
          }
        }
      })
      this.adapterSubscriptions.set(instance.adapter, unsubscribe)
    }
  }

  private retireAdapter(
    adapter: ProviderAdapterShape,
    instance: ProviderRuntimeInstance
  ): void {
    if (this.retiringAdapters.has(adapter)) return
    // Close admission before asking the backend to stop. Otherwise a slow
    // stopAll() leaves a window where a new turn can be dispatched to a
    // process generation that is already being retired.
    this.quarantineProviderBackend(
      instance,
      "backend retirement is in progress"
    )
    let retirementSucceeded = false
    const retirement = this.runInterruptWithTimeout(() => adapter.stopAll())
      .then(() => {
        retirementSucceeded = true
        this.confirmedRetiredAdapters.add(adapter)
        this.sessions.forgetAdapter(adapter)
        this.retiredAdapterFailures.delete(adapter)
      })
      .catch((error) => {
        this.retiredAdapterFailures.set(adapter, error)
        this.quarantineProviderBackend(
          instance,
          error instanceof Error ? error.message : String(error),
          true
        )
      })
      .finally(() => {
        if (this.retiringAdapters.get(adapter) === retirement) {
          this.retiringAdapters.delete(adapter)
        }
        if (retirementSucceeded) {
          this.applyPendingInstanceReplacementIfIdle()
        }
      })
    this.retiringAdapters.set(adapter, retirement)
    void retirement.catch(() => {
      // The retirement catches and records stop failures above. This observer
      // protects against a future cleanup callback failure.
    })
  }

  list(): ReadonlyArray<ProviderAdapterShape> {
    return Array.from(this.byProvider.values()).filter(
      (adapter) => !this.quarantinedAdapters.has(adapter)
    )
  }

  get(provider: ProviderKind): ProviderAdapterShape | null {
    const adapter = this.byProvider.get(provider)
    return adapter && !this.quarantinedAdapters.has(adapter) ? adapter : null
  }

  getInstance(instanceId: string): ProviderRuntimeInstance | null {
    return this.byInstance.get(instanceId) ?? null
  }

  resolve(input: {
    readonly provider?: ProviderKind | null
    readonly instanceId?: string | null
  }): ProviderAdapterShape | null {
    return this.resolveInstance(input)?.adapter ?? null
  }

  private resolveInstance(input: {
    readonly provider?: ProviderKind | null
    readonly instanceId?: string | null
  }): ProviderRuntimeInstance | null {
    if (input.instanceId) {
      const instance = this.byInstance.get(input.instanceId)
      const instanceProvider =
        instance?.provider ?? instance?.adapter.provider ?? null
      if (
        instance?.enabled &&
        !instance.unavailableReason &&
        !this.quarantinedAdapters.has(instance.adapter) &&
        (!input.provider || instanceProvider === input.provider)
      ) {
        return instance
      }
      return null
    }
    if (!input.provider) return null
    for (const instance of this.byInstance.values()) {
      if (
        instance.provider === input.provider &&
        instance.enabled &&
        !instance.unavailableReason &&
        !this.quarantinedAdapters.has(instance.adapter)
      ) {
        return instance
      }
    }
    return null
  }

  has(provider: ProviderKind): boolean {
    return this.get(provider) !== null
  }

  listInstances(
    input: { readonly cwd?: string | null } = {}
  ): Promise<ProviderRuntimeInstanceSnapshot[]> {
    return this.status.listInstances(input)
  }

  async updateProviderInstance(
    instanceId: string,
    input: { readonly cwd?: string | null } = {}
  ): Promise<{
    readonly instance: ProviderRuntimeInstanceSnapshot | null
    readonly providers: ReadonlyArray<ProviderRuntimeInstanceSnapshot>
  }> {
    return this.maintenance.updateInstance(instanceId, input)
  }

  private async refreshProviderRuntimeInstance(
    instanceId: string
  ): Promise<void> {
    const refreshed = await this.refreshInstances?.({ instanceId })
    if (refreshed) {
      this.replaceInstances(refreshed)
      await this.drainPendingInstanceReplacement()
    }
  }

  private async drainPendingInstanceReplacement(): Promise<void> {
    while (this.retiringAdapters.size > 0) {
      await Promise.all(this.retiringAdapters.values())
    }
    if (this.retiredAdapterFailures.size > 0) {
      throw new AggregateError(
        [...this.retiredAdapterFailures.values()],
        "One or more provider adapters failed to retire"
      )
    }
    if (this.pendingInstanceReplacement && this.turnsByThread.size > 0) {
      throw new ProviderUpdateError(
        "Provider replacement is deferred until active turns settle."
      )
    }
    this.applyPendingInstanceReplacementIfIdle()
  }

  refreshInstanceMetadata(
    instanceId: string,
    input: { readonly cwd?: string | null } = {}
  ): Promise<ProviderInstanceMetadata | null> {
    return this.status.refreshInstanceMetadata(instanceId, input)
  }

  invalidateInstanceMetadata(instanceId: string, cwd?: string | null): void {
    this.status.invalidateInstanceMetadata(instanceId, cwd)
  }

  listSessions(
    bindings?: ProviderSessionBindingStore
  ): Promise<ProviderHubSessionSnapshot[]> {
    return this.sessions.listSessions(bindings)
  }

  async modelsFor(
    provider: ProviderKind,
    input: { readonly cwd?: string | null } = {}
  ): Promise<ReadonlyArray<ProviderModel>> {
    this.assertAcceptingWork("list provider models")
    const adapter = this.get(provider)
    if (!adapter) return []
    return this.catalogs.modelsForTarget(
      {
        instanceId: provider,
        driver: provider,
        displayName: adapter.displayName,
      },
      adapter,
      input.cwd
    )
  }

  async modelsForInstance(
    instanceId: string,
    input: { readonly cwd?: string | null } = {}
  ): Promise<ReadonlyArray<ProviderModel>> {
    this.assertAcceptingWork("list provider models")
    const instance = this.byInstance.get(instanceId)
    if (!instance || !instance.enabled || instance.unavailableReason) return []
    return this.catalogs.modelsForTarget(instance, instance.adapter, input.cwd)
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.bus.on("event", listener)
    return () => {
      this.bus.off("event", listener)
    }
  }

  assertCanStartTurn(
    provider: ProviderKind,
    threadId: string,
    instanceId?: string | null
  ): void {
    this.assertAcceptingWork("start provider turn")
    if (this.maintenanceByThread.has(threadId)) {
      throw new ProviderTurnConflictError(threadId, `maintenance:${threadId}`)
    }
    const existing = this.turnsByThread.get(threadId)
    if (existing) {
      throw new ProviderTurnConflictError(
        threadId,
        existing.providerTurnId ?? existing.admissionId
      )
    }
    const instance = this.resolveInstance({
      provider,
      instanceId: instanceId ?? null,
    })
    if (!instance) {
      this.throwIfRequestedBackendQuarantined(provider, instanceId ?? null)
      throw new ProviderInstanceUnavailableError(provider, instanceId)
    }
    if (!instance.adapter.isConfigured()) {
      throw new ProviderUpdateError(
        `${instance.displayName ?? provider} is not configured`,
        400
      )
    }
    this.capacity.assertTurnCapacity(this.turnsByThread, provider, instance)
  }

  async sendTurn(
    provider: ProviderKind,
    input: ProviderSendTurnInput,
    options: {
      readonly bindings?: ProviderSessionBindingStore
      readonly sharedToken?: symbol
      readonly onAccepted?: (
        turnId: string,
        providerInstanceId: string | null
      ) => void
    } = {}
  ): Promise<void> {
    await this.startTurn(provider, input, options).completion
  }

  startTurn(
    provider: ProviderKind,
    input: ProviderSendTurnInput,
    options: {
      readonly bindings?: ProviderSessionBindingStore
      readonly sharedToken?: symbol
      readonly onAccepted?: (
        turnId: string,
        providerInstanceId: string | null
      ) => void
    } = {}
  ): ProviderTurnHandle {
    this.assertAcceptingWork("start provider turn")
    if (this.maintenanceByThread.has(input.threadId)) {
      throw new ProviderTurnConflictError(
        input.threadId,
        `maintenance:${input.threadId}`
      )
    }
    const existing = this.turnsByThread.get(input.threadId)
    if (existing) {
      throw new ProviderTurnConflictError(
        input.threadId,
        existing.providerTurnId ?? existing.admissionId
      )
    }

    const requestedInstanceId =
      typeof input.providerInstanceId === "string"
        ? input.providerInstanceId
        : typeof input.modelSelection?.instanceId === "string"
          ? input.modelSelection.instanceId
          : null
    const resolvedInstance = this.resolveInstance({
      provider,
      instanceId: requestedInstanceId,
    })
    if (!resolvedInstance) {
      this.throwIfRequestedBackendQuarantined(provider, requestedInstanceId)
    }
    // This check and the reservation below are deliberately synchronous. No
    // promise boundary exists where another caller could pass the same limit.
    this.capacity.assertTurnCapacity(
      this.turnsByThread,
      provider,
      resolvedInstance
    )

    const sharedToken =
      options.sharedToken ??
      this.threadTurnCoordinator?.reserveTurn(input.threadId, `hub:${provider}`)
    if (this.threadTurnCoordinator && !sharedToken) {
      throw new ProviderTurnConflictError(
        input.threadId,
        this.threadTurnCoordinator.activeOwner(input.threadId) ??
          `maintenance:${input.threadId}`
      )
    }
    const admissionId = randomUUID()
    const providerInstanceId =
      resolvedInstance?.instanceId ?? requestedInstanceId
    let resolveDispatchQuiesced!: () => void
    const dispatchQuiesced = new Promise<void>((resolve) => {
      resolveDispatchQuiesced = resolve
    })
    let resolveTerminalObserved!: () => void
    const terminalObserved = new Promise<void>((resolve) => {
      resolveTerminalObserved = resolve
    })
    let resolveSettled!: () => void
    let rejectSettled!: (error: unknown) => void
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve
      rejectSettled = reject
    })
    // Detached compatibility callers may only observe `completion`; keep a
    // rejection handler attached while preserving `settled`'s public state.
    void settled.catch(() => {})
    const admission: ProviderTurnAdmission = {
      admissionId,
      providerKind: provider,
      providerInstanceId,
      providerInstance: resolvedInstance,
      providerInstanceGeneration: resolvedInstance
        ? this.providerInstanceGeneration
        : null,
      providerTurnId: null,
      phase: "pending",
      timeoutHandle: null,
      deadlineHandle: null,
      lastActivityAt: Date.now(),
      pendingRequestIds: new Set<string>(),
      completion: null,
      dispatchQuiesced,
      resolveDispatchQuiesced,
      terminalObserved,
      resolveTerminalObserved,
      settled,
      resolveSettled,
      rejectSettled,
      settlementStarted: false,
      cancelRequested: false,
      adapterDispatchStarted: false,
      interruptPromise: null,
      pendingTerminalEvent: null,
      backendQuarantined: false,
      quarantineFinalizerStarted: false,
      ...(sharedToken ? { sharedToken } : {}),
    }
    this.turnsByThread.set(input.threadId, admission)
    this.scheduleTurnIdleCheck(input.threadId, admission, this.turnTimeoutMs)
    admission.deadlineHandle = setTimeout(
      () =>
        void this.timeoutTurn(
          input.threadId,
          admission,
          `Turn exceeded the maximum duration of ${this.turnMaxDurationMs}ms.`
        ),
      this.turnMaxDurationMs
    )
    admission.deadlineHandle.unref?.()

    try {
      options.onAccepted?.(admissionId, providerInstanceId)
    } catch (error) {
      this.clearTurnAdmission(input.threadId, admission)
      admission.resolveDispatchQuiesced()
      admission.resolveSettled()
      throw error
    }

    this.activeTurnSettlements.add(settled)
    void settled.then(
      () => this.activeTurnSettlements.delete(settled),
      () => this.activeTurnSettlements.delete(settled)
    )
    const dispatch = this.dispatchTurn(provider, input, options, admission)
    void dispatch.then(
      () => admission.resolveDispatchQuiesced(),
      () => admission.resolveDispatchQuiesced()
    )
    const completion = dispatch.then(
      () => {
        const current = this.turnsByThread.get(input.threadId)
        // Adapters that complete without emitting lifecycle events are
        // synchronous/stateless from the hub's perspective. Native adapters
        // move the admission to `active` through `turn.started` and remain
        // locked until their terminal event arrives.
        if (current === admission && current.phase === "pending") {
          const terminalEvent = {
            threadId: input.threadId,
            providerKind: admission.providerKind,
            ...(admission.providerInstanceId
              ? { providerInstanceId: admission.providerInstanceId }
              : {}),
            eventId: randomUUID(),
            at: Date.now(),
            type: "turn.completed",
            turnId: admission.admissionId,
            payload: {
              state: "completed",
              dispatchTurnId: admission.admissionId,
            },
          } as ProviderRuntimeEvent
          void this.emitTerminalAndFinalize(
            input.threadId,
            admission,
            terminalEvent
          ).catch(() => {
            // The public settled promise carries terminal-hook failures.
          })
        }
      },
      (error: unknown) => {
        if (
          this.turnsByThread.get(input.threadId) === admission &&
          admission.phase !== "interrupting" &&
          !admission.settlementStarted
        ) {
          const terminalEvent = this.makeTurnAbortedEvent(
            input.threadId,
            admission,
            publicProviderDispatchErrorMessage(error),
            "dispatch_failed"
          )
          void this.emitTerminalAndFinalize(
            input.threadId,
            admission,
            terminalEvent,
            error
          ).catch(() => {
            // The public settled promise carries dispatch/finalization errors.
          })
        }
        throw error
      }
    )
    void completion.catch(() => {
      // The returned completion promise retains its rejection state; this
      // observer protects detached compatibility callers.
    })
    admission.completion = completion

    return { turnId: admissionId, completion, settled }
  }

  async withThreadMaintenance<T>(
    threadId: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    const active = this.turnsByThread.get(threadId)
    if (active) {
      throw new ProviderTurnConflictError(
        threadId,
        active.providerTurnId ?? active.admissionId
      )
    }
    if (this.maintenanceByThread.has(threadId)) {
      throw new ProviderTurnConflictError(threadId, `maintenance:${threadId}`)
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
      throw new ProviderTurnConflictError(threadId, `maintenance:${threadId}`)
    }
    this.maintenanceByThread.add(threadId)
    try {
      const admission = this.turnsByThread.get(threadId)
      if (admission) {
        await this.interruptAdmission(threadId, admission, {
          reason: "provider.threadTeardown",
          status: "interrupted",
        })
      }

      const stoppedAdapters = new Set<ProviderAdapterShape>()
      for (const instance of this.byInstance.values()) {
        if (stoppedAdapters.has(instance.adapter)) continue
        stoppedAdapters.add(instance.adapter)
        if (this.quarantinedAdapters.has(instance.adapter)) continue
        const thread = toThreadId(threadId)
        if (!instance.adapter.hasSession(thread)) continue
        await this.runSessionOperation(instance, "stopSession", () =>
          instance.adapter.stopSession(thread)
        )
        this.sessions.forgetKnownLiveSession(instance.adapter, thread)
        this.emitSessionExited({
          threadId,
          providerKind: instance.provider ?? instance.adapter.provider,
          providerInstanceId: instance.instanceId,
          reason: "provider.threadTeardown",
        })
      }

      return await operation()
    } finally {
      this.maintenanceByThread.delete(threadId)
    }
  }

  private async dispatchTurn(
    provider: ProviderKind,
    input: ProviderSendTurnInput,
    options: { readonly bindings?: ProviderSessionBindingStore } = {},
    admission?: ProviderTurnAdmission
  ): Promise<void> {
    const instanceId =
      typeof input.providerInstanceId === "string"
        ? input.providerInstanceId
        : typeof input.modelSelection?.instanceId === "string"
          ? input.modelSelection.instanceId
          : null
    let metricModel = input.modelSelection?.model ?? input.modelId
    let metricInstanceId =
      instanceId ?? input.modelSelection?.instanceId ?? null
    return observeAsync(
      {
        counterName: PROVIDER_TURNS_TOTAL,
        timerName: PROVIDER_TURN_DURATION_MS,
        attributes: () =>
          providerTurnMetricAttributes({
            provider,
            model: metricModel,
            instanceId: metricInstanceId,
          }),
      },
      async () => {
        try {
          this.throwIfTurnDispatchCancelled(admission)
          const instance =
            admission?.providerInstance ??
            this.resolveInstance({ provider, instanceId })
          if (!instance)
            throw new ProviderTurnDispatchInputError(
              this.resolveFailureMessage(instanceId)
            )
          if (admission) {
            if (!admission.providerInstance) {
              admission.providerInstance = instance
              admission.providerInstanceGeneration =
                this.providerInstanceGeneration
            }
            admission.providerInstanceId = instance.instanceId
            if (instance.adapter.capabilities.managesOwnLifecycle) {
              admission.phase = "active"
            }
          }
          const adapter = instance.adapter
          if (!adapter.isConfigured())
            throw new ProviderTurnDispatchInputError(
              "Provider instance is not configured."
            )
          const binding = options.bindings?.get(
            input.threadId,
            instance.instanceId
          )
          const conflictingBinding = findConflictingProviderBinding({
            bindings: options.bindings,
            threadId: input.threadId,
            providerKind: provider,
          })
          const fallbackCwd = binding?.cwd ?? conflictingBinding?.cwd ?? null
          const requestedRuntimeMode = runtimeModeForTurn(input)
          const effectiveInput: ProviderSendTurnInput = {
            ...input,
            ...(input.projectPath == null &&
            typeof fallbackCwd === "string" &&
            fallbackCwd.trim().length > 0
              ? { projectPath: fallbackCwd }
              : {}),
            ...(input.modelSelection === undefined && binding?.modelSelection
              ? { modelSelection: binding.modelSelection }
              : {}),
          }
          const projectPolicy = await this.catalogs.assertInstanceAllowed({
            instance,
            projectPath: effectiveInput.projectPath,
          })
          this.throwIfTurnDispatchCancelled(admission)
          metricModel = effectiveInput.modelSelection?.model ?? input.modelId
          metricInstanceId = instance.instanceId
          this.catalogs.assertModelAllowed({
            instance,
            model: metricModel,
            policy: projectPolicy,
          })
          const sessionContext = {
            projectPath: effectiveInput.projectPath,
            modelSelection: effectiveInput.modelSelection,
            runtimeMode: requestedRuntimeMode,
          }
          const switchedProvider = Boolean(conflictingBinding)
          if (conflictingBinding && options.bindings) {
            await this.sessions.switchProviderForThread({
              instance,
              thread: toThreadId(input.threadId),
              bindings: options.bindings,
              sourceBinding: conflictingBinding,
              context: sessionContext,
            })
          } else {
            await this.sessions.recoverSessionForThread({
              instance,
              thread: toThreadId(input.threadId),
              bindings: options.bindings,
              context: sessionContext,
            })
          }
          this.throwIfTurnDispatchCancelled(admission)
          if (options.bindings) {
            if (
              effectiveInput.projectPath !== undefined ||
              effectiveInput.modelSelection !== undefined ||
              requestedRuntimeMode !== undefined
            ) {
              options.bindings.updateRuntimeContext?.({
                threadId: input.threadId,
                providerKind: provider,
                providerInstanceId: instance.instanceId,
                cwd: effectiveInput.projectPath,
                modelSelection: effectiveInput.modelSelection ?? null,
                ...(requestedRuntimeMode !== undefined
                  ? { runtimeMode: requestedRuntimeMode }
                  : {}),
              })
            }
          }
          if (!switchedProvider) {
            await this.sessions.stopStaleSessionsForThread({
              threadId: input.threadId,
              currentInstanceId: instance.instanceId,
            })
          }
          this.throwIfTurnDispatchCancelled(admission)
          if (admission) {
            await this.beforeTurn?.({
              threadId: input.threadId,
              turnId: admission.admissionId,
              projectPath: effectiveInput.projectPath,
              providerKind: provider,
              providerInstanceId: instance.instanceId,
            })
            this.throwIfTurnDispatchCancelled(admission)
            const policyDecision = await this.preDispatchPolicy?.({
              threadId: input.threadId,
              turnId: admission.admissionId,
              projectPath: effectiveInput.projectPath,
              appMode: effectiveInput.appMode,
              providerKind: provider,
              providerInstanceId: instance.instanceId,
            })
            this.throwIfTurnDispatchCancelled(admission)
            if (policyDecision?.decision === "deny") {
              // Some adapters manage their own lifecycle and were marked
              // active during recovery. No adapter dispatch occurred, so move
              // back to pending and let the normal completion path synthesize
              // the correlated successful terminal event.
              admission.phase = "pending"
              this.emitPreDispatchDenial({
                threadId: input.threadId,
                admission,
                providerInstanceId: instance.instanceId,
                toolName: policyDecision.toolName,
                reason: policyDecision.reason,
              })
              return
            }
          }
          this.throwIfTurnDispatchCancelled(admission)
          const permissionContext = {
            threadId: input.threadId,
            workspacePath: effectiveInput.projectPath,
            appMode: effectiveInput.appMode,
            chatMode: effectiveInput.chatMode,
            permissionLevel: effectiveInput.permissionLevel,
          }
          const permissionContextToken =
            bindAgentPermissionRuntimeContext(permissionContext)
          // The context must outlive `sendTurn`, not match it. Adapters that
          // manage their own lifecycle (Codex, and the ACP adapters) resolve
          // `sendTurn` as soon as the turn is *accepted* — every approval
          // request from that turn arrives afterwards. Releasing here left
          // `evaluateConfiguredAgentToolPermission` with no context for those
          // providers, so durable grants were silently inert: an explicit
          // `deny` the user configured quietly became "ask the user", and
          // `allow` grants stopped auto-approving. Bind for the whole turn and
          // release on settlement. A later turn on the same thread rebinds
          // with a fresh token, and `clearAgentPermissionRuntimeContext`
          // ignores a stale token, so overlapping releases cannot clobber it.
          let permissionContextReleased = false
          const releasePermissionContext = (): void => {
            if (permissionContextReleased) return
            permissionContextReleased = true
            clearAgentPermissionRuntimeContext(
              input.threadId,
              permissionContextToken
            )
          }
          if (admission) {
            void admission.settled.then(
              releasePermissionContext,
              releasePermissionContext
            )
          }
          try {
            await runWithAgentPermissionRuntimeContext(
              permissionContext,
              async () => {
                if (admission) admission.adapterDispatchStarted = true
                await adapter.sendTurn({
                  ...effectiveInput,
                  providerInstanceId: instance.instanceId,
                  ...(admission
                    ? { dispatchTurnId: admission.admissionId }
                    : {}),
                })
              }
            )
          } catch (dispatchError) {
            // Dispatch failed, so no turn is running to need the context.
            releasePermissionContext()
            throw dispatchError
          } finally {
            // Without an admission there is no settlement to wait for.
            if (!admission) releasePermissionContext()
          }
        } catch (err) {
          if (err instanceof ProviderTurnDispatchCancelledError) throw err
          logger.error(
            { err, threadId: input.threadId, providerInstanceId: instanceId },
            "provider turn dispatch failed"
          )
          this.emitAndForwardError({
            threadId: input.threadId,
            providerKind: provider,
            providerInstanceId: instanceId ?? undefined,
            message: publicProviderDispatchErrorMessage(err),
          })
          throw err
        }
      }
    )
  }

  private throwIfTurnDispatchCancelled(
    admission?: ProviderTurnAdmission
  ): void {
    if (!admission?.cancelRequested) return
    throw new ProviderTurnDispatchCancelledError(admission.admissionId)
  }

  async interruptTurn(provider: ProviderKind, thread: ThreadId): Promise<void> {
    const admission = this.turnsByThread.get(thread)
    if (admission?.providerKind === provider) {
      await this.interruptAdmission(thread, admission, {
        reason: "provider.interruptTurn",
        status: "interrupted",
      })
      return
    }
    const adapter = this.resolve({ provider })
    if (!adapter) {
      this.throwIfRequestedBackendQuarantined(provider, null)
      throw new ProviderInstanceUnavailableError(provider)
    }
    await this.runInterruptWithTimeout(() =>
      this.interruptAdapterTurn(adapter, thread)
    )
  }

  async interruptTurnIfActive(
    thread: ThreadId,
    expectedTurnId: string
  ): Promise<boolean> {
    const admission = this.turnsByThread.get(thread)
    if (!admission || admission.admissionId !== expectedTurnId) return false
    await this.interruptAdmission(thread, admission, {
      reason: "provider.remoteOwnerRevoked",
      status: "interrupted",
    })
    return true
  }

  async waitForThreadIdle(thread: string): Promise<void> {
    await this.turnsByThread.get(thread as ThreadId)?.settled
  }

  async interruptTurnForInstance(
    provider: ProviderKind,
    thread: ThreadId,
    instanceId?: string | null,
    bindings?: ProviderSessionBindingStore
  ): Promise<void> {
    let admission = this.turnsByThread.get(thread)
    if (
      admission?.providerKind === provider &&
      (!admission.providerInstanceId ||
        !instanceId ||
        admission.providerInstanceId === instanceId)
    ) {
      await this.interruptAdmission(thread, admission, {
        reason: "provider.interruptTurnForInstance",
        status: "interrupted",
      })
      return
    }
    const instance = this.resolveInstance({
      provider,
      instanceId: instanceId ?? null,
    })
    if (!instance) {
      this.throwIfRequestedBackendQuarantined(provider, instanceId ?? null)
      throw new ProviderInstanceUnavailableError(provider, instanceId)
    }
    await this.sessions.recoverSessionForThread({ instance, thread, bindings })
    admission = this.turnsByThread.get(thread)
    if (
      admission?.providerKind === provider &&
      (!admission.providerInstanceId ||
        admission.providerInstanceId === instance.instanceId)
    ) {
      await this.interruptAdmission(thread, admission, {
        reason: "provider.interruptTurnForInstance",
        status: "interrupted",
      })
      return
    }
    await this.runInterruptWithTimeout(() =>
      this.interruptAdapterTurn(instance.adapter, thread)
    )
  }

  respondToRequest(
    provider: ProviderKind,
    thread: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    instanceId?: string | null,
    bindings?: ProviderSessionBindingStore
  ): Promise<void> {
    return this.approvals.respondToRequest(
      provider,
      thread,
      requestId,
      decision,
      instanceId,
      bindings
    )
  }

  setPermissionMode(
    provider: ProviderKind,
    thread: ThreadId,
    mode: "default" | "plan" | "acceptEdits" | "bypassPermissions",
    instanceId?: string | null,
    bindings?: ProviderSessionBindingStore,
    permissionLevel?: string
  ): Promise<{ applied: "live" | "queued" | "unsupported" }> {
    return this.approvals.setPermissionMode(
      provider,
      thread,
      mode,
      instanceId,
      bindings,
      permissionLevel
    )
  }

  async rollbackConversation(
    provider: ProviderKind,
    thread: ThreadId,
    numTurns: number,
    instanceId?: string | null,
    bindings?: ProviderSessionBindingStore
  ): Promise<boolean> {
    const instance = this.resolveInstance({
      provider,
      instanceId: instanceId ?? null,
    })
    if (!instance?.adapter.rollbackThread) return false
    const recovered = await this.sessions.recoverSessionForThread({
      instance,
      thread,
      bindings,
    })
    if (!instance.adapter.hasSession(thread) && !recovered) return false
    await instance.adapter.rollbackThread(thread, numTurns)
    return true
  }

  /** Quarantined, retiring, or failed to retire: not safe to enumerate. */
  private isRetainedAdapter(adapter: ProviderAdapterShape): boolean {
    return (
      this.quarantinedAdapters.has(adapter) ||
      this.retiringAdapters.has(adapter) ||
      this.retiredAdapterFailures.has(adapter)
    )
  }

  async stopSession(
    provider: ProviderKind,
    thread: ThreadId,
    instanceId?: string | null
  ): Promise<void> {
    const instance = this.resolveInstance({
      provider,
      instanceId: instanceId ?? null,
    })
    if (!instance) return
    await this.runSessionOperation(instance, "stopSession", () =>
      instance.adapter.stopSession(thread)
    )
    this.sessions.forgetKnownLiveSession(instance.adapter, thread)
    this.emitSessionExited({
      threadId: thread,
      providerKind: instance.provider ?? instance.adapter.provider,
      providerInstanceId: instance.instanceId,
      reason: "provider.stopSession",
    })
  }

  beginShutdown(): void {
    this.acceptingWork = false
    this.sessions.rejectSessionAdmissionWaiters()
  }

  async interruptAllTurns(): Promise<number> {
    this.beginShutdown()
    const admissions = [...this.turnsByThread.entries()]
    const results = await Promise.allSettled(
      admissions.map(async ([threadId, admission]) => {
        if (this.turnsByThread.get(threadId) !== admission) return
        await this.interruptAdmission(threadId, admission, {
          reason: "provider.interruptAllTurns",
          status: "interrupted",
        })
      })
    )
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more provider turns failed to interrupt"
      )
    }
    return admissions.length
  }

  async stopAll(bindings?: ProviderSessionBindingStore): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopAllInternal(bindings)
    return this.stopPromise
  }

  private async stopAllInternal(
    bindings?: ProviderSessionBindingStore
  ): Promise<void> {
    this.beginShutdown()
    const admissions = [...this.turnsByThread.entries()]
    for (const [, admission] of admissions) {
      admission.cancelRequested = true
      admission.phase = "interrupting"
    }
    const backgroundOperations = [
      ...this.status.pendingOperations(),
      ...this.maintenance.pendingLockTails(),
      ...this.retiringAdapters.values(),
    ]
    let backgroundResults: PromiseSettledResult<unknown>[]
    try {
      backgroundResults = await promiseWithDeadline(
        () => Promise.allSettled(backgroundOperations),
        this.interruptTimeoutMs,
        `Provider shutdown wait did not complete within ${this.interruptTimeoutMs}ms`
      )
    } catch (error) {
      if (!(error instanceof ProviderOperationDeadlineError)) throw error
      backgroundResults = []
    }
    let sessionListingFailure: unknown = null
    const activeSessions = await this.listSessions(bindings).catch((error) => {
      sessionListingFailure = error
      return []
    })
    const sessionPersistenceFailures: unknown[] = []
    try {
      this.sessions.persistActiveSessionsBeforeStopAll(bindings, activeSessions)
    } catch (error) {
      // Saving resume state is best effort during shutdown; a database failure
      // must not prevent the providers from stopping their child processes.
      sessionPersistenceFailures.push(error)
    }
    const all = Array.from(
      new Set(Array.from(this.byInstance.values()).map((i) => i.adapter))
    )
    const stopResults = await Promise.allSettled(
      all.map((adapter) => {
        const quarantine = this.quarantinedAdapters.get(adapter)
        if (quarantine) return Promise.reject(quarantine.failure)
        return this.runInterruptWithTimeout(() => adapter.stopAll())
      })
    )
    const stopFailureByAdapter = new Map<ProviderAdapterShape, unknown>()
    for (const [index, result] of stopResults.entries()) {
      const adapter = all[index]
      if (result.status === "rejected") {
        if (adapter) {
          const instance = Array.from(this.byInstance.values()).find(
            (candidate) => candidate.adapter === adapter
          )
          const failure = instance
            ? this.quarantineProviderBackend(
                instance,
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason)
              )
            : result.reason
          stopFailureByAdapter.set(adapter, failure)
        }
      } else if (adapter) {
        this.sessions.forgetAdapter(adapter)
      }
    }
    const finalizationResults = await Promise.allSettled(
      admissions.map(async ([threadId, admission]) => {
        if (admission.settlementStarted) return await admission.settled
        const instance =
          admission.providerInstance ??
          (admission.providerInstanceId
            ? this.byInstance.get(admission.providerInstanceId)
            : undefined)
        const stopFailure = instance
          ? stopFailureByAdapter.get(instance.adapter)
          : undefined
        if (stopFailure !== undefined) {
          await this.interruptAdmission(threadId, admission, {
            reason: "provider.stopAll",
            status: "interrupted",
            settlementFailure: stopFailure,
          })
          return
        }
        await this.finalizeInterruptedAdmission(
          threadId,
          admission,
          "provider.stopAll",
          "interrupted",
          undefined
        )
      })
    )
    const backgroundFailures = backgroundResults
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      )
      .map((result) => result.reason)
    backgroundFailures.push(...this.retiredAdapterFailures.values())
    backgroundFailures.push(...sessionPersistenceFailures)
    if (sessionListingFailure) backgroundFailures.push(sessionListingFailure)
    const stopFailures = stopResults
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      )
      .map((result) => result.reason)
    const turnFinalizationFailures = finalizationResults
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      )
      .map((result) => result.reason)
    const failures = [
      ...backgroundFailures,
      ...stopFailures,
      ...turnFinalizationFailures,
    ]
    try {
      for (const session of activeSessions) {
        if (!session.active) continue
        const instance = this.byInstance.get(
          session.providerInstanceId ?? session.instanceId
        )
        if (instance && stopFailureByAdapter.has(instance.adapter)) continue
        this.emitSessionExited({
          threadId: session.threadId,
          providerKind: session.providerKind,
          providerInstanceId: session.providerInstanceId ?? session.instanceId,
          reason: "provider.stopAll",
        })
      }
      this.sessions.markPersistedSessionsStopped(bindings, stopFailureByAdapter)
    } finally {
      this.auditLog.close()
      for (const [adapter, unsubscribe] of this.adapterSubscriptions) {
        try {
          unsubscribe()
        } catch (error) {
          failures.push(error)
        } finally {
          this.adapterSubscriptions.delete(adapter)
        }
      }
      this.bus.removeAllListeners()
    }
    if (failures.length > 0) {
      const message =
        backgroundFailures.length === 0 && turnFinalizationFailures.length === 0
          ? `${stopFailures.length} provider adapter(s) failed to stop`
          : `${failures.length} provider operation(s) failed during shutdown`
      throw new AggregateError(failures, message)
    }
  }

  private assertAcceptingWork(operation: string): void {
    if (this.acceptingWork) return
    throw new ProviderUpdateError(
      `Cannot ${operation}: provider service is shutting down.`,
      503
    )
  }

  private throwIfRequestedBackendQuarantined(
    provider: ProviderKind,
    instanceId: string | null
  ): void {
    const matching = instanceId
      ? [this.byInstance.get(instanceId)].filter(
          (instance): instance is ProviderRuntimeInstance =>
            instance !== undefined &&
            (instance.provider ?? instance.adapter.provider) === provider
        )
      : Array.from(this.byInstance.values()).filter(
          (instance) =>
            (instance.provider ?? instance.adapter.provider) === provider
        )
    const quarantine = matching
      .map((instance) => this.quarantinedAdapters.get(instance.adapter))
      .find((entry): entry is ProviderBackendQuarantine => entry !== undefined)
    if (quarantine) throw quarantine.failure
  }

  private quarantineProviderBackend(
    instance: ProviderRuntimeInstance,
    reason: string,
    replaceExisting = false
  ): ProviderBackendQuarantinedError {
    const existing = this.quarantinedAdapters.get(instance.adapter)
    if (existing && !replaceExisting) return existing.failure

    const quarantinedAt = existing?.quarantinedAt ?? Date.now()
    const failure = new ProviderBackendQuarantinedError(
      instance.instanceId,
      quarantinedAt,
      reason
    )
    this.quarantinedAdapters.set(instance.adapter, {
      quarantinedAt,
      reason,
      failure,
    })
    for (const admission of this.turnsByThread.values()) {
      if (admission.providerInstance?.adapter === instance.adapter) {
        admission.backendQuarantined = true
      }
    }
    for (const current of this.byInstance.values()) {
      if (current.adapter !== instance.adapter) continue
      this.status.invalidateInstanceCache(current.instanceId)
    }
    return failure
  }

  private resolveFailureMessage(instanceId: string | null): string {
    if (!instanceId) return "Provider instance was not found."
    const instance = this.byInstance.get(instanceId)
    if (!instance) return "Provider instance was not found."
    if (!instance.enabled) return "Provider instance is disabled."
    if (instance.unavailableReason) return "Provider instance is unavailable."
    const quarantine = this.quarantinedAdapters.get(instance.adapter)
    if (quarantine) return "Provider instance is temporarily unavailable."
    return "Provider instance is unavailable."
  }

  private correlateRuntimeEventWithInstance(
    instance: ProviderRuntimeInstance,
    event: ProviderRuntimeEvent
  ):
    | { readonly ok: true; readonly event: ProviderRuntimeEvent }
    | { readonly ok: false; readonly error: string } {
    const expectedProvider = instance.provider ?? instance.adapter.provider
    if (event.providerKind && event.providerKind !== expectedProvider) {
      return {
        ok: false,
        error: `Provider instance '${instance.instanceId}' is configured for '${expectedProvider}' but emitted event for '${event.providerKind}'.`,
      }
    }

    const eventProvider =
      typeof event.provider === "string" && event.provider.length > 0
        ? event.provider
        : undefined
    const eventDriverProvider = providerKindFromDriverAlias(eventProvider)
    if (
      eventProvider &&
      (!eventDriverProvider || eventDriverProvider !== expectedProvider)
    ) {
      return {
        ok: false,
        error: `Provider instance '${instance.instanceId}' is backed by driver '${expectedProvider}' but emitted driver '${event.provider}'.`,
      }
    }

    if (
      event.providerInstanceId &&
      event.providerInstanceId !== instance.instanceId
    ) {
      return {
        ok: false,
        error: `Provider instance '${instance.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
      }
    }

    return {
      ok: true,
      event: {
        ...event,
        provider: expectedProvider,
        providerKind: event.providerKind ?? expectedProvider,
        providerInstanceId: instance.instanceId,
      },
    }
  }

  private emitAndForwardError(input: {
    readonly threadId: string
    readonly providerKind: ProviderKind
    readonly providerInstanceId?: string
    readonly message: string
  }): void {
    const event = {
      threadId: input.threadId,
      providerKind: input.providerKind,
      ...(input.providerInstanceId
        ? { providerInstanceId: input.providerInstanceId }
        : {}),
      eventId: randomUUID(),
      at: Date.now(),
      type: "runtime.error",
      message: input.message,
      class: "provider_error",
    } as ProviderRuntimeEvent
    this.emitRuntimeEvent(event, input.providerKind)
  }

  private emitPreDispatchDenial(input: {
    readonly threadId: string
    readonly admission: ProviderTurnAdmission
    readonly providerInstanceId: string
    readonly toolName?: string
    readonly reason: string
  }): void {
    const event = {
      threadId: input.threadId,
      providerKind: input.admission.providerKind,
      providerInstanceId: input.providerInstanceId,
      eventId: randomUUID(),
      at: Date.now(),
      type: "tool.denied",
      turnId: input.admission.admissionId,
      payload: {
        toolName: input.toolName?.trim() || "AgentMode",
        reason:
          input.reason.trim() ||
          "Provider dispatch was denied by the workspace policy.",
      },
    } as ProviderRuntimeEvent
    this.emitRuntimeEvent(event, input.admission.providerKind)
  }

  private isAdmissionLifecycleEventCorrelated(
    admission: ProviderTurnAdmission | undefined,
    event: ProviderRuntimeEvent,
    sourceGeneration: number
  ): admission is ProviderTurnAdmission {
    if (!admission) return false
    if (admission.providerInstanceGeneration !== sourceGeneration) return false
    if (
      event.providerInstanceId &&
      admission.providerInstanceId &&
      event.providerInstanceId !== admission.providerInstanceId
    ) {
      return false
    }
    if (
      admission.providerTurnId &&
      event.turnId &&
      event.turnId !== admission.providerTurnId
    ) {
      return false
    }
    const dispatchTurnId = readDispatchTurnId(event)
    if (dispatchTurnId !== null) {
      return dispatchTurnId === admission.admissionId
    }

    // Once a dispatch-correlated start established the provider turn id,
    // subsequent events may bind by that immutable native id. Before then,
    // accepting any event merely because it names the same thread/instance
    // would let a delayed event from the previous turn claim this admission.
    return (
      Boolean(admission.providerTurnId) &&
      event.turnId === admission.providerTurnId
    )
  }

  private observeTurnLifecycle(
    event: ProviderRuntimeEvent,
    sourceGeneration: number
  ): ProviderTurnAdmission | null {
    const admission = this.turnsByThread.get(event.threadId)
    if (
      !this.isAdmissionLifecycleEventCorrelated(
        admission,
        event,
        sourceGeneration
      )
    )
      return null

    if (event.type === "turn.started") {
      admission.phase = "active"
      admission.providerTurnId = event.turnId ?? admission.providerTurnId
      return null
    }

    if (
      event.type !== "turn.completed" &&
      event.type !== "turn.aborted" &&
      event.type !== "session.exited"
    ) {
      return null
    }
    admission.cancelRequested = true
    admission.resolveTerminalObserved()
    if (admission.phase === "interrupting") {
      admission.pendingTerminalEvent ??= event
      return null
    }
    return this.claimTurnSettlement(admission) ? admission : null
  }

  private claimTurnSettlement(admission: ProviderTurnAdmission): boolean {
    if (admission.settlementStarted) return false
    admission.settlementStarted = true
    this.clearTurnWatchdogs(admission)
    return true
  }

  private clearTurnWatchdogs(admission: ProviderTurnAdmission): void {
    if (admission.timeoutHandle) {
      clearTimeout(admission.timeoutHandle)
      admission.timeoutHandle = null
    }
    if (admission.deadlineHandle) {
      clearTimeout(admission.deadlineHandle)
      admission.deadlineHandle = null
    }
  }

  /**
   * Every provider event for the admission's thread counts as activity.
   * Re-arming a timer per streamed token would churn timers, so activity only
   * moves `lastActivityAt`, and the pending check re-schedules itself for the
   * remaining idle budget when it fires early.
   */
  private observeTurnActivity(
    admission: ProviderTurnAdmission,
    event: ProviderRuntimeEvent
  ): void {
    if (admission.settlementStarted) return
    if (
      event.providerInstanceId &&
      admission.providerInstanceId &&
      event.providerInstanceId !== admission.providerInstanceId
    ) {
      return
    }
    admission.lastActivityAt = Date.now()
    const requestId = (event as { readonly requestId?: unknown }).requestId
    if (typeof requestId !== "string" || !requestId) return
    if (
      event.type === "request.opened" ||
      event.type === "approval.requested" ||
      event.type === "user-input.requested"
    ) {
      admission.pendingRequestIds.add(requestId)
    } else if (
      event.type === "request.resolved" ||
      event.type === "approval.resolved" ||
      event.type === "user-input.resolved"
    ) {
      admission.pendingRequestIds.delete(requestId)
      if (admission.pendingRequestIds.size === 0 && !admission.timeoutHandle) {
        this.scheduleTurnIdleCheck(
          event.threadId,
          admission,
          this.turnTimeoutMs
        )
      }
    }
  }

  private scheduleTurnIdleCheck(
    threadId: string,
    admission: ProviderTurnAdmission,
    delayMs: number
  ): void {
    if (admission.timeoutHandle) clearTimeout(admission.timeoutHandle)
    admission.timeoutHandle = setTimeout(
      () => this.checkTurnIdle(threadId, admission),
      Math.max(1, delayMs)
    )
    admission.timeoutHandle.unref?.()
  }

  private checkTurnIdle(
    threadId: string,
    admission: ProviderTurnAdmission
  ): void {
    admission.timeoutHandle = null
    if (
      admission.settlementStarted ||
      this.turnsByThread.get(threadId) !== admission
    ) {
      return
    }
    // Waiting on the user is not provider inactivity; the check is re-armed
    // when the last open request resolves.
    if (admission.pendingRequestIds.size > 0) return
    const remaining = admission.lastActivityAt + this.turnTimeoutMs - Date.now()
    if (remaining > 0) {
      this.scheduleTurnIdleCheck(threadId, admission, remaining)
      return
    }
    void this.timeoutTurn(
      threadId,
      admission,
      `Turn timed out after ${this.turnTimeoutMs}ms without provider activity.`
    )
  }

  private async finishClaimedTurnAdmission(
    threadId: string,
    admission: ProviderTurnAdmission,
    terminalEvent: ProviderRuntimeEvent,
    failure?: unknown
  ): Promise<void> {
    let finalFailure = failure
    try {
      // A terminal receipt can be emitted synchronously from inside
      // adapter.sendTurn(). Keep the admission fenced until that dispatch
      // promise has either returned or rejected.
      await admission.dispatchQuiesced
      if (this.afterTurn) await this.afterTurn(terminalEvent)
    } catch (hookError) {
      finalFailure =
        finalFailure === undefined
          ? hookError
          : new AggregateError(
              [finalFailure, hookError],
              "Provider turn finalization and afterTurn hook both failed"
            )
    } finally {
      this.clearTurnAdmission(threadId, admission)
    }

    if (finalFailure !== undefined) {
      admission.rejectSettled(finalFailure)
      throw finalFailure
    }
    admission.resolveSettled()
  }

  private async emitTerminalAndFinalize(
    threadId: string,
    admission: ProviderTurnAdmission,
    terminalEvent: ProviderRuntimeEvent,
    failure?: unknown
  ): Promise<void> {
    if (!this.claimTurnSettlement(admission)) {
      return await admission.settled
    }
    let finalFailure = failure
    try {
      this.emitRuntimeEvent(terminalEvent, admission.providerKind)
    } catch (emissionError) {
      finalFailure =
        finalFailure === undefined
          ? emissionError
          : new AggregateError(
              [finalFailure, emissionError],
              "Provider turn failed while emitting its terminal event"
            )
    }
    await this.finishClaimedTurnAdmission(
      threadId,
      admission,
      terminalEvent,
      finalFailure
    )
  }

  private async finalizeInterruptedAdmission(
    threadId: string,
    admission: ProviderTurnAdmission,
    reason: string,
    status: string,
    failure?: unknown
  ): Promise<void> {
    const terminalEvent =
      admission.pendingTerminalEvent ??
      this.makeTurnAbortedEvent(threadId, admission, reason, status)
    if (admission.pendingTerminalEvent) {
      if (!this.claimTurnSettlement(admission)) {
        return await admission.settled
      }
      await this.finishClaimedTurnAdmission(
        threadId,
        admission,
        terminalEvent,
        failure
      )
      return
    }
    await this.emitTerminalAndFinalize(
      threadId,
      admission,
      terminalEvent,
      failure
    )
  }

  private async interruptAdmission(
    threadId: string,
    admission: ProviderTurnAdmission,
    input: {
      readonly reason: string
      readonly status: string
      readonly settlementFailure?: unknown
    }
  ): Promise<void> {
    if (admission.settlementStarted) {
      return await admission.settled
    }
    if (this.turnsByThread.get(threadId) !== admission) {
      return await admission.settled
    }
    if (admission.interruptPromise) {
      return await admission.interruptPromise
    }
    admission.cancelRequested = true
    admission.phase = "interrupting"
    const interruptPromise = (async () => {
      const instance =
        admission.providerInstance ??
        this.resolveInstance({
          provider: admission.providerKind,
          instanceId: admission.providerInstanceId,
        })
      const interruptFailures: unknown[] = []
      if (instance && admission.adapterDispatchStarted) {
        try {
          await this.runInterruptWithTimeout(() =>
            this.interruptAdapterTurn(instance.adapter, toThreadId(threadId))
          )
        } catch (error) {
          interruptFailures.push(error)
          try {
            this.emitAndForwardError({
              threadId,
              providerKind: admission.providerKind,
              providerInstanceId: instance.instanceId,
              message: "Failed to interrupt provider turn safely.",
            })
          } catch (emissionError) {
            interruptFailures.push(emissionError)
          }
        }

        if (!admission.pendingTerminalEvent) {
          try {
            await this.waitForTurnTerminalWithTimeout(admission)
          } catch (error) {
            interruptFailures.push(error)
            const hardStopOperation = Promise.resolve().then(() =>
              instance.adapter.stopSession(toThreadId(threadId))
            )
            try {
              await this.runInterruptWithTimeout(() => hardStopOperation)
              try {
                this.emitSessionExited({
                  threadId,
                  providerKind: admission.providerKind,
                  providerInstanceId: instance.instanceId,
                  reason: "provider interrupt terminal confirmation failed",
                })
              } catch (emissionError) {
                interruptFailures.push(emissionError)
              }
            } catch (stopError) {
              interruptFailures.push(stopError)
              try {
                this.emitAndForwardError({
                  threadId,
                  providerKind: admission.providerKind,
                  providerInstanceId: instance.instanceId,
                  message:
                    "Failed to stop an uncertain provider session safely.",
                })
              } catch (emissionError) {
                interruptFailures.push(emissionError)
              }
              const quarantineFailure = this.quarantineProviderBackend(
                instance,
                stopError instanceof Error
                  ? stopError.message
                  : String(stopError)
              )
              interruptFailures.push(quarantineFailure)
              const finalFailure = combineProviderTurnFailures([
                ...(input.settlementFailure !== undefined
                  ? [input.settlementFailure]
                  : []),
                ...interruptFailures,
              ])
              this.continueQuarantinedAdmissionSettlement({
                threadId,
                admission,
                providerInstanceId: instance.instanceId,
                reason: input.reason,
                status: input.status,
                hardStopOperation,
                failure: finalFailure,
              })
              // The caller and shutdown coordinator receive a bounded hard
              // failure. The admission/coordinator/workspace fences remain
              // held until a terminal receipt or eventual hard-stop success
              // and dispatch quiescence prove that release is safe.
              throw finalFailure
            }
          }
        }
      }

      // Do not clear admission/workspace fences merely because interruption
      // timed out. A preflight cancellation must first prove that sendTurn
      // was never entered; an entered sendTurn must actually quiesce.
      await admission.dispatchQuiesced

      const finalFailures = [
        ...(input.settlementFailure !== undefined
          ? [input.settlementFailure]
          : []),
        ...interruptFailures,
      ]
      const finalFailure = combineProviderTurnFailures(finalFailures)
      await this.finalizeInterruptedAdmission(
        threadId,
        admission,
        input.reason,
        input.status,
        finalFailure
      )
    })()
    admission.interruptPromise = interruptPromise
    return await interruptPromise
  }

  private continueQuarantinedAdmissionSettlement(input: {
    readonly threadId: string
    readonly admission: ProviderTurnAdmission
    readonly providerInstanceId: string
    readonly reason: string
    readonly status: string
    readonly hardStopOperation: Promise<void>
    readonly failure: unknown
  }): void {
    if (input.admission.quarantineFinalizerStarted) return
    input.admission.quarantineFinalizerStarted = true

    const eventuallyStopped = input.hardStopOperation.then(
      () => true as const,
      () => new Promise<never>(() => {})
    )
    void (async () => {
      const hardStopConfirmed = await Promise.race([
        input.admission.terminalObserved.then(() => false as const),
        eventuallyStopped,
      ])
      let failure = input.failure
      if (hardStopConfirmed) {
        try {
          this.emitSessionExited({
            threadId: input.threadId,
            providerKind: input.admission.providerKind,
            providerInstanceId: input.providerInstanceId,
            reason: "quarantined provider backend eventually stopped",
          })
        } catch (error) {
          failure = combineProviderTurnFailures([failure, error])
        }
      }
      await input.admission.dispatchQuiesced
      await this.finalizeInterruptedAdmission(
        input.threadId,
        input.admission,
        input.reason,
        input.status,
        failure
      )
    })().catch(() => {
      // The public settled promise retains terminal/finalization failures.
    })
  }

  private async waitForTurnTerminalWithTimeout(
    admission: ProviderTurnAdmission
  ): Promise<void> {
    if (admission.pendingTerminalEvent) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Provider turn did not emit a terminal event within ${this.interruptTimeoutMs}ms after interruption`
            )
          ),
        this.interruptTimeoutMs
      )
      timer.unref?.()
    })
    try {
      await Promise.race([admission.terminalObserved, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Interrupts a turn and tells the adapter how long it has. The shared
   * adapter contract (`packages/schema`) does not carry the budget yet, so it
   * travels as an extra argument: adapters with an escalation ladder (Claude)
   * fit it into the budget, the others ignore it. Without it the ladder ran
   * past `runInterruptWithTimeout`, the hub hard-stopped the session, and the
   * adapter then emitted a `turn.aborted` behind the hub's `session.exited`.
   */
  private interruptAdapterTurn(
    adapter: ProviderAdapterShape,
    thread: ThreadId
  ): Promise<void> {
    const interrupt = adapter.interruptTurn as (
      thread: ThreadId,
      options?: { readonly interruptBudgetMs?: number }
    ) => Promise<void>
    return interrupt.call(adapter, thread, {
      interruptBudgetMs: this.interruptTimeoutMs,
    })
  }

  private throwIfAdapterQuarantined(instance: ProviderRuntimeInstance): void {
    const quarantine = this.quarantinedAdapters.get(instance.adapter)
    if (quarantine) throw quarantine.failure
  }

  private raceInterruptBudget<T>(
    operation: () => Promise<T>,
    label: string,
    timeoutMs = this.interruptTimeoutMs
  ): Promise<T> {
    return promiseWithDeadline(
      operation,
      timeoutMs,
      `Provider ${label} did not complete within ${timeoutMs}ms`
    )
  }

  /** Bounds one adapter call and quarantines it when its deadline expires. */
  private async runSessionOperation<T>(
    instance: ProviderRuntimeInstance,
    label: string,
    operation: () => Promise<T>
  ): Promise<T> {
    this.throwIfAdapterQuarantined(instance)
    const { interruptTimeoutMs } = this
    const timeoutMs = SessionBudget.get(instance, label, interruptTimeoutMs)
    try {
      return await this.raceInterruptBudget(operation, label, timeoutMs)
    } catch (error) {
      if (!(error instanceof ProviderOperationDeadlineError)) throw error
      SessionBudget.logDeadline(instance, label, timeoutMs)
      const failure = this.quarantineProviderBackend(
        instance,
        `Provider ${label} did not complete within ${timeoutMs}ms.`
      )
      void this.raceInterruptBudget(
        () => instance.adapter.stopAll(),
        "stopAll",
        SessionBudget.get(instance, "stopSession", interruptTimeoutMs)
      ).catch(() => {})
      throw failure
    }
  }

  private async runInterruptWithTimeout(
    operation: () => Promise<void>
  ): Promise<void> {
    await promiseWithDeadline(
      operation,
      this.interruptTimeoutMs,
      `Provider turn interruption did not complete within ${this.interruptTimeoutMs}ms`
    )
  }

  private makeTurnAbortedEvent(
    threadId: string,
    admission: ProviderTurnAdmission,
    reason: string,
    status: string
  ): ProviderRuntimeEvent {
    return {
      threadId,
      providerKind: admission.providerKind,
      ...(admission.providerInstanceId
        ? { providerInstanceId: admission.providerInstanceId }
        : {}),
      eventId: randomUUID(),
      at: Date.now(),
      type: "turn.aborted",
      turnId: admission.providerTurnId ?? admission.admissionId,
      payload: {
        reason,
        status,
        dispatchTurnId: admission.admissionId,
      },
    } as ProviderRuntimeEvent
  }

  private clearTurnAdmission(
    threadId: string,
    admission: ProviderTurnAdmission
  ): void {
    this.clearTurnWatchdogs(admission)
    if (this.turnsByThread.get(threadId) === admission) {
      this.turnsByThread.delete(threadId)
      if (admission.sharedToken) {
        this.threadTurnCoordinator?.releaseTurn(threadId, admission.sharedToken)
      }
      this.applyPendingInstanceReplacementIfIdle()
    }
  }

  private applyPendingInstanceReplacementIfIdle(): void {
    if (
      this.turnsByThread.size > 0 ||
      !this.pendingInstanceReplacement ||
      !this.acceptingWork ||
      this.sessions.hasAdmissionActivity() ||
      this.retiringAdapters.size > 0
    ) {
      return
    }
    // A recorded retirement failure does not hold the replacement here:
    // `replaceInstances` re-checks which removed adapters are unconfirmed and
    // retries their retirement, keeping the pending set until they are
    // confirmed gone. Holding on the failure hub-wide made one stuck backend
    // freeze every other provider's replacement for good.
    const instances = this.pendingInstanceReplacement
    this.pendingInstanceReplacement = null
    this.replaceInstances(instances)
  }

  private async timeoutTurn(
    threadId: string,
    admission: ProviderTurnAdmission,
    message: string
  ): Promise<void> {
    if (this.turnsByThread.get(threadId) !== admission) return
    if (admission.settlementStarted) return
    try {
      const timeoutError = new Error(message)
      await this.interruptAdmission(threadId, admission, {
        reason: timeoutError.message,
        status: "timed_out",
        settlementFailure: timeoutError,
      })
    } catch {
      // `settled` carries timeout/interrupt/afterTurn failures to the owner.
    }
  }

  private emitSessionExited(input: {
    readonly threadId: string
    readonly providerKind: ProviderKind
    readonly providerInstanceId: string
    readonly reason: string
  }): void {
    const event = {
      threadId: input.threadId,
      providerKind: input.providerKind,
      providerInstanceId: input.providerInstanceId,
      eventId: randomUUID(),
      at: Date.now(),
      type: "session.exited",
      payload: {
        reason: input.reason,
        exitKind: "graceful",
      },
    } satisfies ProviderRuntimeEvent
    this.emitRuntimeEvent(event, input.providerKind)
  }

  private emitSessionStarted(input: {
    readonly threadId: string
    readonly providerKind: ProviderKind
    readonly providerInstanceId: string
    readonly resumeCursor?: unknown
  }): void {
    const event = {
      threadId: input.threadId,
      providerKind: input.providerKind,
      providerInstanceId: input.providerInstanceId,
      eventId: randomUUID(),
      at: Date.now(),
      type: "session.started",
      payload: {
        ...(input.resumeCursor !== undefined
          ? { resume: input.resumeCursor }
          : {}),
      },
    } satisfies ProviderRuntimeEvent
    this.emitRuntimeEvent(event, input.providerKind)
  }

  /**
   * The single delivery lane for a canonical runtime event: durable
   * observability first, then the local bus, then the host's `onEvent`. The
   * order is load-bearing — the ingestion lane behind `onEvent` may throw on
   * a terminal event, and the journal/metric must already be written by then.
   * `hostProviderKind` is null for an instance without a provider kind; the
   * host callback is skipped in that case, the bus still fires.
   */
  private emitRuntimeEvent(
    event: ProviderRuntimeEvent,
    hostProviderKind: ProviderKind | null | undefined
  ): void {
    this.auditLog.write(event)
    this.auditLog.recordMetric(event)
    this.bus.emit("event", event)
    if (hostProviderKind) this.onEvent?.(event, hostProviderKind)
  }
}

function providerKindFromDriverAlias(
  value: string | undefined
): ProviderKind | null {
  const kind = canonicalProviderKindAlias(value)
  // The hub routes by adapter: the Codex CLI and the Codex adapter are the
  // same backend here, so the CLI alias folds into it.
  return kind === "codex_cli" ? "codex" : kind
}

function readDispatchTurnId(event: ProviderRuntimeEvent): string | null {
  const payload = (event as unknown as { readonly payload?: unknown }).payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null
  }
  const value = (payload as Record<string, unknown>).dispatchTurnId
  return typeof value === "string" && value.length > 0 ? value : null
}

function combineProviderTurnFailures(
  failures: ReadonlyArray<unknown>
): unknown | undefined {
  const defined = failures.filter((failure) => failure !== undefined)
  if (defined.length === 0) return undefined
  if (defined.length === 1) return defined[0]
  return new AggregateError(
    defined,
    "Provider turn finalization encountered multiple failures"
  )
}

export { toThreadId, toApprovalRequestId }
