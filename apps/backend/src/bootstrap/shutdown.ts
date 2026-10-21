import type http from "node:http"
import { logger } from "../observability/logger"
import {
  SHUTDOWN_INFLIGHT_DRAIN_MS,
  SHUTDOWN_HARD_TIMEOUT_MS,
} from "../constants"
import {
  closeHttpServer,
  runShutdownSteps,
  runWithShutdownDeadline,
  type ShutdownStep,
} from "../shutdown"
import { stopAllToolOutputArchiveStores } from "../services/tool-output-archive-store"
import type { WsHub } from "../ws/server"
import type {
  BootRoot,
  PersistenceContext,
  ProvidersContext,
  RecoveryContext,
  RetentionContext,
  SettingsContext,
  TimersContext,
} from "./context"
import { beginResourceManagerShutdowns } from "./lifecycle"
import { threadGoals } from "../services/chat/goal-registry"
import { threadAutonomyRuns } from "../services/chat/autonomy-registry"
import { chatResumes } from "../services/chat/resume-registry"
import { automationServices } from "../services/automations/registry"
import { releaseAgentPermissionRuntime } from "../provider/agent-permission-runtime"

/**
 * Everything the graceful shutdown closes over: the phase contexts built by
 * `startNodeBackend` plus the listener of the port candidate that won the
 * bind. `runGracefulShutdown` destructures exactly the services and handles
 * it touches, so a phase that stops producing one fails the build there
 * rather than at `stop()` time.
 */
export interface ShutdownDeps {
  readonly root: BootRoot
  readonly persistence: PersistenceContext
  readonly settingsCtx: SettingsContext
  readonly providersCtx: ProvidersContext
  readonly hub: WsHub
  readonly recovery: RecoveryContext
  readonly retention: RetentionContext
  readonly timers: TimersContext
  readonly httpServer: http.Server
  readonly httpRuntimeErrorListener: (error: Error) => void
}

/**
 * Builds the `stop()` of a started backend: one in-flight run shared by every
 * caller, the port candidate marked as shutting down before anything closes
 * (so its runtime error listener stops tainting), and the whole drain bounded
 * by the hard timeout. Called once per successful bind.
 */
export function createStopHandle(
  deps: ShutdownDeps,
  markCandidateShuttingDown: () => void
): () => Promise<void> {
  let stopPromise: Promise<void> | null = null
  return () => {
    if (stopPromise) return stopPromise
    markCandidateShuttingDown()
    stopPromise = runWithShutdownDeadline(
      () => runGracefulShutdown(deps),
      SHUTDOWN_HARD_TIMEOUT_MS,
      (error) => {
        logger.error(
          { err: error },
          "Shutdown exceeded hard timeout; embedding host must decide whether to exit"
        )
      }
    )
    return stopPromise
  }
}

/**
 * The ordered graceful drain. Sequencing is deliberate throughout: transport
 * and application drains run concurrently with provider/shell interruption,
 * the provider hub and checkpoint reactor stop only after those settle, and
 * Git stays admitted until the reactor has reached its durability barrier
 * because checkpoint capture is itself a Git producer. Any critical failure
 * runs a minimal fail-closed cleanup and refuses the full teardown.
 */
export async function runGracefulShutdown(deps: ShutdownDeps): Promise<void> {
  const {
    root,
    persistence,
    settingsCtx,
    providersCtx,
    hub,
    recovery,
    retention,
    timers,
    httpServer: server,
    httpRuntimeErrorListener: candidateRuntimeErrorListener,
  } = deps
  const {
    options,
    requestAdmission,
    onStartupAbort,
    terminalPtys,
    shellSessions,
    gitProcesses,
    imageGenerations,
    nativeTextGenerations,
    workspaceProcesses,
  } = root
  const {
    git: requestGitProcessShutdown,
    imageGeneration: requestImageGenerationShutdown,
    nativeTextGeneration: requestNativeTextGenerationShutdown,
    workspace: requestWorkspaceProcessShutdown,
  } = root.resourceShutdowns
  const { db, providerSessionBindings } = persistence
  const {
    settings,
    remoteAccess,
    tailscale,
    remoteProviderTurns,
    unsubscribeRemoteOwnerCleanup,
    transcriptRecoveryStore,
    transcriptRecoveryTarget,
  } = settingsCtx
  const {
    providers,
    providerHub,
    unsubscribeProviderHubEvents,
    providerEventLoggers,
    checkpointReactor,
    checkpointRefCleanup,
    onSettingsChange,
  } = providersCtx
  const { providerRuntimeIngestion } = recovery
  const { threadRetention } = retention
  const {
    transcriptRecoveryTimer,
    providerSessionReaper,
    vacuumTimer,
    pullRequestWatcher,
  } = timers
  logger.info("Graceful shutdown initiated")
  requestAdmission.beginDrain()
  let orchestratorShutdownFailure: unknown = null
  const orchestratorShutdown = Promise.allSettled([
    providersCtx.state.orchestrator.close(),
    providersCtx.orchestratorHarness.close(),
  ]).then((results) => {
    const failures = results.filter((result) => result.status === "rejected")
    if (failures.length)
      orchestratorShutdownFailure = new AggregateError(
        failures.map((result) => result.reason),
        "Orchestrator shutdown failed"
      )
  })
  let codeSearchShutdownFailure: unknown = null
  const codeSearchShutdown = providersCtx.codeSearch.close().catch((error) => {
    codeSearchShutdownFailure = error
  })
  threadGoals.get(providersCtx.state)?.dispose()
  threadAutonomyRuns.get(providersCtx.state)?.dispose()
  // Before any turn is interrupted: the turns this shutdown cuts off keep
  // their markers, so the next start can continue them.
  chatResumes.get(providersCtx.state)?.beginShutdown()
  // No scheduled run may start once the drain began; pending history is written.
  automationServices.get(providersCtx.state)?.dispose()
  // Its timer would otherwise outlive the backend and poll a closed database.
  pullRequestWatcher.stop()
  providers.beginShutdown()
  providerHub.beginShutdown()
  shellSessions.beginShutdown()
  terminalPtys.beginShutdown()
  imageGenerations.beginShutdown()
  nativeTextGenerations.beginShutdown()
  workspaceProcesses.beginShutdown()
  hub.beginShutdown()

  // (a) Stop accepting new HTTP requests immediately, but retain a
  // promise for the bounded drain while cancellation below releases
  // long-running provider/shell requests.
  let httpDrainFailure: unknown = null
  const httpDrain = closeHttpServer(server, SHUTDOWN_INFLIGHT_DRAIN_MS).catch(
    (error) => {
      httpDrainFailure = error
    }
  )
  let wsDrainFailure: unknown = null
  const wsDrain = hub.close(SHUTDOWN_INFLIGHT_DRAIN_MS).catch((error) => {
    wsDrainFailure = error
  })
  let applicationDrainFailure: unknown = null
  const applicationDrain = requestAdmission
    .waitForIdle(SHUTDOWN_INFLIGHT_DRAIN_MS)
    .catch((error) => {
      applicationDrainFailure = error
    })
  logger.info("HTTP listener closing — no new requests accepted")
  // The tailnet name stops pointing at this backend once it is gone: a paired
  // device then sees the desktop offline instead of a proxy error. Best
  // effort and bounded; the next start re-applies the mapping.
  const tailscaleRelease = tailscale.releaseServe()

  let retentionFailure: unknown = null
  const retentionShutdown = threadRetention.stop().catch((error) => {
    retentionFailure = error
  })
  let providerReaperFailure: unknown = null
  const providerReaperShutdown = (
    providerSessionReaper?.stop() ?? Promise.resolve()
  ).catch((error) => {
    providerReaperFailure = error
  })
  let legacyInterruptFailure: unknown = null
  const legacyInterrupt = providers.interruptAll().catch((error) => {
    legacyInterruptFailure = error
    logger.error({ err: error }, "interruptAll failed during shutdown")
    return 0
  })
  let nativeInterruptFailure: unknown = null
  const nativeInterrupt = providerHub.interruptAllTurns().catch((error) => {
    nativeInterruptFailure = error
    logger.error(
      { err: error },
      "providerHub interruptAllTurns failed during shutdown"
    )
    return 0
  })
  let remoteProviderTurnShutdownFailure: unknown = null
  const remoteProviderTurnShutdown = remoteProviderTurns
    .shutdown()
    .catch((error) => {
      remoteProviderTurnShutdownFailure = error
      logger.error(
        { err: error },
        "remote-owned provider turns failed to settle during shutdown"
      )
      return 0
    })
  let providerHubStopFailure: unknown = null
  let shellShutdownFailure: unknown = null
  let terminalShutdownFailure: unknown = null
  let imageGenerationShutdownFailure: unknown = null
  let nativeTextGenerationShutdownFailure: unknown = null
  let workspaceProcessShutdownFailure: unknown = null
  const shellShutdown = shellSessions.closeAllSessions().catch((error) => {
    shellShutdownFailure = error
    return 0
  })
  const terminalShutdown = terminalPtys.shutdownAll().catch((error) => {
    terminalShutdownFailure = error
    return 0
  })
  const imageGenerationShutdown = requestImageGenerationShutdown().catch(
    (error) => {
      imageGenerationShutdownFailure = error
      return 0
    }
  )
  const nativeTextGenerationShutdown =
    requestNativeTextGenerationShutdown().catch((error) => {
      nativeTextGenerationShutdownFailure = error
      return 0
    })
  const workspaceProcessShutdown = requestWorkspaceProcessShutdown().catch(
    (error) => {
      workspaceProcessShutdownFailure = error
      return 0
    }
  )
  const [
    interruptedLegacyTurns,
    interruptedNativeTurns,
    initiallyClosedShellSessions,
    initiallyClosedTerminalSessions,
    _remoteOwnedTurns,
    stoppedImageGenerations,
    stoppedNativeTextGenerationResources,
    stoppedWorkspaceProcesses,
  ] = await Promise.all([
    legacyInterrupt,
    nativeInterrupt,
    shellShutdown,
    terminalShutdown,
    remoteProviderTurnShutdown,
    imageGenerationShutdown,
    nativeTextGenerationShutdown,
    workspaceProcessShutdown,
    codeSearchShutdown,
    orchestratorShutdown,
  ])
  const [lateShellSessions, lateTerminalSessions] = await Promise.all([
    shellSessions.closeAllSessions().catch((error) => {
      shellShutdownFailure ??= error
      return 0
    }),
    terminalPtys.shutdownAll().catch((error) => {
      terminalShutdownFailure ??= error
      return 0
    }),
  ])
  const abortedShellSessions = initiallyClosedShellSessions + lateShellSessions
  const closedTerminalSessions =
    initiallyClosedTerminalSessions + lateTerminalSessions
  if (
    interruptedLegacyTurns + interruptedNativeTurns > 0 ||
    abortedShellSessions > 0 ||
    closedTerminalSessions > 0 ||
    stoppedImageGenerations > 0 ||
    stoppedNativeTextGenerationResources > 0 ||
    stoppedWorkspaceProcesses > 0
  ) {
    logger.info(
      {
        providerTurns: interruptedLegacyTurns + interruptedNativeTurns,
        shellSessions: abortedShellSessions,
        terminalSessions: closedTerminalSessions,
        imageGenerations: stoppedImageGenerations,
        nativeTextGenerationResources: stoppedNativeTextGenerationResources,
        workspaceProcesses: stoppedWorkspaceProcesses,
      },
      "Stopped active providers and local backend resources"
    )
  }

  // (b) Interrupt all in-flight streaming turns, then wait for them
  //     to settle (abort controllers fire → finally blocks run).
  // M6: log instead of silently mapping every error to 0 — diagnostic
  // info about a stuck interrupt mattered exactly once and we lost it.
  await Promise.all([httpDrain, wsDrain, applicationDrain, tailscaleRelease])
  await Promise.all([retentionShutdown, providerReaperShutdown])
  // The hub stops before the reactor and before ingestion, in that order.
  // `stopAll` emits the hub's own terminals for anything still open — a
  // `turn.aborted` per admitted turn, a `session.exited` per live session —
  // and those have to meet a subscribed ingestion to be journaled; stopping
  // ingestion first would leave the journal showing turns that never ended.
  // The startup unwind (`startupCleanup` reversed) does not honour this; it
  // runs only for a boot that failed before this handle existed, where no
  // turn should be open.
  await providerHub.stopAll(providerSessionBindings).catch((error) => {
    providerHubStopFailure = error
    logger.error({ err: error }, "providerHub.stopAll failed during shutdown")
  })
  let checkpointReactorFailure: unknown = null
  await checkpointReactor.stop().catch((error) => {
    checkpointReactorFailure = error
    logger.error(
      { err: error },
      "checkpoint reactor failed to stop during shutdown"
    )
  })
  let providerRuntimeIngestionFailure: unknown = null
  try {
    providerRuntimeIngestion.stop()
  } catch (error) {
    providerRuntimeIngestionFailure = error
    logger.error(
      { err: error },
      "provider runtime ingestion failed its durability barrier"
    )
  }
  let checkpointRefCleanupFailure: unknown = null
  await checkpointRefCleanup.stop().catch((error) => {
    checkpointRefCleanupFailure = error
    logger.error(
      { err: error },
      "checkpoint ref cleanup failed to stop during shutdown"
    )
  })
  let gitProcessShutdownFailure: unknown = null
  // Checkpoint capture is itself a Git producer. Keep Git available
  // until provider completions have drained and the reactor has
  // reached its durability barrier, then close admission and terminate
  // any external Git request that outlived the transport drain.
  await requestGitProcessShutdown().catch((error) => {
    gitProcessShutdownFailure = error
    logger.error(
      { err: error },
      "Git processes failed to terminate during shutdown"
    )
  })

  if (shellSessions.activeSessionCount() > 0 && shellShutdownFailure === null) {
    shellShutdownFailure = new Error(
      `${shellSessions.activeSessionCount()} shell session(s) remain active`
    )
  }
  if (
    terminalPtys.activeSessionCount() > 0 &&
    terminalShutdownFailure === null
  ) {
    terminalShutdownFailure = new Error(
      `${terminalPtys.activeSessionCount()} terminal session(s) remain active`
    )
  }
  if (
    gitProcesses.activeProcessCount() > 0 &&
    gitProcessShutdownFailure === null
  ) {
    gitProcessShutdownFailure = new Error(
      `${gitProcesses.activeProcessCount()} Git process(es) remain active`
    )
  }
  if (
    imageGenerations.activeGenerationCount() > 0 &&
    imageGenerationShutdownFailure === null
  ) {
    imageGenerationShutdownFailure = new Error(
      `${imageGenerations.activeGenerationCount()} image generation process tree(s) remain active`
    )
  }
  if (
    nativeTextGenerations.activeResourceCount() > 0 &&
    nativeTextGenerationShutdownFailure === null
  ) {
    nativeTextGenerationShutdownFailure = new Error(
      `${nativeTextGenerations.activeResourceCount()} native text-generation resource(s) remain active`
    )
  }
  if (
    workspaceProcesses.activeProcessCount() > 0 &&
    workspaceProcessShutdownFailure === null
  ) {
    workspaceProcessShutdownFailure = new Error(
      `${workspaceProcesses.activeProcessCount()} workspace formatter/config process(es) remain active`
    )
  }
  if (
    remoteProviderTurns.activeCount() > 0 &&
    remoteProviderTurnShutdownFailure === null
  ) {
    remoteProviderTurnShutdownFailure = new Error(
      `${remoteProviderTurns.activeCount()} remote-owned provider turn(s) remain active`
    )
  }
  const criticalDrainFailures = [
    codeSearchShutdownFailure,
    orchestratorShutdownFailure,
    httpDrainFailure,
    wsDrainFailure,
    applicationDrainFailure,
    retentionFailure,
    providerReaperFailure,
    legacyInterruptFailure,
    nativeInterruptFailure,
    remoteProviderTurnShutdownFailure,
    providerHubStopFailure,
    checkpointReactorFailure,
    providerRuntimeIngestionFailure,
    checkpointRefCleanupFailure,
    gitProcessShutdownFailure,
    imageGenerationShutdownFailure,
    nativeTextGenerationShutdownFailure,
    workspaceProcessShutdownFailure,
    shellShutdownFailure,
    terminalShutdownFailure,
  ].filter((failure) => failure != null)
  if (criticalDrainFailures.length > 0) {
    const failClosedCleanupFailures: unknown[] = []
    await runShutdownSteps(
      [
        {
          name: "fail-closed settings listener",
          run: () => settings.off("change", onSettingsChange),
        },
        {
          name: "fail-closed remote expiration scheduler",
          run: () => remoteAccess.close(),
        },
        {
          name: "fail-closed transcript recovery timer",
          run: () => clearInterval(transcriptRecoveryTimer),
        },
        {
          name: "fail-closed startup abort listener",
          run: () =>
            options.signal?.removeEventListener("abort", onStartupAbort),
        },
        {
          name: "fail-closed vacuum timer",
          run: () => {
            if (vacuumTimer) clearInterval(vacuumTimer)
          },
        },
      ],
      ({ name, cause }) => {
        failClosedCleanupFailures.push(cause)
        logger.error(
          { err: cause, step: name },
          "fail-closed shutdown cleanup step failed"
        )
      }
    ).catch((error) => {
      if (failClosedCleanupFailures.length === 0) {
        failClosedCleanupFailures.push(error)
      }
    })
    throw new AggregateError(
      [...criticalDrainFailures, ...failClosedCleanupFailures],
      `Backend drain failed in ${criticalDrainFailures.length} step(s); refusing unsafe teardown`
    )
  }

  const cleanupSteps: ShutdownStep[] = [
    {
      name: "HTTP request drain",
      run: () => {
        if (httpDrainFailure) throw httpDrainFailure
      },
    },
    {
      name: "tool output archive stores",
      run: stopAllToolOutputArchiveStores,
    },
    {
      name: "image generation processes",
      run: () => requestImageGenerationShutdown().then(() => undefined),
    },
    {
      name: "native text-generation resources",
      run: () => requestNativeTextGenerationShutdown().then(() => undefined),
    },
    {
      name: "workspace formatter/config processes",
      run: () => requestWorkspaceProcessShutdown().then(() => undefined),
    },
    {
      name: "thread retention scheduler",
      run: () => {
        if (retentionFailure) throw retentionFailure
      },
    },
    {
      name: "legacy provider interruption",
      run: () => {
        if (legacyInterruptFailure) throw legacyInterruptFailure
      },
    },
    {
      name: "native provider shutdown",
      run: () => {
        if (providerHubStopFailure) throw providerHubStopFailure
      },
    },
    {
      name: "settings change listener",
      run: () => {
        settings.off("change", onSettingsChange)
      },
    },
    {
      name: "remote access expiration scheduler",
      run: () => remoteAccess.close(),
    },
    {
      name: "remote session process cleanup listener",
      run: unsubscribeRemoteOwnerCleanup,
    },
    {
      name: "provider hub event subscription",
      run: unsubscribeProviderHubEvents,
    },
    {
      name: "provider event log flush",
      run: async () => {
        const results = await Promise.allSettled(
          providerEventLoggers.map((eventLogger) => eventLogger.flush())
        )
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        )
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "One or more provider event logs failed to flush"
          )
        }
      },
    },
    ...providerEventLoggers.map(
      (eventLogger, index): ShutdownStep => ({
        name: `provider event log ${index + 1}`,
        run: () => eventLogger.close(),
      })
    ),
    {
      name: "checkpoint reactor",
      run: () => checkpointReactor.stop(),
    },
    {
      name: "provider runtime ingestion",
      run: () => providerRuntimeIngestion.stop(),
    },
    {
      name: "transcript recovery timer",
      run: () => clearInterval(transcriptRecoveryTimer),
    },
    {
      name: "transcript recovery replay",
      run: () => {
        transcriptRecoveryStore.replay(transcriptRecoveryTarget, {
          maxRecords: 32,
        })
      },
    },
    {
      name: "checkpoint ref cleanup scheduler",
      run: () => checkpointRefCleanup.stop(),
    },
    {
      name: "Git processes",
      run: async () => {
        await requestGitProcessShutdown()
      },
    },
    {
      name: "startup abort listener",
      run: () => {
        options.signal?.removeEventListener("abort", onStartupAbort)
      },
    },
    {
      name: "provider session reaper",
      run: () => providerSessionReaper?.stop(),
    },
    {
      name: "WebSocket hub",
      run: async () => {
        await hub.close()
        logger.info("WebSocket hub closed")
      },
    },
    {
      name: "HTTP runtime error listener",
      run: () => {
        server.off("error", candidateRuntimeErrorListener)
      },
    },
    {
      name: "vacuum timer",
      run: () => {
        if (vacuumTimer) clearInterval(vacuumTimer)
      },
    },
    {
      name: "agent permission runtime",
      // Retain policy through every provider callback and durability drain;
      // release its DB reference and thread contexts only after they settle.
      run: () => releaseAgentPermissionRuntime(root.agentPermissionRuntime),
    },
    {
      name: "SQLite database",
      run: () => {
        db.close()
        logger.info("SQLite database closed")
      },
    },
  ]

  await runShutdownSteps(cleanupSteps, ({ name, cause }) => {
    logger.error({ err: cause, step: name }, "shutdown step failed")
  })
  logger.info("Backend shutdown complete")
}

/**
 * Startup failed somewhere after `createBootRoot`: close admission, start
 * child termination first (it is the slow part), then run every registered
 * cleanup step in reverse under the hard timeout. Never throws — the caller
 * rethrows the original startup error; a failed or timed-out unwind is only
 * logged so it stays visible to the embedding host.
 */
export async function unwindStartup(root: BootRoot): Promise<void> {
  const { requestAdmission, startupCleanup } = root
  const {
    git: requestGitProcessShutdown,
    imageGeneration: requestImageGenerationShutdown,
    nativeTextGeneration: requestNativeTextGenerationShutdown,
    workspace: requestWorkspaceProcessShutdown,
  } = root.resourceShutdowns
  requestAdmission.beginDrain()
  beginResourceManagerShutdowns(root)
  // Start child termination before any potentially slow scheduler/service
  // cleanup. The bounded unwind below still awaits the shared promise.
  void requestGitProcessShutdown().catch((shutdownError) => {
    logger.error(
      { err: shutdownError },
      "Git process shutdown failed during backend startup unwind"
    )
  })
  void requestImageGenerationShutdown().catch((shutdownError) => {
    logger.error(
      { err: shutdownError },
      "Image generation shutdown failed during backend startup unwind"
    )
  })
  void requestNativeTextGenerationShutdown().catch((shutdownError) => {
    logger.error(
      { err: shutdownError },
      "Native text-generation shutdown failed during backend startup unwind"
    )
  })
  void requestWorkspaceProcessShutdown().catch((shutdownError) => {
    logger.error(
      { err: shutdownError },
      "Workspace process shutdown failed during backend startup unwind"
    )
  })
  await runWithShutdownDeadline(
    () =>
      runShutdownSteps([...startupCleanup].reverse(), ({ name, cause }) => {
        logger.error({ err: cause, step: name }, "startup cleanup step failed")
      }),
    SHUTDOWN_HARD_TIMEOUT_MS,
    (timeoutError) => {
      logger.error(
        { err: timeoutError },
        "Backend startup unwind exceeded its hard timeout"
      )
    }
  ).catch((cleanupError) => {
    // Preserve the original startup error, but keep the failed or timed-out
    // unwind visible to the embedding host's logs.
    logger.error(
      { err: cleanupError },
      "Backend startup unwind did not complete cleanly"
    )
  })
}
