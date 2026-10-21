import { createServerConfig } from "../config"
import { generateToken } from "../security/token"
import { logger } from "../observability/logger"
import { getMasterKey } from "../settings/crypto"
import { hardenBackendProcessEnvironment } from "../security/processHardening"
import { configureChildProcessRegistry } from "../services/child-process-registry"
import { AdmissionGate } from "../lifecycle/AdmissionGate"
import { ProviderEventBus } from "../provider/events"
import { AgentPermissionRuntime } from "../provider/agent-permission-runtime"
import type { ShutdownStep } from "../shutdown"
import { ShellSessionService } from "../services/shell"
import { TerminalPtyService } from "../services/terminalPty"
import {
  defaultGitProcessService,
  GitProcessService,
  setDefaultGitProcessService,
} from "../services/git"
import { ImageGenerationService } from "../services/image-generation"
import { NativeTextGenerationService } from "../services/native-text-generation"
import {
  defaultWorkspaceProcessService,
  setDefaultWorkspaceProcessService,
  WorkspaceProcessService,
} from "../services/workspace"
import { WorkspaceRecoveryGate } from "../services/workspace-recovery-gate"
import type { BootRoot, StartOptions } from "./context"

/**
 * Phase 0: configuration, the cleanup ledger, the admission gate, the taint
 * machinery and the shutdown requesters. Nothing here has a side effect
 * beyond caching the master key and minting the bearer token — resource
 * admissions are reopened separately by `reopenResourceAdmissions` so the
 * host's first startup heartbeat fires between the two, exactly as before.
 */
export function createBootRoot(options: StartOptions): BootRoot {
  // Cache the safeStorage-provisioned key, then remove it from process.env so
  // no provider, terminal, shell, or project subprocess can inherit it.
  getMasterKey()
  hardenBackendProcessEnvironment()
  const config = createServerConfig({
    dataDir: options.dataDir,
    runtimeHome: options.runtimeHome,
    port: options.preferredPort,
  })
  // Reap process trees a crashed predecessor left running; background only.
  void configureChildProcessRegistry({ dataDir: config.dataDir })
  config.authToken = generateToken()
  const startupCleanup: ShutdownStep[] = []
  const requestAdmission = new AdmissionGate()
  const terminalPtys = new TerminalPtyService()
  const shellSessions = new ShellSessionService()
  const gitProcesses = new GitProcessService()
  const imageGenerations = new ImageGenerationService()
  const nativeTextGenerations = new NativeTextGenerationService()
  const workspaceProcesses = new WorkspaceProcessService()
  // This backend's own bus; every bootstrap phase reads it from here.
  const eventBus = new ProviderEventBus()
  // Its policy is attached (and the runtime installed) by `openPersistence`.
  const agentPermissionRuntime = new AgentPermissionRuntime({
    events: eventBus,
  })
  const workspaceRecoveryGate = new WorkspaceRecoveryGate()
  let backendTainted = false
  const fatalLifecycle: { stop?: () => Promise<void> } = {}
  const isBackendTainted = () => backendTainted
  const taintBackend = (error: Error, origin: string) => {
    if (backendTainted) return
    backendTainted = true
    requestAdmission.beginDrain()
    logger.fatal(
      { err: error, origin },
      "Backend tainted; refusing new work and starting emergency drain"
    )
    try {
      options.onFatal?.(error, origin)
    } catch (callbackError) {
      logger.error(
        { err: callbackError, origin },
        "backend fatal callback failed"
      )
    }
    const emergencyStop = fatalLifecycle.stop
    if (emergencyStop) {
      void emergencyStop().catch((stopError: unknown) => {
        logger.error(
          { err: stopError, origin },
          "backend emergency drain failed"
        )
      })
    }
  }
  const requestGitProcessShutdown = singleFlight(() =>
    gitProcesses.shutdownAll()
  )
  const requestImageGenerationShutdown = singleFlight(() =>
    imageGenerations.shutdownAll()
  )
  const requestNativeTextGenerationShutdown = singleFlight(() =>
    nativeTextGenerations.shutdownAll()
  )
  const requestWorkspaceProcessShutdown = singleFlight(() =>
    workspaceProcesses.shutdownAll()
  )
  const onStartupAbort = () => {
    requestAdmission.beginDrain()
    beginResourceManagerShutdowns({
      terminalPtys,
      shellSessions,
      gitProcesses,
      imageGenerations,
      nativeTextGenerations,
      workspaceProcesses,
    })
    void requestGitProcessShutdown().catch((error) => {
      logger.error(
        { err: error },
        "Git process shutdown failed while cancelling backend startup"
      )
    })
    void requestImageGenerationShutdown().catch((error) => {
      logger.error(
        { err: error },
        "Image generation shutdown failed while cancelling backend startup"
      )
    })
    void requestNativeTextGenerationShutdown().catch((error) => {
      logger.error(
        { err: error },
        "Native text-generation shutdown failed while cancelling backend startup"
      )
    })
    void requestWorkspaceProcessShutdown().catch((error) => {
      logger.error(
        { err: error },
        "Workspace process shutdown failed while cancelling backend startup"
      )
    })
  }
  return {
    options,
    config,
    startupCleanup,
    requestAdmission,
    eventBus,
    terminalPtys,
    shellSessions,
    gitProcesses,
    imageGenerations,
    nativeTextGenerations,
    workspaceProcesses,
    workspaceRecoveryGate,
    agentPermissionRuntime,
    taint: { taintBackend, isBackendTainted, fatalLifecycle },
    resourceShutdowns: {
      git: requestGitProcessShutdown,
      imageGeneration: requestImageGenerationShutdown,
      nativeTextGeneration: requestNativeTextGenerationShutdown,
      workspace: requestWorkspaceProcessShutdown,
    },
    onStartupAbort,
  }
}

/**
 * Phase 0, second half: reopen every resource manager's admission as one
 * transaction, then arm the startup abort listener and register the first
 * cleanup step. Throws `BACKEND_RESOURCE_SURVIVORS` when a previous backend
 * in this process left retained resources behind.
 */
export function reopenResourceAdmissions(root: BootRoot): void {
  const {
    options,
    startupCleanup,
    onStartupAbort,
    terminalPtys,
    shellSessions,
    gitProcesses,
    imageGenerations,
    nativeTextGenerations,
    workspaceProcesses,
  } = root
  try {
    // The terminals, shell sessions and image and native text generations
    // belong to this instance and start empty. Git and the workspace helper
    // processes run through the service installed as the default
    // (`setDefaultGitProcessService`, `setDefaultWorkspaceProcessService`):
    // the one installed until now (a previous backend's, or one created for
    // work outside a backend) must have let go of its processes before this
    // backend's replaces it.
    const installedGitProcesses = defaultGitProcessService()
    const installedWorkspaceProcesses = defaultWorkspaceProcessService()
    const retainedStartupResources = [
      [
        "Git process",
        installedGitProcesses === gitProcesses
          ? 0
          : installedGitProcesses.activeProcessCount(),
      ],
      [
        "workspace process",
        installedWorkspaceProcesses === workspaceProcesses
          ? 0
          : installedWorkspaceProcesses.activeProcessCount(),
      ],
    ] as const
    const startupSurvivors = retainedStartupResources.filter(
      ([, count]) => count > 0
    )
    if (startupSurvivors.length > 0) {
      throw Object.assign(
        new Error(
          `Cannot reopen backend resource admissions while retained resources remain: ${startupSurvivors
            .map(
              ([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`
            )
            .join(", ")}.`
        ),
        {
          code: "BACKEND_RESOURCE_SURVIVORS",
          survivors: Object.fromEntries(startupSurvivors),
        }
      )
    }
    shellSessions.resumeAdmissions()
    terminalPtys.resumeAdmissions()
    setDefaultGitProcessService(gitProcesses)
    gitProcesses.resumeAdmissions()
    imageGenerations.resumeAdmissions()
    nativeTextGenerations.resumeAdmissions()
    setDefaultWorkspaceProcessService(workspaceProcesses)
    workspaceProcesses.resumeAdmissions()
  } catch (error) {
    // Admission reopening is a startup transaction: if a later resource
    // manager still has survivors, do not leave managers resumed earlier in
    // the sequence accepting work while backend startup has already failed.
    beginResourceManagerShutdowns(root)
    throw error
  }
  options.signal?.addEventListener("abort", onStartupAbort, { once: true })
  startupCleanup.push({
    name: "startup abort listener",
    run: () => {
      options.signal?.removeEventListener("abort", onStartupAbort)
    },
  })
}

/**
 * Closes admission on every resource manager at once. Used on startup abort,
 * bind failure and admission-reopen failure; the graceful-shutdown path in
 * `stop()` keeps its own ordered sequence because it interleaves provider and
 * hub shutdown between these calls.
 */
export function beginResourceManagerShutdowns(
  root: Pick<
    BootRoot,
    | "terminalPtys"
    | "shellSessions"
    | "gitProcesses"
    | "imageGenerations"
    | "nativeTextGenerations"
    | "workspaceProcesses"
  >
): void {
  root.shellSessions.beginShutdown()
  root.terminalPtys.beginShutdown()
  root.gitProcesses.beginShutdown()
  root.imageGenerations.beginShutdown()
  root.nativeTextGenerations.beginShutdown()
  root.workspaceProcesses.beginShutdown()
}

/**
 * Wraps an async shutdown so concurrent callers share one in-flight promise
 * and a later caller (after it settled either way) starts a fresh run.
 */
export function singleFlight(
  run: () => Promise<number>
): () => Promise<number> {
  let inFlight: Promise<number> | null = null
  return () => {
    if (inFlight) return inFlight
    const current = run()
    inFlight = current
    const clear = () => {
      if (inFlight === current) inFlight = null
    }
    void current.then(clear, clear)
    return current
  }
}
