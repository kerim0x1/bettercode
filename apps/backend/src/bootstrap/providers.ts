import fs from "node:fs"
import path from "node:path"
import { configureBackendLogging, logger } from "../observability/logger"
import { readBackendVersion } from "../version"
import type { Settings } from "../settings/schema"
import { ProviderAdapterRegistry } from "../provider/registry"
import { ProviderService } from "../provider/service"
import { ThreadTurnCoordinator } from "../provider/threadTurnCoordinator"
import type { ProviderRuntimeEvent } from "../provider/types"
import { ClaudeApiAdapter } from "../provider/adapters/claudeApi"
import { ApiModelCatalog } from "../provider/adapters/apiModelCatalog"
import { ClaudeAgentAdapter } from "../provider/adapters/claudeAgent"
import {
  makeGrokAdapter,
  makeLmStudioAdapter,
  makeOpenAiAdapter,
  makeOpenRouterAdapter,
} from "../provider/adapters/factories"
import {
  portableMcpServersToAcp,
  createPortableMcpServerResolver,
} from "../provider/runtime/cursor/AcpMcpServers"
import { CodeSearchHarness } from "../services/code-search/harness"
import { OrchestratorService } from "../services/orchestrator/service"
import { createContextSourceReader } from "../services/orchestrator/context-sources"
import { orchestrationModelCatalog } from "../services/orchestrator/model-catalog"
import { OrchestratorMcpHarness } from "../services/orchestrator/mcp"
import { dispatchChatTurn } from "../services/chat/dispatch"
import { interruptChatTurn } from "../services/chat/sessions"
import { withCodeSearchServer } from "../services/code-search/provider-resolver"
import {
  ProviderHub,
  ProviderInstanceManager,
  isProviderSessionContinuationCompatible,
  canonicalToLegacy,
  makeEventNdjsonLogger,
  providerEventTraceEnabled,
} from "../provider/runtime"
import {
  resolveAnthropicKey,
  resolveGrokKey,
  resolveOpenAiKey,
  resolveOpenRouterKey,
} from "../auth/keyResolution"
import { providerEventBus } from "../provider/events"
import { SqlitePendingSourceProposedPlanImplementationStore } from "../provider/runtime/PendingSourceProposedPlanImplementationStore"
import { CheckpointReactor } from "../checkpointing/CheckpointReactor"
import { ChatLlmHelpers } from "../services/chat"
import { WorktreeManager } from "../services/worktree"
import type { AppState } from "../appState"
import { CheckpointRevertOperationStore } from "../services/checkpoint-revert-operations"
import {
  remoteTerminalGrantRevoked,
  remoteTerminalRevocationOwners,
} from "../remote/terminalGrant"
import { closeShellSessionsForOwner } from "../services/shell"
import { shutdownTerminalPtySessionsForOwner } from "../services/terminalPty"
import { CheckpointRefCleanupStore } from "../checkpointing/CheckpointRefCleanupStore"
import { CheckpointRefCleanupScheduler } from "../checkpointing/CheckpointRefCleanupScheduler"
import { CheckpointRefOperationGate } from "../checkpointing/CheckpointRefOperationGate"
import { CheckpointTurnSlotStore } from "../checkpointing/CheckpointTurnSlotStore"
import { positiveEnvMs } from "./env"
import type {
  BootRoot,
  PersistenceContext,
  ProvidersContext,
  SettingsContext,
} from "./context"

/**
 * Phase 3: the provider stacks and everything that reacts to a turn. Legacy
 * adapters and registry (the composition root is their one importer outside
 * `provider/`), the runtime `ProviderHub` with its instance manager, the
 * settings-change listener, the checkpoint stores and reactor, and finally
 * the `AppState` container every transport reads from.
 *
 * `finalizeCheckpointTurn` and the two `beforeTurn` hooks close over
 * `checkpointReactor`, which is constructed further down in this same scope.
 * That is safe for the same reason it always was: no turn can be dispatched
 * before the HTTP listener binds at the very end of startup, long after the
 * reactor exists, and a call before initialisation would fail loudly (TDZ)
 * rather than silently.
 */
export function wireProviders(
  root: BootRoot,
  persistence: PersistenceContext,
  settingsCtx: SettingsContext
): ProvidersContext {
  const { options, config, startupCleanup, requestAdmission } = root
  const { taintBackend, isBackendTainted } = root.taint
  const {
    db,
    eventStore,
    receiptStore,
    threadProjections,
    messageProjections,
    checkpointDiffs,
    turnProjections,
    threadActivities,
    providerSessionBindings,
    projectProjections,
    worktreeRegistry,
    threads,
    chatDispatches,
    agentPermissions,
  } = persistence
  const {
    settings,
    remoteAccess,
    tailscale,
    remoteProviderTurns,
    transcriptRecoveryStore,
    authStore,
  } = settingsCtx

  // ── Provider adapters (API-key fallback chain mirrors Rust auth flow) ─
  const providerRegistry = new ProviderAdapterRegistry()
  const currentSettings = settings.get()
  const mcpResolverOptions = {
    dataDir: config.dataDir,
    // Resolve lazily at each turn/session so enabling, disabling, or editing a
    // Settings MCP server takes effect without restarting the backend.
    resolveSettingsServers: () => settings.get().mcp_servers,
    // A repository's own `betterc0de.json` may declare MCP servers. Ones
    // that spawn a process require an *explicit* trust decision for that
    // workspace — the compatibility default ("trusted" with no stored
    // record) is not consent to execute code the repo chose.
    allowWorkspaceSpawnedServers: (cwd: string) => {
      try {
        const trust = agentPermissions.getWorkspaceTrust(cwd)
        return trust.state === "trusted" && trust.explicit
      } catch {
        return false
      }
    },
  }
  const codeSearch = new CodeSearchHarness({
    settings: () => settings.get(),
    isWorkspaceAllowed: (cwd) => {
      try {
        return agentPermissions.getWorkspaceTrust(cwd).state === "trusted"
      } catch {
        return false
      }
    },
  })
  startupCleanup.push({
    name: "code search harness",
    run: () => codeSearch.close(),
  })
  const orchestrator: OrchestratorService = new OrchestratorService({
    modelCatalog: (cwd, providers) =>
      orchestrationModelCatalog(providerHub, cwd, providers),
    readContextSource: createContextSourceReader(db),
    settings: () => settings.get(),
    allowed: (cwd) =>
      agentPermissions.getWorkspaceTrust(cwd).state === "trusted",
    load: (threadId) =>
      threadActivities.payloadById(threadId, `orchestrator:${threadId}`),
    persist: (session) =>
      threadActivities.upsert({
        activity_id: `orchestrator:${session.threadId}`,
        thread_id: session.threadId,
        turn_id: null,
        kind: "orchestrator.session",
        tone: "info",
        summary: "Orchestrator team",
        payload: session,
        created_at: session.createdAt,
      }),
    createThread: (input) => {
      const now = new Date().toISOString()
      threads.upsertThreadMeta({
        thread_id: input.id,
        title: input.title,
        project_name: path.basename(input.projectPath),
        project_path: input.projectPath,
        parent_thread_id: input.parentThreadId ?? null,
        codex_thread_id: null,
        created_at: now,
        updated_at: now,
      })
    },
    dispatch: (body) => dispatchChatTurn(state, body, () => null),
    interrupt: (threadId, providerKind, providerInstanceId) =>
      interruptChatTurn(state, { threadId, providerKind, providerInstanceId }),
    reportError: (error) =>
      logger.error({ err: error }, "Orchestrator operation failed"),
  })
  const orchestratorHarness = new OrchestratorMcpHarness(orchestrator)
  startupCleanup.push({
    name: "orchestrator service",
    run: () => orchestrator.close(),
  })
  startupCleanup.push({
    name: "orchestrator harness",
    run: () => orchestratorHarness.close(),
  })
  const configuredMcpServers =
    createPortableMcpServerResolver(mcpResolverOptions)
  const directAgentTools = {
    mcpServerResolver: withCodeSearchServer(
      configuredMcpServers,
      codeSearch.resolveServer
    ),
  }
  const acpMcpServerResolver = async (cwd: string) =>
    portableMcpServersToAcp(await directAgentTools.mcpServerResolver(cwd))
  let remoteAccessWasEnabled = currentSettings.remote_access_enabled === true

  const anthropicKey = resolveAnthropicKey(currentSettings)
  const apiModelCatalog = new ApiModelCatalog(
    path.join(config.dataDir, "api-model-catalog")
  )
  providerRegistry.register(
    new ClaudeApiAdapter(
      anthropicKey?.key ?? null,
      directAgentTools,
      apiModelCatalog
    )
  )
  providerRegistry.register(new ClaudeAgentAdapter())

  const openaiKey = resolveOpenAiKey(currentSettings)
  providerRegistry.register(
    makeOpenAiAdapter(openaiKey?.key ?? null, directAgentTools, apiModelCatalog)
  )

  const grokKey = resolveGrokKey(currentSettings)
  providerRegistry.register(
    makeGrokAdapter(grokKey?.key ?? null, directAgentTools, apiModelCatalog)
  )

  const openrouterKey = resolveOpenRouterKey(currentSettings)
  providerRegistry.register(
    makeOpenRouterAdapter(openrouterKey?.key ?? null, directAgentTools)
  )

  providerRegistry.register(makeLmStudioAdapter(directAgentTools))

  const nativeProviderEventLogger = makeEventNdjsonLogger(
    config.providerEventLogPath,
    {
      stream: "native",
      shouldWrite: () => providerEventTraceEnabled(settings.get()),
    }
  )
  const canonicalProviderEventLogger = makeEventNdjsonLogger(
    config.providerEventLogPath,
    {
      stream: "canonical",
      shouldWrite: () => providerEventTraceEnabled(settings.get()),
    }
  )
  const providerEventLoggers = [
    nativeProviderEventLogger,
    canonicalProviderEventLogger,
  ].filter((candidate) => candidate !== undefined)
  for (const [index, eventLogger] of providerEventLoggers.entries()) {
    startupCleanup.push({
      name: `provider event log ${index + 1}`,
      run: () => eventLogger.close(),
    })
  }
  const providerInstanceManager = new ProviderInstanceManager({
    modelCacheDir: path.join(config.dataDir, "cli-model-catalog"),
    clientInfo: {
      name: "BetterC0de",
      title: "BetterC0de",
      version: readBackendVersion(),
    },
    nativeEventLogger: nativeProviderEventLogger,
    resolveAcpMcpServers: acpMcpServerResolver,
    resolveCodeSearchServer: codeSearch.resolveServer,
    resolveOrchestratorServer: orchestratorHarness.resolveServer,
    getStoredProviderThreadId: ({
      threadId,
      providerKind,
      providerInstanceId,
      continuationKey,
    }) => {
      const binding = providerSessionBindings.get(threadId, providerInstanceId)
      if (binding) {
        return isProviderSessionContinuationCompatible(binding, {
          providerKind,
          continuationKey,
        })
          ? binding.providerThreadId
          : null
      }
      const legacyCodexThreadId =
        providerKind === "codex" && providerInstanceId === "codex"
          ? threads.getCodexThreadId(threadId)
          : null
      if (!legacyCodexThreadId) return null
      providerSessionBindings.setProviderThreadId({
        threadId,
        providerKind,
        providerInstanceId,
        providerThreadId: legacyCodexThreadId,
        continuationKey,
      })
      return legacyCodexThreadId
    },
    getStoredProviderResumeCursor: ({
      threadId,
      providerKind,
      providerInstanceId,
      continuationKey,
    }) => {
      const binding = providerSessionBindings.get(threadId, providerInstanceId)
      return isProviderSessionContinuationCompatible(binding, {
        providerKind,
        continuationKey,
      })
        ? binding.resumeCursor
        : null
    },
    persistProviderThreadId: ({
      threadId,
      providerKind,
      providerInstanceId,
      providerThreadId,
      resumeCursor,
      continuationKey,
    }) => {
      providerSessionBindings.setProviderThreadId({
        threadId,
        providerKind,
        providerInstanceId,
        providerThreadId,
        resumeCursor,
        continuationKey,
      })
      if (providerKind === "codex" && providerInstanceId === "codex") {
        threads.setCodexThreadId(threadId, providerThreadId)
      }
    },
  })
  const initialProviderInstances =
    providerInstanceManager.reconcile(currentSettings)
  options.signal?.throwIfAborted()
  const threadTurnCoordinator = new ThreadTurnCoordinator()
  // Provider admission is wired before the reactor is constructed below, but
  // no turn can be dispatched until the HTTP server is bound at the end of
  // startup. This closure captures the reactor initialized before the HTTP
  // server becomes reachable.
  const finalizeCheckpointTurn = async (
    event: ProviderRuntimeEvent
  ): Promise<void> => {
    try {
      await checkpointReactor.finalizeTurn(event)
    } catch (error) {
      taintBackend(
        error instanceof Error
          ? error
          : new Error("Checkpoint turn finalization failed", {
              cause: error,
            }),
        "checkpoint_turn_finalization"
      )
      throw error
    }
  }
  const providerHub = new ProviderHub({
    instances: initialProviderInstances.instances,
    turnTimeoutMs: positiveEnvMs("BETTERC0DE_PROVIDER_TURN_TIMEOUT_MS"),
    statusCacheDir: path.join(config.dataDir, "provider-status-cache"),
    canonicalEventLogger: canonicalProviderEventLogger,
    refreshInstances: ({ instanceId }) =>
      providerInstanceManager.reconcile(settings.get(), {
        forceInstanceIds: instanceId ? [instanceId] : [],
      }).instances,
    threadTurnCoordinator,
    beforeTurn: (input) =>
      checkpointReactor.prepareTurn({
        event_type: "turn_started",
        thread_id: input.threadId,
        payload: {
          turn_id: input.turnId,
          dispatchTurnId: input.turnId,
          provider_kind: input.providerKind,
          provider_instance_id: input.providerInstanceId,
          ...(input.projectPath ? { project_path: input.projectPath } : {}),
        },
      }),
    preDispatchPolicy: (input) =>
      agentPermissions.evaluateTurnTrust({
        workspacePath: input.projectPath,
        appMode: input.appMode,
      }),
    afterTurn: async (event) => {
      const legacy = canonicalToLegacy(event)
      if (legacy) await finalizeCheckpointTurn(legacy)
    },
  })
  startupCleanup.push({
    name: "provider hub",
    run: () => providerHub.stopAll(providerSessionBindings),
  })
  // Canonical, unbridged: ingestion journals the event as the hub emitted it
  // and runs the legacy bridge behind the journal. Listener errors still
  // propagate synchronously through `emit` to the hub's catch, which marks
  // the turn uncertain.
  const unsubscribeProviderHubEvents = providerHub.subscribe((event) => {
    providerEventBus.emitCanonical(event)
    orchestrator.onEvent(event)
  })
  startupCleanup.push({
    name: "provider hub event subscription",
    run: unsubscribeProviderHubEvents,
  })

  // Re-resolve provider keys whenever settings change and push them into
  // the live adapters via `setApiKey`. Without this listener the adapters
  // kept their constructor-time keys forever — so a user who pasted their
  // first OpenAI/Claude/Grok/OpenRouter key into settings still hit the
  // "X is not configured" error until they restarted the app, because
  // `isConfigured()` checks the in-memory `client`, not what's on disk.
  // Keep the resolver list in sync with the registration block above.
  // Turning "Allow terminal from remote devices" off must end the shells
  // and PTYs paired devices already hold, not only refuse new ones: a
  // device polling `/shell/pty/read` would otherwise keep streaming a
  // live terminal after the switch. Same teardown the session-revoke path
  // runs, minus the provider-turn revocation — the sessions stay valid.
  let remoteTerminalSettings: Pick<Settings, "remote_access_allow_terminal"> =
    currentSettings
  const onSettingsChange = (next: Settings) => {
    codeSearch.settingsChanged()
    orchestrator.settingsChanged()
    configureBackendLogging(next)
    // The forwarded-header trust follows the serve setting without a
    // restart: the route that flips the setting has already run the CLI.
    config.trustLoopbackProxyHeaders =
      next.remote_access_tailscale_serve === true
    if (remoteAccessWasEnabled && next.remote_access_enabled !== true) {
      remoteAccess.revokeOtherSessions()
      // Hosting off means the tailnet endpoint must disappear too; the
      // setting survives so re-enabling hosting brings it back.
      if (next.remote_access_tailscale_serve === true) {
        void tailscale.disableServe().catch((error: unknown) => {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Tailscale Serve could not be removed after remote access was disabled"
          )
        })
      }
    }
    remoteAccessWasEnabled = next.remote_access_enabled === true
    if (remoteTerminalGrantRevoked(remoteTerminalSettings, next)) {
      for (const ownerId of remoteTerminalRevocationOwners(
        remoteAccess.listSessions()
      )) {
        void Promise.allSettled([
          closeShellSessionsForOwner(ownerId),
          shutdownTerminalPtySessionsForOwner(ownerId),
        ]).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") {
              logger.error(
                { err: result.reason, ownerId },
                "failed to end remote terminals after the grant was revoked"
              )
            }
          }
        })
      }
    }
    remoteTerminalSettings = next

    const reconciledInstances = providerInstanceManager.reconcile(next)
    if (reconciledInstances.changed) {
      providerHub.replaceInstances(reconciledInstances.instances)
    }

    const updates: Array<
      [Parameters<typeof providerRegistry.get>[0], string | null]
    > = [
      ["anthropic", resolveAnthropicKey(next)?.key ?? null],
      ["openai", resolveOpenAiKey(next)?.key ?? null],
      ["grok", resolveGrokKey(next)?.key ?? null],
      ["openrouter", resolveOpenRouterKey(next)?.key ?? null],
    ]
    for (const [kind, key] of updates) {
      const adapter = providerRegistry.get(kind)
      if (!adapter || typeof adapter.setApiKey !== "function") continue
      try {
        adapter.setApiKey(key)
      } catch (err) {
        logger.error(
          { err, providerKind: kind },
          "failed to apply settings key change to provider adapter"
        )
      }
    }
  }
  settings.on("change", onSettingsChange)
  startupCleanup.push({
    name: "settings change listener",
    run: () => {
      settings.off("change", onSettingsChange)
    },
  })

  const providers = new ProviderService(providerRegistry, {
    durableTurnCount: (threadId) => checkpointDiffs.latestTurnIndex(threadId),
    threadTurnCoordinator,
    beforeTurn: (event) => checkpointReactor.prepareTurn(event),
    preDispatchPolicy: (input) =>
      agentPermissions.evaluateTurnTrust({
        workspacePath: input.projectPath,
        appMode: input.appMode,
      }),
    afterTurn: finalizeCheckpointTurn,
  })
  const chatHelpers = new ChatLlmHelpers({ settings: () => settings.get() })
  const worktrees = new WorktreeManager(db, eventStore, worktreeRegistry)
  const checkpointRefCleanupStore = new CheckpointRefCleanupStore(db)
  const checkpointRefOperationGate = new CheckpointRefOperationGate()
  const checkpointTurnSlots = new CheckpointTurnSlotStore(db)
  const registeredRepositories = [
    ...new Set(
      worktreeRegistry
        .listAll()
        .map((entry) => entry.base_repo_path)
        .filter((repoPath) => repoPath.trim().length > 0)
    ),
  ]
  const checkpointReverts = new CheckpointRevertOperationStore(db)
  const sourceProposedPlanImplementations =
    new SqlitePendingSourceProposedPlanImplementationStore(db)
  const checkpointReactor = new CheckpointReactor({
    eventBus: providerEventBus,
    threads,
    logger,
    cleanupJournal: checkpointRefCleanupStore,
    refOperationGate: checkpointRefOperationGate,
    allocateTurnSlot: (threadId, explicitTurnIndex) =>
      checkpointTurnSlots.allocate(threadId, explicitTurnIndex),
    reconcileTurnSlot: (threadId) =>
      checkpointTurnSlots.reconcileThread(threadId),
    recordTurnAdmission: (admission) =>
      checkpointTurnSlots.recordAdmission(admission),
    completeTurnAdmission: (input) =>
      checkpointTurnSlots.completeAdmission(input),
    failTurnAdmission: (threadId, turnKey, error) =>
      checkpointTurnSlots.markAdmissionFailed(threadId, turnKey, error),
    listTurnAdmissions: () => checkpointTurnSlots.listAdmissions(),
  })
  const checkpointRefCleanup = new CheckpointRefCleanupScheduler(
    checkpointRefCleanupStore,
    (entry) => {
      if (fs.existsSync(entry.cwd)) return entry.cwd
      return (
        worktreeRegistry.findByThread(entry.threadId)?.base_repo_path ??
        threads.getThreadProjectPath(entry.threadId) ??
        entry.cwd
      )
    },
    undefined,
    {
      shouldDefer: (entry) =>
        checkpointReactor.isCheckpointRefActive(entry.checkpointRef) ||
        checkpointTurnSlots.isAdmissionRefPending(entry.checkpointRef),
      refOperationGate: checkpointRefOperationGate,
    }
  )

  const state: AppState = {
    orchestrator,
    config,
    db,
    eventStore,
    receiptStore,
    threadProjections,
    messageProjections,
    checkpointDiffs,
    turnProjections,
    threadActivities,
    projectProjections,
    worktreeRegistry,
    settings,
    providers,
    providerRegistry,
    threads,
    chatHelpers,
    worktrees,
    providerHub,
    agentPermissions,
    providerSessionBindings,
    providerEventLoggers,
    transcriptRecoveryStore,
    sourceProposedPlanImplementations,
    authStore,
    checkpointReverts,
    checkpointReactor,
    checkpointTurnSlots,
    checkpointRefCleanupStore,
    threadTurnCoordinator,
    chatDispatches,
    remoteAccess,
    remoteProviderTurns,
    tailscale,
    taintBackend,
    // HTTP and WS admission checks refuse new work after an instance-local
    // durability failure or explicit host taint.
    taintedRef: isBackendTainted,
    requestAdmission,
    drainingRef: () => requestAdmission.isDraining(),
  }
  return {
    codeSearch,
    orchestratorHarness,
    providerRegistry,
    providerInstanceManager,
    providerHub,
    unsubscribeProviderHubEvents,
    providerEventLoggers,
    providers,
    threadTurnCoordinator,
    chatHelpers,
    worktrees,
    checkpointRefCleanupStore,
    checkpointRefOperationGate,
    checkpointTurnSlots,
    registeredRepositories,
    checkpointReverts,
    sourceProposedPlanImplementations,
    checkpointReactor,
    checkpointRefCleanup,
    onSettingsChange,
    state,
  }
}
