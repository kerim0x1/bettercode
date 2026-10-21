import fs from "node:fs"
import path from "node:path"
import { configureBackendLogging, logger } from "../observability/logger"
import { readBackendVersion } from "../version"
import type { Settings } from "../settings/schema"
import { ProviderAdapterRegistry } from "../provider/registry"
import { ProviderService } from "../provider/service"
import { ThreadTurnCoordinator } from "../provider/threadTurnCoordinator"
import type { LegacyProviderEvent } from "../provider/types"
import type { TurnLifecyclePolicy } from "../provider/turnLifecyclePolicy"
import { ClaudeApiAdapter } from "../provider/adapters/claudeApi"
import { ApiModelCatalog } from "../provider/adapters/apiModelCatalog"
import { ApiKeyPool } from "../auth/apiKeyPool"
import { ClaudeAgentAdapter } from "../provider/adapters/claudeAgent"
import { BaseProviderAdapter } from "../provider/adapters/baseAdapter"
import {
  makeGrokAdapter,
  makeLmStudioAdapter,
  makeOpenAiAdapter,
  makeOpenRouterAdapter,
} from "../provider/adapters/factories"
import { portableMcpServersToAcp } from "../provider/runtime/acp/AcpMcpServers"
import { resolveConfiguredMcpServers } from "../services/desktop-config/mcp"
import { CodeSearchHarness } from "../services/code-search/harness"
import { OrchestratorService } from "../services/orchestrator/service"
import { createContextSourceReader } from "../services/orchestrator/context-sources"
import { orchestrationModelCatalog } from "../services/orchestrator/model-catalog"
import { OrchestratorMcpHarness } from "../services/orchestrator/mcp"
import { dispatchChatTurn } from "../services/chat/dispatch"
import { interruptChatTurn } from "../services/chat/sessions"
import { withCodeSearchServer } from "../services/code-search/provider-resolver"
import { isScratchWorkspacePath } from "../services/scratchWorkspace"
import {
  ProviderHub,
  ProviderInstanceManager,
  isProviderSessionContinuationCompatible,
  makeEventNdjsonLogger,
  providerEventTraceEnabled,
} from "../provider/runtime"
import {
  resolveAnthropicKey,
  resolveGrokKey,
  resolveOpenAiKey,
  resolveOpenRouterKey,
} from "../auth/keyResolution"
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
import { CheckpointRefCleanupStore } from "../checkpointing/CheckpointRefCleanupStore"
import { CheckpointRefCleanupScheduler } from "../checkpointing/CheckpointRefCleanupScheduler"
import { CheckpointRefOperationGate } from "../checkpointing/CheckpointRefOperationGate"
import { CheckpointTurnSlotStore } from "../checkpointing/CheckpointTurnSlotStore"
import { positiveEnvMs, readTuningEnv } from "./env"
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
 * `finalizeCheckpointTurn` and the shared `turnLifecycle` policy close over
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
  const { options, config, startupCleanup, requestAdmission, eventBus } = root
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
  } = settingsCtx

  // Folderless chats run in the app's own per-thread scratch tree. Nothing in
  // it was chosen by a repository, so Agent Mode needs no trust decision
  // there — which keeps those chats working now that automatic trust is off
  // by default. The data dir may sit behind a symlink (macOS), so match both.
  const scratchDataDirs = [
    config.dataDir,
    realDirectoryOrNull(config.dataDir),
  ].filter((dir): dir is string => typeof dir === "string" && dir.length > 0)
  agentPermissions.configureAppOwnedWorkspaces((workspacePath) =>
    scratchDataDirs.some((dataDir) =>
      isScratchWorkspacePath(dataDir, workspacePath)
    )
  )

  // ── Provider adapters (API-key fallback chain mirrors Rust auth flow) ─
  const providerRegistry = new ProviderAdapterRegistry()
  const currentSettings = settings.get()
  const apiKeyPool = new ApiKeyPool(settings)
  // The configured MCP servers of a workspace: the desktop's
  // `mcp-servers.json` (in the runtime home), the user's global config and,
  // once the workspace is *explicitly* trusted, the servers it declares.
  // Resolved at each turn/session, and the same list the prompt names
  // (services/desktop-config/mcp.ts).
  const configuredMcpState = { config, settings, agentPermissions }
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
    // A worker's task is not a user's message: no message hooks.
    dispatch: (body) =>
      dispatchChatTurn(state, body, () => null, undefined, {
        messageHooks: false,
      }),
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
  const configuredMcpServers = (cwd: string) =>
    resolveConfiguredMcpServers(configuredMcpState, cwd)
  const directAgentTools = {
    mcpServerResolver: withCodeSearchServer(
      configuredMcpServers,
      codeSearch.resolveServer
    ),
    shellSessions: root.shellSessions,
  }
  const acpMcpServerResolver = async (cwd: string) =>
    portableMcpServersToAcp(await directAgentTools.mcpServerResolver(cwd))
  let remoteAccessWasEnabled = currentSettings.remote_access_enabled === true
  // Hosting off at boot (switched off while the app was closed, or a crash
  // before the live revocation ran): nothing paired or issued earlier may
  // come back to life when hosting is turned on again.
  if (!remoteAccessWasEnabled) remoteAccess.revokeAllAccess()

  const anthropicKey = resolveAnthropicKey(currentSettings)
  const apiModelCatalog = new ApiModelCatalog(
    path.join(config.dataDir, "api-model-catalog")
  )
  providerRegistry.register(
    new ClaudeApiAdapter(
      anthropicKey?.key ?? null,
      directAgentTools,
      apiModelCatalog,
      apiKeyPool
    )
  )
  providerRegistry.register(new ClaudeAgentAdapter())

  const openaiKey = resolveOpenAiKey(currentSettings)
  providerRegistry.register(
    makeOpenAiAdapter(
      openaiKey?.key ?? null,
      directAgentTools,
      apiModelCatalog,
      apiKeyPool
    )
  )

  const grokKey = resolveGrokKey(currentSettings)
  providerRegistry.register(
    makeGrokAdapter(
      grokKey?.key ?? null,
      directAgentTools,
      apiModelCatalog,
      apiKeyPool
    )
  )

  const openrouterKey = resolveOpenRouterKey(currentSettings)
  providerRegistry.register(
    makeOpenRouterAdapter(openrouterKey?.key ?? null, directAgentTools)
  )

  providerRegistry.register(makeLmStudioAdapter(directAgentTools))
  // The direct-API (legacy) adapters publish their events on this
  // backend's bus, where ingestion and the legacy provider service listen.
  for (const adapter of providerRegistry.all()) {
    if (adapter instanceof BaseProviderAdapter)
      adapter.connectEventBus(eventBus)
  }

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
    resolveImageGenerationModel: () => settings.get().image_generation_model,
    imageGeneration: root.imageGenerations,
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
    event: LegacyProviderEvent
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
  // The checkpoint baseline and turn-slot admission, the workspace trust
  // gate and checkpoint finalization: one policy, handed to both provider
  // stacks below so they cannot drift apart.
  const turnLifecycle: TurnLifecyclePolicy = {
    beforeTurn: (event) => checkpointReactor.prepareTurn(event),
    preDispatchPolicy: (input) =>
      agentPermissions.evaluateTurnTrust({
        workspacePath: input.projectPath,
        appMode: input.appMode,
      }),
    afterTurn: finalizeCheckpointTurn,
  }
  // One pair of turn limits for the provider hub and the direct-API service:
  // an inactivity limit (paused while a request waits for the user) and an
  // absolute ceiling. See provider/turnLimits.ts for the defaults.
  const ignoreInvalidTuningEnv = (name: string) =>
    logger.warn(
      { name },
      "Ignoring an invalid environment setting; the default applies"
    )
  const turnTimeoutMs = readTuningEnv(
    "BETTERC0DE_PROVIDER_TURN_TIMEOUT_MS",
    positiveEnvMs,
    ignoreInvalidTuningEnv
  )
  const turnMaxDurationMs = readTuningEnv(
    "BETTERC0DE_PROVIDER_TURN_MAX_DURATION_MS",
    positiveEnvMs,
    ignoreInvalidTuningEnv
  )
  const providerHub = new ProviderHub({
    instances: initialProviderInstances.instances,
    turnTimeoutMs,
    turnMaxDurationMs,
    statusCacheDir: path.join(config.dataDir, "provider-status-cache"),
    canonicalEventLogger: canonicalProviderEventLogger,
    refreshInstances: ({ instanceId }) =>
      providerInstanceManager.reconcile(settings.get(), {
        forceInstanceIds: instanceId ? [instanceId] : [],
      }).instances,
    threadTurnCoordinator,
    turnLifecycle,
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
    eventBus.emitCanonical(event)
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
      // Sessions and unredeemed pairing links alike: a shared QR code must
      // not start working again when hosting is re-enabled.
      remoteAccess.revokeAllAccess()
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
          root.shellSessions.closeSessionsForOwner(ownerId),
          root.terminalPtys.shutdownForOwner(ownerId),
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
    eventBus,
    turnTimeoutMs,
    // BETTERC0DE_TURN_HARD_TIMEOUT_MS is the earlier name of this ceiling.
    turnMaxDurationMs:
      turnMaxDurationMs ??
      readTuningEnv(
        "BETTERC0DE_TURN_HARD_TIMEOUT_MS",
        positiveEnvMs,
        ignoreInvalidTuningEnv
      ),
    durableTurnCount: (threadId) => checkpointDiffs.latestTurnIndex(threadId),
    threadTurnCoordinator,
    turnLifecycle,
  })
  const chatHelpers = new ChatLlmHelpers({
    settings: () => settings.get(),
    apiKeyPool,
    nativeTextGeneration: root.nativeTextGenerations,
  })
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
    eventBus,
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
    apiKeyPool,
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
    checkpointReverts,
    checkpointReactor,
    checkpointTurnSlots,
    checkpointRefCleanupStore,
    threadTurnCoordinator,
    chatDispatches,
    remoteAccess,
    remoteProviderTurns,
    tailscale,
    terminalPtys: root.terminalPtys,
    shellSessions: root.shellSessions,
    workspaceRecoveryGate: root.workspaceRecoveryGate,
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

/** The canonical path of an existing directory, or null. */
function realDirectoryOrNull(directory: string): string | null {
  try {
    return fs.realpathSync.native(directory)
  } catch {
    return null
  }
}
