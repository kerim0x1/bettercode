import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { isSensitiveProviderFieldName } from "@betterc0de/schema"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import { isProviderChatModeUnsupportedError } from "./providerChatModeErrors"
import { canonicalProviderKindAlias } from "./providerKindAliases"
import {
  type ApprovalRequestId,
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderAgent,
  type ProviderCapabilities,
  type ProviderCatalogEntry,
  type ProviderInstanceMetadata,
  type ProviderKind,
  type ProviderModel,
  type ProviderSession,
  type ProviderSkill,
  type ProviderSlashCommand,
  type ProviderTool,
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
import type {
  ProviderSessionBinding,
  ProviderSessionBindingStore,
} from "./ProviderSessionBindingStore"
import {
  findConflictingProviderBinding,
  selectRecoveryBinding,
} from "./ProviderSessionRecovery"
import { normalizeRuntimeMode, runtimeModeForTurn } from "./providerTurnOptions"
import type { EventNdjsonLogger } from "./EventNdjsonLogger"
import { HubAuditLog } from "./HubAuditLog"
import {
  createProviderVersionAdvisory,
  type ProviderMaintenanceCommandResult,
  type ProviderMaintenanceCommandRunnerInput,
  type ProviderMaintenanceCapabilities,
} from "./ProviderMaintenance"
import {
  ProviderMaintenanceCoordinator,
  ProviderUpdateError,
  recordConfig,
} from "./ProviderMaintenanceCoordinator"
import {
  ProviderMetadataCache,
  ProviderMetadataCapacityError,
  ProviderMetadataInputError,
  boundedProviderLimit,
  hydrateAndPersistInstanceSnapshot,
  normalizeProviderMetadataCwd,
  providerMetadataCwdKey,
  toSnapshotMetadata,
} from "./ProviderMetadataCache"
import {
  filterRuntimeModelsByProjectPolicy,
  type ProjectProviderPolicy,
} from "./projectProviderPolicy"
import {
  ProviderCatalogs,
  normalizeProviderModels,
  readAdapterModels,
} from "./ProviderCatalogs"
import { getMasterKey } from "../../settings/crypto"
import type { ThreadTurnCoordinator } from "../threadTurnCoordinator"
import {
  bindAgentPermissionRuntimeContext,
  clearAgentPermissionRuntimeContext,
  runWithAgentPermissionRuntimeContext,
} from "../agent-permission-runtime"
import { HubApprovalRequests } from "./HubApprovalRequests"

export interface ProviderRuntimeInstance {
  readonly instanceId: string
  readonly driver: string
  readonly provider: ProviderKind | null
  readonly displayName?: string
  readonly accentColor?: string
  readonly version?: string | null
  readonly installed?: boolean
  readonly enabled: boolean
  readonly unavailableReason?: string
  readonly continuationKey?: string
  readonly environment?: ReadonlyArray<{
    readonly name: string
    readonly value: string
    readonly sensitive?: boolean
    readonly valueRedacted?: boolean
    readonly secretState?: {
      readonly configured: boolean
      readonly storage: "encrypted" | "plaintext"
    }
  }>
  readonly config?: unknown
  readonly statusProbe?: (input: {
    readonly cwd?: string | null
    readonly refresh?: boolean
  }) =>
    | ProviderRuntimeInstanceStatusProbe
    | Promise<ProviderRuntimeInstanceStatusProbe>
  readonly adapter: ProviderAdapterShape
}

export interface ProviderRuntimeInstanceStatusProbe {
  readonly configured?: boolean
  readonly installed?: boolean
  readonly version?: string | null
  readonly status?: "ready" | "warning" | "error" | "disabled"
  readonly auth?: ProviderRuntimeInstanceSnapshot["auth"]
  readonly message?: string
}

export interface ProviderRuntimeInstanceSnapshot {
  readonly instanceId: string
  readonly driver: string
  readonly displayName: string
  readonly accentColor?: string
  readonly badgeLabel?: string
  readonly enabled: boolean
  readonly configured: boolean
  readonly installed: boolean
  readonly version: string | null
  readonly status: "ready" | "warning" | "error" | "disabled"
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown"
    readonly type?: string
    readonly label?: string
    readonly email?: string
  }
  readonly checkedAt: string
  readonly message?: string
  readonly availability: "available" | "unavailable"
  readonly unavailableReason?: string
  /** Set while this instance's backend refused to retire on replacement. */
  readonly retirementFailure?: string
  readonly continuation?: { readonly groupKey: string }
  readonly continuationKey?: string
  readonly showInteractionModeToggle?: boolean
  readonly environment: ReadonlyArray<{
    readonly name: string
    readonly value: string
    readonly sensitive?: boolean
    readonly valueRedacted?: boolean
    readonly secretState?: {
      readonly configured: boolean
      readonly storage: "encrypted" | "plaintext"
    }
  }>
  readonly config: Record<string, unknown>
  readonly capabilities: ProviderCapabilities
  readonly models: ReadonlyArray<ProviderModel>
  readonly providerCatalog: ReadonlyArray<ProviderCatalogEntry>
  readonly skills: ReadonlyArray<ProviderSkill>
  readonly agents: ReadonlyArray<ProviderAgent>
  readonly tools: ReadonlyArray<ProviderTool>
  readonly slashCommands: ReadonlyArray<ProviderSlashCommand>
  readonly versionAdvisory?: {
    readonly status: "unknown" | "current" | "behind_latest"
    readonly currentVersion: string | null
    readonly latestVersion: string | null
    readonly updateCommand: string | null
    readonly canUpdate: boolean
    readonly checkedAt: string | null
    readonly message: string | null
  }
  readonly updateState?: {
    readonly status:
      | "idle"
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "unchanged"
    readonly startedAt: string | null
    readonly finishedAt: string | null
    readonly message: string | null
    readonly output: string | null
  }
  readonly metadata?: ProviderInstanceMetadata
}

export interface ProviderHubSessionSnapshot extends ProviderSession {
  readonly providerKind: ProviderKind
  readonly instanceId: string
  readonly driver: string
  readonly displayName: string
  readonly runtimeMode?: string | null
  readonly generation: number
  readonly active: boolean
  readonly persisted: boolean
}

export interface ProviderPreDispatchPolicyInput {
  readonly threadId: string
  readonly turnId: string
  readonly projectPath?: string | null
  readonly appMode?: string | null
  readonly providerKind: ProviderKind
  readonly providerInstanceId: string
}

export type ProviderPreDispatchPolicyDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny"
      readonly reason: string
      readonly toolName?: string
    }

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
  readonly turnTimeoutMs?: number
  readonly threadTurnCoordinator?: ThreadTurnCoordinator
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
// cache); callers (routes, `index.ts`) still import them from here.
export {
  ProviderMetadataCapacityError,
  ProviderMetadataInputError,
  ProviderUpdateError,
}

export class ProviderTurnConflictError extends Error {
  readonly statusCode = 409
  readonly code = "turn_active"
  readonly activeTurnId: string

  constructor(threadId: string, activeTurnId: string) {
    super(`Thread '${threadId}' already has an active provider turn.`)
    this.name = "ProviderTurnConflictError"
    this.activeTurnId = activeTurnId
  }
}

export type ProviderCapacityScope = "global" | "provider" | "instance"

export class ProviderTurnCapacityError extends Error {
  readonly statusCode = 503
  readonly code = "provider_turn_capacity"

  constructor(
    readonly scope: ProviderCapacityScope,
    readonly limit: number
  ) {
    super(`Provider ${scope} active-turn capacity of ${limit} is exhausted.`)
    this.name = "ProviderTurnCapacityError"
  }
}

export class ProviderSessionCapacityError extends Error {
  readonly statusCode = 503
  readonly code = "provider_session_capacity"

  constructor(
    readonly scope: "global" | "instance" | "retained_backend",
    readonly limit: number | null = null
  ) {
    super(
      scope === "retained_backend"
        ? "Cannot create a provider session while a backend is quarantined or retiring."
        : `Provider ${scope} live-session capacity of ${limit} is exhausted.`
    )
    this.name = "ProviderSessionCapacityError"
  }
}

export class ProviderSessionInspectionError extends Error {
  readonly statusCode = 503
  readonly code = "provider_session_inspection_failed"
  readonly inspectionCause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "ProviderSessionInspectionError"
    this.inspectionCause = cause
  }
}

export class ProviderSessionAdmissionCapacityError extends Error {
  readonly statusCode = 503
  readonly code = "provider_session_admission_capacity"

  constructor(readonly limit: number) {
    super(`Provider session-admission queue capacity of ${limit} is exhausted.`)
    this.name = "ProviderSessionAdmissionCapacityError"
  }
}

export class ProviderStaleSessionCleanupError extends Error {
  readonly statusCode = 503
  readonly code = "provider_stale_session_cleanup_failed"
  readonly cleanupCause: unknown

  constructor(
    readonly instanceId: string,
    readonly threadId: string,
    cause: unknown
  ) {
    super("Provider session cleanup could not be completed.")
    this.name = "ProviderStaleSessionCleanupError"
    this.cleanupCause = cause
  }
}

export class ProviderInstanceUnavailableError extends Error {
  readonly statusCode = 404
  readonly code = "provider_instance_not_found"

  constructor(provider: ProviderKind, instanceId?: string | null) {
    super(
      instanceId
        ? `Provider instance '${instanceId}' is not available for '${provider}'.`
        : `Provider '${provider}' is not available.`
    )
    this.name = "ProviderInstanceUnavailableError"
  }
}

export class ProviderBackendQuarantinedError extends Error {
  readonly statusCode = 503
  readonly code = "provider_backend_quarantined"

  constructor(
    readonly instanceId: string,
    readonly quarantinedAt: number,
    _reason: string
  ) {
    super("Provider backend is temporarily unavailable.")
    this.name = "ProviderBackendQuarantinedError"
  }
}

class ProviderOperationDeadlineError extends Error {
  readonly code = "provider_operation_deadline"

  constructor(message: string) {
    super(message)
    this.name = "ProviderOperationDeadlineError"
  }
}

export interface ProviderTurnHandle {
  readonly turnId: string
  /** Adapter dispatch acknowledgement; not necessarily turn terminality. */
  readonly completion: Promise<void>
  /** Correlated terminal lifecycle plus afterTurn/interrupt finalization. */
  readonly settled: Promise<void>
}

class ProviderTurnDispatchCancelledError extends Error {
  constructor(readonly turnId: string) {
    super(`Provider turn '${turnId}' was cancelled before dispatch completed.`)
    this.name = "ProviderTurnDispatchCancelledError"
  }
}

class ProviderTurnDispatchInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderTurnDispatchInputError"
  }
}

interface ProviderTurnAdmission {
  readonly admissionId: string
  readonly providerKind: ProviderKind
  providerInstanceId: string | null
  providerInstance: ProviderRuntimeInstance | null
  providerInstanceGeneration: number | null
  providerTurnId: string | null
  phase: "pending" | "active" | "interrupting"
  timeoutHandle: ReturnType<typeof setTimeout> | null
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

interface ProviderSessionAdmissionWaiter {
  readonly resolve: (release: () => void) => void
  readonly reject: (error: unknown) => void
}

export class ProviderHub {
  private static readonly LIST_INSTANCES_IN_FLIGHT_MAX_ENTRIES = 64
  private static readonly ACTIVE_TURNS_DEFAULT = 32
  private static readonly ACTIVE_TURNS_HARD_MAX = 128
  private static readonly ACTIVE_TURNS_PER_PROVIDER_DEFAULT = 16
  private static readonly ACTIVE_TURNS_PER_PROVIDER_HARD_MAX = 64
  private static readonly ACTIVE_TURNS_PER_INSTANCE_DEFAULT = 8
  private static readonly ACTIVE_TURNS_PER_INSTANCE_HARD_MAX = 32
  private static readonly LIVE_SESSIONS_DEFAULT = 64
  private static readonly LIVE_SESSIONS_HARD_MAX = 256
  private static readonly LIVE_SESSIONS_PER_INSTANCE_DEFAULT = 16
  private static readonly LIVE_SESSIONS_PER_INSTANCE_HARD_MAX = 64
  private static readonly SESSION_ADMISSION_QUEUE_DEFAULT = 64
  private static readonly SESSION_ADMISSION_QUEUE_HARD_MAX = 256
  private readonly byProvider = new Map<ProviderKind, ProviderAdapterShape>()
  private readonly byInstance = new Map<string, ProviderRuntimeInstance>()
  private readonly quarantinedAdapters = new Map<
    ProviderAdapterShape,
    ProviderBackendQuarantine
  >()
  private readonly metadataCache: ProviderMetadataCache
  private readonly listInstancesInFlightMaxEntries: number
  private readonly suppressedSessionExitCorrelation = new Map<string, number>()
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
  private readonly approvals = new HubApprovalRequests({
    emit: (event, provider) => this.emitRuntimeEvent(event, provider),
    onError: (event, instanceId, provider, error) =>
      this.emitAndForwardError({
        threadId: event.threadId,
        providerKind: event.providerKind ?? provider,
        providerInstanceId: event.providerInstanceId ?? instanceId,
        message: publicProviderDispatchErrorMessage(error),
      }),
  })
  private readonly onEvent?: (
    event: ProviderRuntimeEvent,
    provider: ProviderKind
  ) => void
  private readonly statusCacheDir: string | null
  private readonly auditLog: HubAuditLog
  private readonly maintenance: ProviderMaintenanceCoordinator
  private readonly catalogs: ProviderCatalogs
  private readonly refreshInstances?: ProviderHubOptions["refreshInstances"]
  private readonly turnsByThread = new Map<string, ProviderTurnAdmission>()
  private readonly maintenanceByThread = new Set<string>()
  private readonly knownLiveSessions = new Map<
    ProviderAdapterShape,
    Set<string>
  >()
  private readonly sessionAdmissionWaiters: ProviderSessionAdmissionWaiter[] =
    []
  private sessionAdmissionActive = false
  private providerInstanceGeneration = 0
  private pendingInstanceReplacement: ReadonlyArray<ProviderRuntimeInstance> | null =
    null
  private readonly turnTimeoutMs: number
  private readonly interruptTimeoutMs: number
  private readonly maxActiveTurns: number
  private readonly maxActiveTurnsPerProvider: number
  private readonly maxActiveTurnsPerInstance: number
  private readonly maxLiveSessions: number
  private readonly maxLiveSessionsPerInstance: number
  private readonly sessionAdmissionQueueMaxEntries: number
  private readonly threadTurnCoordinator?: ThreadTurnCoordinator
  private readonly beforeTurn?: ProviderHubOptions["beforeTurn"]
  private readonly preDispatchPolicy?: ProviderHubOptions["preDispatchPolicy"]
  private readonly afterTurn?: ProviderHubOptions["afterTurn"]
  private acceptingWork = true
  private stopPromise: Promise<void> | null = null

  constructor(options: ProviderHubOptions) {
    this.onEvent = options.onEvent
    this.statusCacheDir = options.statusCacheDir ?? null
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
    this.beforeTurn = options.beforeTurn
    this.preDispatchPolicy = options.preDispatchPolicy
    this.afterTurn = options.afterTurn
    this.turnTimeoutMs = Math.max(
      1,
      Math.floor(options.turnTimeoutMs ?? 30 * 60_000)
    )
    this.interruptTimeoutMs = Math.max(
      1,
      Math.floor(options.interruptTimeoutMs ?? 5_000)
    )
    this.metadataCache = new ProviderMetadataCache({
      concurrencyLimit: options.metadataConcurrencyLimit,
      queueMaxEntries: options.metadataQueueMaxEntries,
      inFlightMaxEntries: options.metadataInFlightMaxEntries,
      probeTimeoutMs: Math.max(
        this.interruptTimeoutMs,
        ProviderMetadataCache.PROBE_TIMEOUT_MS
      ),
    })
    this.listInstancesInFlightMaxEntries = boundedProviderLimit(
      options.listInstancesInFlightMaxEntries,
      ProviderHub.LIST_INSTANCES_IN_FLIGHT_MAX_ENTRIES
    )
    this.maxActiveTurns = boundedProviderOperationalLimit(
      options.maxActiveTurns,
      ProviderHub.ACTIVE_TURNS_DEFAULT,
      ProviderHub.ACTIVE_TURNS_HARD_MAX
    )
    this.maxActiveTurnsPerProvider = boundedProviderOperationalLimit(
      options.maxActiveTurnsPerProvider,
      ProviderHub.ACTIVE_TURNS_PER_PROVIDER_DEFAULT,
      ProviderHub.ACTIVE_TURNS_PER_PROVIDER_HARD_MAX
    )
    this.maxActiveTurnsPerInstance = boundedProviderOperationalLimit(
      options.maxActiveTurnsPerInstance,
      ProviderHub.ACTIVE_TURNS_PER_INSTANCE_DEFAULT,
      ProviderHub.ACTIVE_TURNS_PER_INSTANCE_HARD_MAX
    )
    this.maxLiveSessions = boundedProviderOperationalLimit(
      options.maxLiveSessions,
      ProviderHub.LIVE_SESSIONS_DEFAULT,
      ProviderHub.LIVE_SESSIONS_HARD_MAX
    )
    this.maxLiveSessionsPerInstance = boundedProviderOperationalLimit(
      options.maxLiveSessionsPerInstance,
      ProviderHub.LIVE_SESSIONS_PER_INSTANCE_DEFAULT,
      ProviderHub.LIVE_SESSIONS_PER_INSTANCE_HARD_MAX
    )
    this.sessionAdmissionQueueMaxEntries = boundedProviderOperationalLimit(
      options.sessionAdmissionQueueMaxEntries,
      ProviderHub.SESSION_ADMISSION_QUEUE_DEFAULT,
      ProviderHub.SESSION_ADMISSION_QUEUE_HARD_MAX
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
      this.sessionAdmissionActive ||
      this.sessionAdmissionWaiters.length > 0
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
    this.metadataCache.retainInstances(
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
          this.forgetKnownLiveSession(instance.adapter, normalized.threadId)
        }
        const admission = this.turnsByThread.get(normalized.threadId)
        const suppressSessionExitCorrelation =
          normalized.type === "session.exited" &&
          this.isSessionExitCorrelationSuppressed(
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
        this.knownLiveSessions.delete(adapter)
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

  // Concurrent listInstances calls with the same cwd share one in-flight
  // promise. The frontend fans out (multiple mounted hooks × 30s poll ×
  // StrictMode) and every uncoalesced call used to trigger its own round
  // of status/model probes — i.e. child-process spawns — per instance.
  private readonly listInstancesInFlight = new Map<
    string,
    Promise<ProviderRuntimeInstanceSnapshot[]>
  >()

  listInstances(
    input: { readonly cwd?: string | null } = {}
  ): Promise<ProviderRuntimeInstanceSnapshot[]> {
    this.assertAcceptingWork("list provider instances")
    const cwd = normalizeProviderMetadataCwd(input.cwd)
    const key = providerMetadataCwdKey(cwd)
    const inFlight = this.listInstancesInFlight.get(key)
    if (inFlight) return inFlight
    if (
      this.listInstancesInFlight.size >= this.listInstancesInFlightMaxEntries
    ) {
      return Promise.reject(new ProviderMetadataCapacityError())
    }
    const promise = this.listInstancesUncoalesced({ cwd }).finally(() => {
      if (this.listInstancesInFlight.get(key) === promise) {
        this.listInstancesInFlight.delete(key)
      }
    })
    this.listInstancesInFlight.set(key, promise)
    return promise
  }

  private async listInstancesUncoalesced(
    input: { readonly cwd?: string | null } = {}
  ): Promise<ProviderRuntimeInstanceSnapshot[]> {
    const projectPolicy = await this.catalogs.loadProjectPolicy(
      input.cwd ?? null
    )
    return Promise.all(
      Array.from(this.byInstance.values()).map(async (instance) => {
        const quarantine = this.quarantinedAdapters.get(instance.adapter)
        const retirementFailure = this.retiredAdapterFailures.get(
          instance.adapter
        )
        const probe = quarantine
          ? null
          : await readInstanceStatusProbe(
              instance,
              { cwd: input.cwd ?? null },
              Math.max(
                this.interruptTimeoutMs,
                ProviderMetadataCache.PROBE_TIMEOUT_MS
              )
            )
        const effectiveUnavailableReason = quarantine
          ? "Provider instance is temporarily unavailable."
          : instance.unavailableReason
            ? "Provider instance is unavailable."
            : undefined
        const installed =
          probe?.installed ?? instance.installed ?? !instance.unavailableReason
        const configured =
          probe?.configured ??
          (!quarantine &&
            instance.enabled &&
            installed &&
            !instance.unavailableReason &&
            instance.adapter.isConfigured())
        const availability: ProviderRuntimeInstanceSnapshot["availability"] =
          effectiveUnavailableReason ? "unavailable" : "available"
        const cursorProbeUnavailable =
          instance.driver === "cursor" && instance.enabled && !probe
        const authStatus: ProviderRuntimeInstanceSnapshot["auth"]["status"] =
          probe?.auth?.status ??
          (cursorProbeUnavailable
            ? "unknown"
            : configured
              ? "authenticated"
              : "unknown")
        const checkedAt = new Date().toISOString()
        const status = quarantine
          ? "error"
          : cursorProbeUnavailable
            ? "warning"
            : (probe?.status ??
              providerSnapshotStatus({
                enabled: instance.enabled,
                installed,
                configured,
                unavailable: Boolean(instance.unavailableReason),
              }))
        const version = probe?.version ?? instance.version ?? null
        const config = recordConfig(instance.config)
        const environment = redactEnvironment(instance.environment ?? [])
        const maintenanceCapabilities =
          this.maintenance.capabilitiesFor(instance)
        const latestVersion =
          instance.enabled && installed && version
            ? await this.maintenance.latestVersionFor(maintenanceCapabilities)
            : null
        const message = publicProviderStatusMessage({
          enabled: instance.enabled,
          installed,
          configured,
          unavailableReason: effectiveUnavailableReason,
          probe,
        })
        const [metadata, models] = configured
          ? await Promise.all([
              this.metadataCache.read(instance, input.cwd, { force: false }),
              readAdapterModels(instance.adapter),
            ])
          : ([null, []] as const)
        const policyModels = filterRuntimeModelsByProjectPolicy(
          instance,
          models,
          projectPolicy
        )
        const cursorModelMessage =
          instance.driver === "cursor" && configured && models.length === 0
            ? "Cursor Agent did not provide selectable models through ACP. Check the CLI login, then refresh this provider."
            : undefined
        const snapshot = {
          instanceId: instance.instanceId,
          driver: instance.driver,
          displayName: instance.displayName ?? instance.adapter.displayName,
          ...(instance.accentColor
            ? { accentColor: instance.accentColor }
            : {}),
          enabled: instance.enabled,
          configured,
          installed,
          version,
          status: cursorModelMessage ? "warning" : status,
          auth: {
            status: authStatus,
            ...(probe?.auth?.type ? { type: probe.auth.type } : {}),
            ...(probe?.auth?.label ? { label: probe.auth.label } : {}),
            ...(probe?.auth?.email ? { email: probe.auth.email } : {}),
          },
          checkedAt,
          ...(cursorModelMessage || message || cursorProbeUnavailable
            ? {
                message:
                  cursorModelMessage ??
                  message ??
                  "Cursor Agent status could not be verified. Refresh this provider.",
              }
            : {}),
          availability,
          versionAdvisory: createProviderVersionAdvisory({
            driver: instance.driver,
            currentVersion: version,
            latestVersion,
            checkedAt,
            maintenanceCapabilities,
          }),
          ...(effectiveUnavailableReason
            ? { unavailableReason: effectiveUnavailableReason }
            : {}),
          ...(retirementFailure !== undefined
            ? {
                retirementFailure:
                  retirementFailure instanceof Error
                    ? retirementFailure.message
                    : String(retirementFailure),
              }
            : {}),
          ...(instance.continuationKey
            ? {
                continuation: { groupKey: instance.continuationKey },
                continuationKey: instance.continuationKey,
              }
            : {}),
          showInteractionModeToggle: true,
          environment,
          config: redactProviderConfig(config),
          capabilities: instance.adapter.capabilities,
          models: normalizeProviderModels(policyModels),
          providerCatalog: metadata?.providerCatalog ?? [],
          skills: metadata?.skills ?? [],
          agents: metadata?.agents ?? [],
          tools: metadata?.tools ?? [],
          slashCommands: metadata?.slashCommands ?? [],
          ...(this.maintenance.updateStateFor(instance.instanceId)
            ? {
                updateState: this.maintenance.updateStateFor(
                  instance.instanceId
                ),
              }
            : {}),
          ...(metadata ? { metadata: toSnapshotMetadata(metadata) } : {}),
        }
        return await hydrateAndPersistInstanceSnapshot(
          this.statusCacheDir,
          snapshot
        )
      })
    )
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

  async refreshInstanceMetadata(
    instanceId: string,
    input: { readonly cwd?: string | null } = {}
  ): Promise<ProviderInstanceMetadata | null> {
    this.assertAcceptingWork("refresh provider metadata")
    const instance = this.byInstance.get(instanceId)
    if (
      !instance ||
      !instance.enabled ||
      instance.unavailableReason ||
      this.quarantinedAdapters.has(instance.adapter) ||
      !instance.adapter.isConfigured()
    ) {
      return null
    }
    if (instance.statusProbe) {
      await readInstanceStatusProbe(
        instance,
        { cwd: input.cwd, refresh: true },
        Math.max(
          this.interruptTimeoutMs,
          ProviderMetadataCache.PROBE_TIMEOUT_MS
        )
      )
    }
    const metadata = await this.metadataCache.read(instance, input.cwd, {
      force: true,
    })
    await readAdapterModels(instance.adapter, { force: true })
    return toSnapshotMetadata(metadata)
  }

  invalidateInstanceMetadata(instanceId: string, cwd?: string | null): void {
    const normalizedCwd =
      cwd === undefined ? undefined : normalizeProviderMetadataCwd(cwd)
    const instance = this.byInstance.get(instanceId)
    if (instance && !this.quarantinedAdapters.has(instance.adapter)) {
      instance.adapter.invalidateMetadata?.(
        normalizedCwd === undefined ? undefined : { cwd: normalizedCwd }
      )
    }
    this.metadataCache.invalidate(instanceId, normalizedCwd)
  }

  async listSessions(
    bindings?: ProviderSessionBindingStore
  ): Promise<ProviderHubSessionSnapshot[]> {
    const sessions: ProviderHubSessionSnapshot[] = []
    const seen = new Set<string>()

    for (const instance of this.byInstance.values()) {
      if (
        !instance.enabled ||
        instance.unavailableReason ||
        this.quarantinedAdapters.has(instance.adapter) ||
        !instance.adapter.isConfigured()
      ) {
        continue
      }
      const activeSessions = await this.runSessionOperation(
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
        const instance = this.byInstance.get(binding.providerInstanceId)
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
    this.assertTurnCapacity(provider, instance)
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
    this.assertTurnCapacity(provider, resolvedInstance)

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
    admission.timeoutHandle = setTimeout(
      () => void this.timeoutTurn(input.threadId, admission),
      this.turnTimeoutMs
    )
    admission.timeoutHandle.unref?.()

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
        this.forgetKnownLiveSession(instance.adapter, thread)
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
            await this.switchProviderForThread({
              instance,
              thread: toThreadId(input.threadId),
              bindings: options.bindings,
              sourceBinding: conflictingBinding,
              context: sessionContext,
            })
          } else {
            await this.recoverSessionForThread({
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
            await this.stopStaleSessionsForThread({
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

  private async switchProviderForThread(input: {
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

  private async stopStaleSessionsForThread(input: {
    readonly threadId: string
    readonly currentInstanceId: string
  }): Promise<void> {
    const threadId = toThreadId(input.threadId)
    const currentAdapter = this.byInstance.get(input.currentInstanceId)?.adapter
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
    for (const instance of this.byInstance.values()) {
      if (inspectedAdapters.has(instance.adapter)) continue
      inspectedAdapters.add(instance.adapter)
      const quarantine = this.quarantinedAdapters.get(instance.adapter)
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
            this.runSessionOperation(instance, "stopSession", () =>
              instance.adapter.stopSession(input.threadId)
            )
        )
        this.forgetKnownLiveSession(instance.adapter, input.threadId)
        this.emitSessionExited({
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
    await this.recoverSessionForThread({ instance, thread, bindings })
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

  async respondToRequest(
    provider: ProviderKind,
    thread: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    instanceId?: string | null,
    bindings?: ProviderSessionBindingStore
  ): Promise<void> {
    const instance = this.resolveInstance({
      provider,
      instanceId: instanceId ?? null,
    })
    if (!instance)
      throw new ProviderInstanceUnavailableError(provider, instanceId)
    await this.recoverSessionForThread({ instance, thread, bindings })
    await instance.adapter.respondToRequest(thread, requestId, decision)
  }

  async setPermissionMode(
    provider: ProviderKind,
    thread: ThreadId,
    mode: "default" | "plan" | "acceptEdits" | "bypassPermissions",
    instanceId?: string | null,
    bindings?: ProviderSessionBindingStore,
    permissionLevel?: string
  ): Promise<{ applied: "live" | "queued" | "unsupported" }> {
    const instance = this.resolveInstance({
      provider,
      instanceId: instanceId ?? null,
    })
    if (!instance)
      throw new ProviderInstanceUnavailableError(provider, instanceId)
    const admission = this.turnsByThread.get(thread)
    if (
      admission?.providerInstanceId &&
      admission.providerInstanceId !== instance.instanceId
    ) {
      throw new ProviderInstanceUnavailableError(provider, instanceId)
    }
    const change = this.approvals.updatePermissionMode(
      thread,
      mode,
      permissionLevel
    )
    await this.approvals.reconcile(instance, thread)
    if (instance.adapter.setPermissionMode && change.nativeMode) {
      await this.recoverSessionForThread({ instance, thread, bindings })
      const native = await instance.adapter.setPermissionMode(
        thread,
        change.nativeMode
      )
      return { applied: change.applied === "live" ? "live" : native.applied }
    }
    return { applied: change.applied }
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
    const recovered = await this.recoverSessionForThread({
      instance,
      thread,
      bindings,
    })
    if (!instance.adapter.hasSession(thread) && !recovered) return false
    await instance.adapter.rollbackThread(thread, numTurns)
    return true
  }

  private async recoverSessionForThread(input: {
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
    this.assertAcceptingWork("create or recover provider session")
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
          this.runSessionOperation(input.instance, "stopSession", () =>
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
      this.assertSessionCapacity(input.instance, liveSessions)
    }
    this.assertAcceptingWork("create or recover provider session")
    let session: ProviderSession
    try {
      session = await this.runSessionOperation(
        input.instance,
        "startSession",
        () => input.instance.adapter.startSession(startInput)
      )
    } catch (err) {
      if (!(err instanceof ProviderBackendQuarantinedError)) {
        try {
          await this.runSessionOperation(input.instance, "startSession", () =>
            restoreStoppedSession(input.instance.adapter, stoppedActiveSession)
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
      this.emitSessionExited({
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
    this.emitSessionStarted({
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

  private isSessionExitCorrelationSuppressed(
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
      this.assertAcceptingWork("create or recover provider session")
      return await operation()
    } finally {
      release()
    }
  }

  private acquireSessionAdmission(): Promise<() => void> {
    this.assertAcceptingWork("create or recover provider session")
    if (!this.sessionAdmissionActive) {
      this.sessionAdmissionActive = true
      return Promise.resolve(() => this.releaseSessionAdmission())
    }
    if (
      this.sessionAdmissionWaiters.length >=
      this.sessionAdmissionQueueMaxEntries
    ) {
      throw new ProviderSessionAdmissionCapacityError(
        this.sessionAdmissionQueueMaxEntries
      )
    }
    return new Promise<() => void>((resolve, reject) => {
      this.sessionAdmissionWaiters.push({ resolve, reject })
    })
  }

  private releaseSessionAdmission(): void {
    if (!this.acceptingWork) {
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
    this.applyPendingInstanceReplacementIfIdle()
  }

  private rejectSessionAdmissionWaiters(): void {
    const failure = new ProviderUpdateError(
      "Cannot create or recover provider session: provider service is shutting down.",
      503
    )
    for (const waiter of this.sessionAdmissionWaiters.splice(0)) {
      waiter.reject(failure)
    }
  }

  /** Quarantined, retiring, or failed to retire: not safe to enumerate. */
  private isRetainedAdapter(adapter: ProviderAdapterShape): boolean {
    return (
      this.quarantinedAdapters.has(adapter) ||
      this.retiringAdapters.has(adapter) ||
      this.retiredAdapterFailures.has(adapter)
    )
  }

  private async inspectLiveSessionsForAdmission(
    target: ProviderRuntimeInstance
  ): Promise<Map<ProviderAdapterShape, Set<string>>> {
    if (this.isRetainedAdapter(target.adapter)) {
      // A retained backend can still own sessions that are no longer safe to
      // enumerate. Blocking new sessions on it is the only fail-closed
      // accounting — but only on it: one adapter's failed retirement used to
      // refuse every session on every other provider, hub-wide.
      throw new ProviderSessionCapacityError("retained_backend")
    }

    const adapters = new Set<ProviderAdapterShape>([
      ...Array.from(this.byInstance.values(), (instance) => instance.adapter),
      ...this.knownLiveSessions.keys(),
    ])
    const result = new Map<ProviderAdapterShape, Set<string>>()
    for (const adapter of adapters) {
      const live = new Set<string>()
      for (const threadId of this.knownLiveSessions.get(adapter) ?? []) {
        live.add(threadId)
      }
      if (this.isRetainedAdapter(adapter)) {
        // Cannot ask it; count what we know it still owns so the global cap
        // stays conservative rather than optimistic.
        result.set(adapter, live)
        continue
      }
      const owner =
        Array.from(this.byInstance.values()).find(
          (candidate) => candidate.adapter === adapter
        ) ?? null
      const sessions = owner
        ? await this.runSessionOperation(owner, "listSessions", () =>
            readAdapterSessions(adapter)
          )
        : await this.raceInterruptBudget(
            () => readAdapterSessions(adapter),
            "listSessions"
          )
      for (const session of sessions) live.add(session.threadId)
      result.set(adapter, live)
    }
    return result
  }

  private assertSessionCapacity(
    instance: ProviderRuntimeInstance,
    liveSessions: ReadonlyMap<ProviderAdapterShape, ReadonlySet<string>>
  ): void {
    let globalCount = 0
    for (const sessions of liveSessions.values()) globalCount += sessions.size
    if (globalCount >= this.maxLiveSessions) {
      throw new ProviderSessionCapacityError("global", this.maxLiveSessions)
    }
    const targetCount = liveSessions.get(instance.adapter)?.size ?? 0
    if (targetCount >= this.maxLiveSessionsPerInstance) {
      throw new ProviderSessionCapacityError(
        "instance",
        this.maxLiveSessionsPerInstance
      )
    }
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

  private forgetKnownLiveSession(
    adapter: ProviderAdapterShape,
    threadId: string
  ): void {
    const sessions = this.knownLiveSessions.get(adapter)
    if (!sessions) return
    sessions.delete(threadId)
    if (sessions.size === 0) this.knownLiveSessions.delete(adapter)
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
    this.forgetKnownLiveSession(instance.adapter, thread)
    this.emitSessionExited({
      threadId: thread,
      providerKind: instance.provider ?? instance.adapter.provider,
      providerInstanceId: instance.instanceId,
      reason: "provider.stopSession",
    })
  }

  beginShutdown(): void {
    this.acceptingWork = false
    this.rejectSessionAdmissionWaiters()
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
      ...this.listInstancesInFlight.values(),
      ...this.metadataCache.inFlightPromises(),
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
      this.persistActiveSessionsBeforeStopAll(bindings, activeSessions)
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
        this.knownLiveSessions.delete(adapter)
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
      this.markPersistedSessionsStopped(bindings, stopFailureByAdapter)
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

  private assertTurnCapacity(
    provider: ProviderKind,
    instance: ProviderRuntimeInstance | null
  ): void {
    if (this.turnsByThread.size >= this.maxActiveTurns) {
      throw new ProviderTurnCapacityError("global", this.maxActiveTurns)
    }

    let providerTurns = 0
    let instanceTurns = 0
    for (const admission of this.turnsByThread.values()) {
      if (admission.providerKind === provider) providerTurns += 1
      if (
        instance &&
        (admission.providerInstance?.adapter === instance.adapter ||
          (!admission.providerInstance &&
            admission.providerInstanceId === instance.instanceId))
      ) {
        instanceTurns += 1
      }
    }
    if (providerTurns >= this.maxActiveTurnsPerProvider) {
      throw new ProviderTurnCapacityError(
        "provider",
        this.maxActiveTurnsPerProvider
      )
    }
    if (instance && instanceTurns >= this.maxActiveTurnsPerInstance) {
      throw new ProviderTurnCapacityError(
        "instance",
        this.maxActiveTurnsPerInstance
      )
    }
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
      this.metadataCache.invalidateInstance(current.instanceId)
    }
    return failure
  }

  private persistActiveSessionsBeforeStopAll(
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

  private markPersistedSessionsStopped(
    bindings: ProviderSessionBindingStore | undefined,
    stopFailureByAdapter: ReadonlyMap<ProviderAdapterShape, unknown>
  ): void {
    if (!bindings) return
    for (const binding of bindings.list()) {
      const instance = this.byInstance.get(binding.providerInstanceId)
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
    if (admission.timeoutHandle) {
      clearTimeout(admission.timeoutHandle)
      admission.timeoutHandle = null
    }
    return true
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
    label: string
  ): Promise<T> {
    return promiseWithDeadline(
      operation,
      this.interruptTimeoutMs,
      `Provider ${label} did not complete within ${this.interruptTimeoutMs}ms`
    )
  }

  /**
   * Bounds one adapter call. On expiry the backend is quarantined and a
   * stop is attempted without holding the session-admission mutex.
   */
  private async runSessionOperation<T>(
    instance: ProviderRuntimeInstance,
    label: string,
    operation: () => Promise<T>
  ): Promise<T> {
    this.throwIfAdapterQuarantined(instance)
    try {
      return await this.raceInterruptBudget(operation, label)
    } catch (error) {
      if (!(error instanceof ProviderOperationDeadlineError)) throw error
      const failure = this.quarantineProviderBackend(
        instance,
        `Provider ${label} did not complete within ${this.interruptTimeoutMs}ms.`
      )
      void this.raceInterruptBudget(
        () => instance.adapter.stopAll(),
        "stopAll"
      ).catch(() => {})
      throw failure
    }
  }

  private async readLiveAdapterSession(
    instance: ProviderRuntimeInstance,
    thread: ThreadId
  ): Promise<ProviderSession | null> {
    const sessions = await this.runSessionOperation(
      instance,
      "listSessions",
      () => readAdapterSessions(instance.adapter)
    )
    return sessions.find((session) => session.threadId === thread) ?? null
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
    if (admission.timeoutHandle) {
      clearTimeout(admission.timeoutHandle)
      admission.timeoutHandle = null
    }
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
      this.sessionAdmissionActive ||
      this.sessionAdmissionWaiters.length > 0 ||
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
    admission: ProviderTurnAdmission
  ): Promise<void> {
    if (this.turnsByThread.get(threadId) !== admission) return
    try {
      const timeoutError = new Error(
        `Turn timed out after ${this.turnTimeoutMs}ms.`
      )
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

function boundedProviderOperationalLimit(
  requested: number | undefined,
  defaultValue: number,
  hardMaximum: number
): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return defaultValue
  }
  return Math.max(1, Math.min(hardMaximum, Math.floor(requested)))
}

function promiseWithDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const pending = Promise.resolve().then(operation)
  return new Promise<T>((resolve, reject) => {
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      settle()
    }
    timer = setTimeout(() => {
      finish(() => reject(new ProviderOperationDeadlineError(message)))
    }, timeoutMs)
    timer.unref?.()
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

async function readInstanceStatusProbe(
  instance: ProviderRuntimeInstance,
  input: { readonly cwd?: string | null; readonly refresh?: boolean },
  timeoutMs: number
): Promise<ProviderRuntimeInstanceStatusProbe | null> {
  if (
    !instance.enabled ||
    instance.unavailableReason ||
    !instance.statusProbe
  ) {
    return null
  }
  try {
    return await promiseWithDeadline(
      () => Promise.resolve(instance.statusProbe!(input)),
      timeoutMs,
      `Provider status probe did not complete within ${timeoutMs}ms`
    )
  } catch {
    return null
  }
}

function providerSnapshotStatus(input: {
  readonly enabled: boolean
  readonly installed: boolean
  readonly configured: boolean
  readonly unavailable: boolean
}): "ready" | "warning" | "error" | "disabled" {
  if (!input.enabled) return "disabled"
  if (input.unavailable || !input.installed) return "error"
  return input.configured ? "ready" : "warning"
}

function providerKindFromDriverAlias(
  value: string | undefined
): ProviderKind | null {
  const kind = canonicalProviderKindAlias(value)
  // The hub routes by adapter: the Codex CLI and the Codex adapter are the
  // same backend here, so the CLI alias folds into it.
  return kind === "codex_cli" ? "codex" : kind
}

function isProviderMetadataChangedEvent(event: ProviderRuntimeEvent): boolean {
  if (event.type === "provider.metadata.changed") return true
  if (event.type !== "config.warning" || !("payload" in event)) return false
  const payload = event.payload
  return (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "metadataKind" in payload
  )
}

function readProviderMetadataChangedCwd(
  event: ProviderRuntimeEvent
): string | null | undefined {
  if (!("payload" in event)) return undefined
  const payload = event.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return undefined
  const cwd = (payload as Record<string, unknown>).cwd
  return typeof cwd === "string" || cwd === null ? cwd : undefined
}

function redactEnvironment(
  environment: NonNullable<ProviderRuntimeInstance["environment"]>
): NonNullable<ProviderRuntimeInstanceSnapshot["environment"]> {
  return environment.map((envVar) => {
    if (!envVar.sensitive && !isSensitiveProviderFieldName(envVar.name))
      return envVar
    const configured = envVar.value.length > 0
    return {
      ...envVar,
      sensitive: true,
      value: "",
      valueRedacted: configured,
      secretState: {
        configured,
        storage: getMasterKey() ? "encrypted" : "plaintext",
      },
    }
  })
}

function redactProviderConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const redactValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redactValue)
    if (value !== null && typeof value === "object") {
      return redactProviderConfig(value as Record<string, unknown>)
    }
    return value
  }
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      isSensitiveProviderFieldName(key)
        ? {
            configured: typeof value === "string" && value.length > 0,
            storage: getMasterKey() ? "encrypted" : "plaintext",
          }
        : redactValue(value),
    ])
  )
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

function publicProviderStatusMessage(input: {
  readonly enabled: boolean
  readonly installed: boolean
  readonly configured: boolean
  readonly unavailableReason: string | undefined
  readonly probe: ProviderRuntimeInstanceStatusProbe | null
}): string | undefined {
  if (!input.enabled) return undefined
  if (input.unavailableReason) return input.unavailableReason
  if (!input.installed) return "Provider backend is not installed."
  // Prefer the adapter's own probe message: it is specific and actionable
  // (e.g. "Run `codex login`", or "authenticated, but the app-server metadata
  // probe failed — provider remains selectable"). The generic strings below
  // are last-resort fallbacks for probes that report a bad status without an
  // explanatory message.
  const probeMessage = input.probe?.message?.trim() || undefined
  if (input.probe?.auth?.status === "unauthenticated") {
    return probeMessage ?? "Provider authentication is required."
  }
  if (!input.configured)
    return probeMessage ?? "Provider instance is not configured."
  if (input.probe?.status === "error") {
    return probeMessage ?? "Provider status check failed."
  }
  if (input.probe?.status === "warning") {
    return probeMessage ?? "Provider status requires attention."
  }
  return undefined
}

function publicProviderDispatchErrorMessage(error: unknown): string {
  if (
    error instanceof HttpError ||
    error instanceof ProviderSessionInspectionError ||
    error instanceof ProviderSessionCapacityError ||
    error instanceof ProviderSessionAdmissionCapacityError ||
    error instanceof ProviderTurnDispatchInputError ||
    error instanceof ProviderStaleSessionCleanupError ||
    error instanceof ProviderBackendQuarantinedError ||
    error instanceof ProviderUpdateError ||
    // A provider that cannot honor the selected chat mode is the user's to
    // resolve — they can switch mode or provider — so the explanation must
    // reach them instead of the generic fault message.
    isProviderChatModeUnsupportedError(error)
  ) {
    return (error as Error).message
  }
  return "Provider turn dispatch failed."
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

export { toThreadId, toApprovalRequestId }
