/**
 * Types shared by the startup phases in `bootstrap/`. This module has no
 * runtime code: every phase is a plain function that takes the contexts built
 * by the phases before it and returns its own. `inProcess.ts` is the only
 * module that calls them, in the one order that the construction dependencies
 * allow — see `docs/architecture/overview.md`.
 */
import type http from "node:http"
import type { ServerConfig } from "../config"
import type { AppState } from "../appState"
import type { WsHub } from "../ws/server"
import type { RemoteTerminalChannel } from "../ws/terminalChannel"
import type { ShutdownStep } from "../shutdown"
import type { AdmissionGate } from "../lifecycle/AdmissionGate"
import type { Db } from "../persistence/db"
import type { EventStore } from "../persistence/eventStore"
import type { CommandReceiptStore } from "../persistence/commandReceipts"
import type {
  CheckpointDiffProjectionQuery,
  MessageProjectionQuery,
  ProjectProjectionQuery,
  ThreadActivityProjectionQuery,
  ThreadProjectionQuery,
  TurnProjectionQuery,
  WorktreeRegistryQuery,
} from "../persistence/projections"
import type { SettingsService } from "../settings/service"
import type { Settings } from "../settings/schema"
import type { ProviderAdapterRegistry } from "../provider/registry"
import type { ProviderService } from "../provider/service"
import type { ThreadTurnCoordinator } from "../provider/threadTurnCoordinator"
import type { AgentPermissionPolicy } from "../provider/agent-permission-policy"
import type {
  EventNdjsonLogger,
  ProviderHub,
  ProviderInstanceManager,
  ProviderRuntimeIngestion,
  ProviderRuntimeJournalRecoveryStore,
  ProviderRuntimeProjectionReceiptStore,
  ProviderSessionBindingStore,
  ProviderSessionReaper,
} from "../provider/runtime"
import type {
  AssistantTranscriptRecoveryStore,
  AssistantTranscriptRecoveryTarget,
} from "../provider/runtime/AssistantTranscriptRecoveryStore"
import type { SqlitePendingSourceProposedPlanImplementationStore } from "../provider/runtime/PendingSourceProposedPlanImplementationStore"
import type { CheckpointReactor } from "../checkpointing/CheckpointReactor"
import type { CheckpointRefCleanupStore } from "../checkpointing/CheckpointRefCleanupStore"
import type { CheckpointRefCleanupScheduler } from "../checkpointing/CheckpointRefCleanupScheduler"
import type { CheckpointRefOperationGate } from "../checkpointing/CheckpointRefOperationGate"
import type { CheckpointTurnSlotStore } from "../checkpointing/CheckpointTurnSlotStore"
import type { ThreadService } from "../services/threads"
import type { ChatLlmHelpers } from "../services/chat"
import type { WorktreeManager } from "../services/worktree"
import type { AuthStore } from "../auth/store"
import type { CheckpointRevertOperationStore } from "../services/checkpoint-revert-operations"
import type { ChatDispatchStore } from "../services/chat-dispatch-store"
import type { RemoteAccessService } from "../remote/service"
import type { RemoteProviderTurnOwnership } from "../remote/providerTurnOwnership"
import type { TailscaleRemoteAccess } from "../remote/tailscale"
import type { ThreadRetentionScheduler } from "../services/thread-retention"
import type { buildApp } from "../http/router"

export interface StartOptions {
  dataDir?: string
  preferredPort?: number
  webRoot?: string
  signal?: AbortSignal
  onStartupHeartbeat?: () => void
  onFatal?: (error: Error, origin: string) => void
}

export interface StartedBackend {
  readonly port: number
  readonly token: string
  readonly httpServer: http.Server
  readonly hub: WsHub
  readonly config: ServerConfig
  readonly state: AppState
  taint(error: Error, origin: string): void
  stop(): Promise<void>
}

/** A shutdown requester that shares one in-flight run (see `singleFlight`). */
export type ResourceShutdownRequester = () => Promise<number>

/**
 * Everything that exists before the first service is built: configuration,
 * the startup cleanup ledger, the admission gate and the taint machinery.
 * `startupCleanup` is one array shared by every phase; the unwind runs it
 * reversed, so the order in which phases push into it is load-bearing.
 */
export interface BootRoot {
  readonly options: StartOptions
  readonly config: ServerConfig
  readonly startupCleanup: ShutdownStep[]
  readonly requestAdmission: AdmissionGate
  readonly taint: {
    readonly taintBackend: (error: Error, origin: string) => void
    readonly isBackendTainted: () => boolean
    /**
     * Filled in once a listener is bound so that a taint raised during
     * startup can still trigger the emergency drain. Same object for the
     * whole boot; the port loop assigns `stop` on it.
     */
    readonly fatalLifecycle: { stop?: () => Promise<void> }
  }
  readonly resourceShutdowns: {
    readonly git: ResourceShutdownRequester
    readonly imageGeneration: ResourceShutdownRequester
    readonly nativeTextGeneration: ResourceShutdownRequester
    readonly workspace: ResourceShutdownRequester
  }
  readonly onStartupAbort: () => void
}

export interface PersistenceContext {
  readonly db: Db
  readonly eventStore: EventStore
  readonly receiptStore: CommandReceiptStore
  readonly threadProjections: ThreadProjectionQuery
  readonly messageProjections: MessageProjectionQuery
  readonly checkpointDiffs: CheckpointDiffProjectionQuery
  readonly turnProjections: TurnProjectionQuery
  readonly threadActivities: ThreadActivityProjectionQuery
  readonly providerSessionBindings: ProviderSessionBindingStore
  readonly providerRuntimeProjectionReceipts: ProviderRuntimeProjectionReceiptStore
  readonly providerRuntimeJournalRecoveryStore: ProviderRuntimeJournalRecoveryStore
  readonly projectProjections: ProjectProjectionQuery
  readonly worktreeRegistry: WorktreeRegistryQuery
  readonly threads: ThreadService
  readonly chatDispatches: ChatDispatchStore
  readonly agentPermissions: AgentPermissionPolicy
  /**
   * The permission policy is built before settings exist and reads them
   * through a holder; the settings phase binds the service here as soon as
   * it is constructed. Until then auto-trust stays off (fail closed).
   */
  readonly bindSettingsForTrust: (settings: SettingsService) => void
}

export interface SettingsContext {
  readonly settings: SettingsService
  readonly remoteAccess: RemoteAccessService
  readonly tailscale: TailscaleRemoteAccess
  readonly remoteProviderTurns: RemoteProviderTurnOwnership
  readonly unsubscribeRemoteOwnerCleanup: () => void
  readonly transcriptRecoveryStore: AssistantTranscriptRecoveryStore
  readonly transcriptRecoveryTarget: AssistantTranscriptRecoveryTarget
  readonly authStore: AuthStore
}

export interface ProvidersContext {
  readonly orchestratorHarness: import("../services/orchestrator/mcp").OrchestratorMcpHarness
  readonly codeSearch: import("../services/code-search/harness").CodeSearchHarness
  readonly providerRegistry: ProviderAdapterRegistry
  readonly providerInstanceManager: ProviderInstanceManager
  readonly providerHub: ProviderHub
  readonly unsubscribeProviderHubEvents: () => void
  readonly providerEventLoggers: EventNdjsonLogger[]
  readonly providers: ProviderService
  readonly threadTurnCoordinator: ThreadTurnCoordinator
  readonly chatHelpers: ChatLlmHelpers
  readonly worktrees: WorktreeManager
  readonly checkpointRefCleanupStore: CheckpointRefCleanupStore
  readonly checkpointRefOperationGate: CheckpointRefOperationGate
  readonly checkpointTurnSlots: CheckpointTurnSlotStore
  readonly registeredRepositories: string[]
  readonly checkpointReverts: CheckpointRevertOperationStore
  readonly sourceProposedPlanImplementations: SqlitePendingSourceProposedPlanImplementationStore
  readonly checkpointReactor: CheckpointReactor
  readonly checkpointRefCleanup: CheckpointRefCleanupScheduler
  readonly onSettingsChange: (next: Settings) => void
  readonly state: AppState
}

export interface TransportContext {
  readonly hub: WsHub
  /** Paired devices' terminals over the WebSocket. */
  readonly terminals: RemoteTerminalChannel
}

export interface RecoveryContext {
  readonly providerRuntimeIngestion: ProviderRuntimeIngestion
}

export interface RetentionContext {
  readonly threadRetention: ThreadRetentionScheduler
}

export interface TimersContext {
  readonly transcriptRecoveryTimer: NodeJS.Timeout
  readonly providerSessionReaper: ProviderSessionReaper | null
  readonly vacuumTimer: NodeJS.Timeout | null
}

export type HttpApp = ReturnType<typeof buildApp>
