import { createServerConfig } from "../config"
import { generateToken } from "../security/token"
import { logger } from "../observability/logger"
import { getMasterKey } from "../settings/crypto"
import { AdmissionGate } from "../lifecycle/AdmissionGate"
import type { ShutdownStep } from "../shutdown"
import {
  activeShellSessionCount,
  beginShellShutdown,
  resumeShellAdmissions,
} from "../services/shell"
import {
  activeTerminalPtySessionCount,
  beginTerminalPtyShutdown,
  resumeTerminalPtyAdmissions,
} from "../services/terminalPty"
import {
  activeGitProcessCount,
  beginGitProcessShutdown,
  resumeGitProcessAdmissions,
  shutdownAllGitProcesses,
} from "../services/git"
import {
  activeImageGenerationCount,
  beginImageGenerationShutdown,
  resumeImageGenerationAdmissions,
  shutdownAllImageGenerations,
} from "../services/image-generation"
import {
  activeNativeTextGenerationResourceCount,
  beginNativeTextGenerationShutdown,
  resumeNativeTextGenerationAdmissions,
  shutdownAllNativeTextGenerationResources,
} from "../services/native-text-generation"
import {
  activeWorkspaceProcessCount,
  beginWorkspaceProcessShutdown,
  resumeWorkspaceProcessAdmissions,
  shutdownAllWorkspaceProcesses,
} from "../services/workspace"
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
  const config = createServerConfig({
    dataDir: options.dataDir,
    port: options.preferredPort,
  })
  config.authToken = generateToken()
  const startupCleanup: ShutdownStep[] = []
  const requestAdmission = new AdmissionGate()
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
  const requestGitProcessShutdown = singleFlight(shutdownAllGitProcesses)
  const requestImageGenerationShutdown = singleFlight(
    shutdownAllImageGenerations
  )
  const requestNativeTextGenerationShutdown = singleFlight(
    shutdownAllNativeTextGenerationResources
  )
  const requestWorkspaceProcessShutdown = singleFlight(
    shutdownAllWorkspaceProcesses
  )
  const onStartupAbort = () => {
    requestAdmission.beginDrain()
    beginResourceManagerShutdowns()
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
  const { options, startupCleanup, onStartupAbort } = root
  try {
    const retainedStartupResources = [
      ["shell session", activeShellSessionCount()],
      ["terminal PTY session", activeTerminalPtySessionCount()],
      ["Git process", activeGitProcessCount()],
      ["image generation", activeImageGenerationCount()],
      [
        "native text-generation resource",
        activeNativeTextGenerationResourceCount(),
      ],
      ["workspace process", activeWorkspaceProcessCount()],
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
    resumeShellAdmissions()
    resumeTerminalPtyAdmissions()
    resumeGitProcessAdmissions()
    resumeImageGenerationAdmissions()
    resumeNativeTextGenerationAdmissions()
    resumeWorkspaceProcessAdmissions()
  } catch (error) {
    // Admission reopening is a startup transaction: if a later resource
    // manager still has survivors, do not leave managers resumed earlier in
    // the sequence accepting work while backend startup has already failed.
    beginResourceManagerShutdowns()
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
export function beginResourceManagerShutdowns(): void {
  beginShellShutdown()
  beginTerminalPtyShutdown()
  beginGitProcessShutdown()
  beginImageGenerationShutdown()
  beginNativeTextGenerationShutdown()
  beginWorkspaceProcessShutdown()
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
