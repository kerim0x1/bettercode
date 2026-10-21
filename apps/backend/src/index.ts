import { startNodeBackend, type StartedBackend } from "./inProcess"
import { logger } from "./observability/logger"
import {
  sendStartupControl,
  startupControlChannelFromEnvironment,
} from "./startupControl"
import {
  createSettingsKeyIntake,
  createUnhandledRejectionPolicy,
  installSettingsMasterKey,
} from "./processGuards"

/**
 * Standalone backend entrypoint. Signal/IPC handlers are installed before any
 * startup work so termination also unwinds a partially initialized backend.
 */
const SETTINGS_KEY_TIMEOUT_MS = 30_000
const settingsKeyIntake = createSettingsKeyIntake()
// Read once, before any child process could inherit the request.
const startupControl = { channel: startupControlChannelFromEnvironment() }
const rejectionPolicy = createUnhandledRejectionPolicy()
const startupAbort = new AbortController()
let startedBackend: StartedBackend | null = null
let shutdownSignal: string | null = null
let shutdownPromise: Promise<void> | null = null
let shutdownExitCode = 0
let fatalError: Error | null = null

function requestShutdown(signal: string): void {
  if (shutdownSignal) {
    logger.warn(
      { signal, firstSignal: shutdownSignal },
      "Second shutdown signal received — forcing immediate exit"
    )
    process.exit(1)
  }
  shutdownSignal = signal
  startupAbort.abort(new Error(`Backend startup cancelled by ${signal}`))
  if (startedBackend) void shutdownStartedBackend(startedBackend, signal)
}

function requestFatalShutdown(reason: unknown, origin: string): void {
  if (fatalError) return
  fatalError = reason instanceof Error ? reason : new Error(String(reason))
  logger.fatal(
    { err: fatalError, origin },
    "Fatal backend process error; starting emergency drain"
  )
  startupAbort.abort(fatalError)
  if (startedBackend) {
    startedBackend.taint(fatalError, origin)
    void shutdownStartedBackend(startedBackend, origin, 1)
  }
}

async function shutdownStartedBackend(
  started: StartedBackend,
  signal: string,
  requestedExitCode = 0
): Promise<void> {
  shutdownExitCode = Math.max(shutdownExitCode, requestedExitCode)
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    logger.info({ signal }, "Shutdown signal received")
    try {
      await started.stop()
    } catch (err) {
      shutdownExitCode = 1
      logger.error({ err, signal }, "Backend shutdown failed")
    } finally {
      process.exit(shutdownExitCode)
    }
  })()
  return shutdownPromise
}

process.on("SIGINT", () => requestShutdown("SIGINT"))
process.on("SIGTERM", () => requestShutdown("SIGTERM"))
process.on("unhandledRejection", (reason) => {
  const verdict = rejectionPolicy.classify(reason)
  if (verdict.fatal) {
    requestFatalShutdown(reason, `unhandledRejection: ${verdict.why}`)
    return
  }
  // A rejected promise nobody awaited is a bug in one code path, not proof
  // that shared state is broken. Ending the process here would drop every
  // chat, terminal and file operation for it, so log it with enough context
  // to fix and keep serving. (Uncaught exceptions stay fatal: the stack they
  // unwound may have left state half-updated.)
  const err = reason instanceof Error ? reason : new Error(String(reason))
  // The logger prints the stack and cause chain of `err` below the line.
  logger.error(
    { err, origin: "unhandledRejection", recentCount: verdict.recentCount },
    "Unhandled promise rejection; the backend keeps running"
  )
})
process.on("uncaughtException", (error, origin) => {
  requestFatalShutdown(error, origin)
})
process.on("message", (msg: unknown) => {
  // The Electron host hands over the settings master key first (see
  // processGuards.ts); it never travels through the environment.
  if (settingsKeyIntake.accept(msg)) return
  if (
    msg &&
    typeof msg === "object" &&
    (msg as { type?: string }).type === "shutdown"
  ) {
    requestShutdown("IPC")
  }
})
// The Electron host forks this process `detached`, so a host that dies without
// running its shutdown sequence (Ctrl-C in the dev terminal, `concurrently
// --kill-others`, a crash) never sends `shutdown` or SIGTERM, and the terminal's
// SIGINT does not reach our separate session either. The IPC channel does
// close, though. Without this the orphaned sidecar keeps the data-directory
// lock and the next launch fails with "Another BetterC0de backend is using this
// data directory". A disconnect during an already-running shutdown is expected
// and must not trigger the second-signal force-exit path.
process.on("disconnect", () => {
  if (shutdownSignal || fatalError) return
  requestShutdown("parent disconnected")
})

async function main(): Promise<void> {
  try {
    if (process.env.BETTERC0DE_SETTINGS_KEY_VIA_IPC === "1") {
      delete process.env.BETTERC0DE_SETTINGS_KEY_VIA_IPC
      // Settings are decrypted during startup, so wait for the key first.
      const key = await settingsKeyIntake.wait({
        timeoutMs: SETTINGS_KEY_TIMEOUT_MS,
        signal: startupAbort.signal,
      })
      installSettingsMasterKey(key)
    }
    const started = await startNodeBackend({
      dataDir: process.env.BETTERC0DE_DATA_DIR,
      // The desktop configuration folder the shell resolved
      // (apps/shell/shared/runtime-paths.cjs).
      runtimeHome: process.env.BETTERC0DE_RUNTIME_HOME,
      signal: startupAbort.signal,
      // Startup frames go over the fork IPC channel when the Electron shell
      // asked for that, and to stderr otherwise (startupControl.ts).
      onStartupHeartbeat: () => {
        void sendStartupControl({ status: "starting" }, startupControl)
      },
      onFatal: (error, origin) => requestFatalShutdown(error, origin),
    })
    startedBackend = started
    if (shutdownSignal) {
      await shutdownStartedBackend(started, shutdownSignal)
      return
    }

    await sendStartupControl(
      {
        status: "ready",
        port: started.port,
        token: started.token,
      },
      startupControl
    )
  } catch (err) {
    if (fatalError) {
      logger.error(
        { err: fatalError },
        "Backend startup aborted by fatal error"
      )
      process.exit(1)
    }
    if (shutdownSignal && startupAbort.signal.aborted) {
      logger.info(
        { signal: shutdownSignal },
        "Backend startup cancelled before readiness"
      )
      process.exit(0)
    }
    const message = err instanceof Error ? err.message : String(err)
    // Delivered (or timed out) before exiting, so the host can say why.
    await sendStartupControl({ status: "error", message }, startupControl)
    process.exit(1)
  }
}

void main()
