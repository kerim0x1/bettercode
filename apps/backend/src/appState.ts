import type { Db } from "./persistence/db"
import type { ServerConfig } from "./config"
import type { EventStore } from "./persistence/eventStore"
import type { CommandReceiptStore } from "./persistence/commandReceipts"
import type {
  MessageProjectionQuery,
  CheckpointDiffProjectionQuery,
  ProjectProjectionQuery,
  ThreadActivityProjectionQuery,
  ThreadProjectionQuery,
  TurnProjectionQuery,
  WorktreeRegistryQuery,
} from "./persistence/projections"
import type { SettingsService } from "./settings/service"
import type { ProviderService } from "./provider/service"
import type { ProviderAdapterRegistry } from "./provider/registry"
import type { ThreadService } from "./services/threads"
import type { ChatLlmHelpers } from "./services/chat"
import type { WorktreeManager } from "./services/worktree"
import type { ProviderHub } from "./provider/runtime"
import type { ProviderSessionBindingStore } from "./provider/runtime"
import type { PendingSourceProposedPlanImplementationStore } from "./provider/runtime"
import type { EventNdjsonLogger } from "./provider/runtime"
import type { AuthStore } from "./auth/store"
import type { CheckpointRevertOperationStore } from "./services/checkpoint-revert-operations"
import type { CheckpointReactor } from "./checkpointing/CheckpointReactor"
import type { CheckpointTurnSlotStore } from "./checkpointing/CheckpointTurnSlotStore"
import type { ThreadTurnCoordinator } from "./provider/threadTurnCoordinator"
import type { AssistantTranscriptRecoveryStore } from "./provider/runtime/AssistantTranscriptRecoveryStore"
import type { ChatDispatchStore } from "./services/chat-dispatch-store"
import type { RemoteAccessService } from "./remote/service"
import type { RemoteProviderTurnOwnership } from "./remote/providerTurnOwnership"
import type { TailscaleRemoteAccess } from "./remote/tailscale"
import type { AdmissionGate } from "./lifecycle/AdmissionGate"
import type { CheckpointRefCleanupStore } from "./checkpointing/CheckpointRefCleanupStore"
import type { AgentPermissionPolicy } from "./provider/agent-permission-policy"

/**
 * Shared application state, analogous to rust-backend/src/state.rs:AppState.
 * Constructed once at startup in bootstrap/providers.ts and threaded into the HTTP
 * router + WebSocket hub.
 */
export interface AppState {
  readonly orchestrator?: import("./services/orchestrator/service").OrchestratorService
  readonly config: ServerConfig
  readonly db: Db
  readonly eventStore: EventStore
  readonly receiptStore: CommandReceiptStore
  readonly threadProjections: ThreadProjectionQuery
  readonly messageProjections: MessageProjectionQuery
  readonly checkpointDiffs: CheckpointDiffProjectionQuery
  readonly turnProjections: TurnProjectionQuery
  readonly threadActivities: ThreadActivityProjectionQuery
  readonly projectProjections: ProjectProjectionQuery
  readonly worktreeRegistry: WorktreeRegistryQuery
  readonly settings: SettingsService
  readonly apiKeyPool?: import("./auth/apiKeyPool").ApiKeyPool
  readonly providers: ProviderService
  readonly providerRegistry: ProviderAdapterRegistry
  readonly threads: ThreadService
  readonly chatHelpers: ChatLlmHelpers
  readonly worktrees: WorktreeManager
  readonly providerHub: ProviderHub
  /** Provider-neutral durable grants and explicit Agent Mode workspace trust. */
  readonly agentPermissions: AgentPermissionPolicy
  readonly providerSessionBindings: ProviderSessionBindingStore
  readonly providerEventLoggers?: ReadonlyArray<EventNdjsonLogger>
  readonly transcriptRecoveryStore?: AssistantTranscriptRecoveryStore
  readonly sourceProposedPlanImplementations?: PendingSourceProposedPlanImplementationStore
  /** OAuth/credential store (separate file from settings.json). See
   *  `apps/backend/src/auth/store.ts`. Optional so test doubles can omit it. */
  readonly authStore?: AuthStore
  readonly checkpointReverts?: CheckpointRevertOperationStore
  readonly checkpointReactor?: CheckpointReactor
  readonly checkpointTurnSlots?: CheckpointTurnSlotStore
  /** Durable retry queue for hidden Git refs whose synchronous cleanup failed. */
  readonly checkpointRefCleanupStore?: CheckpointRefCleanupStore
  readonly threadTurnCoordinator: ThreadTurnCoordinator
  /** Required durable user-message/provider-admission lifecycle. */
  readonly chatDispatches: ChatDispatchStore
  /** Persistent one-time pairing grants and revocable browser sessions. */
  readonly remoteAccess?: RemoteAccessService
  /** Exact remote-session ownership for provider admissions and settlement. */
  readonly remoteProviderTurns?: RemoteProviderTurnOwnership
  /** Tailscale detection + Serve mapping for Remote Access. Optional so
   *  narrow test doubles advertise no Tailscale endpoint. */
  readonly tailscale?: TailscaleRemoteAccess
  /** Marks this backend instance unsafe after a durability write fails. */
  readonly taintBackend?: (error: Error, origin: string) => void
  /**
   * Read-only accessor for the instance-local taint flag. The HTTP router
   * short-circuits every request while the owning host drains or replaces
   * the instance. Optional so narrow test doubles can omit it.
   */
  readonly taintedRef?: () => boolean
  /** Rejects and drains transport work during graceful shutdown. */
  readonly requestAdmission?: AdmissionGate
  readonly drainingRef?: () => boolean
}
