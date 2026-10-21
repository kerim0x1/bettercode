import { startNodeBackend, type StartedBackend } from "./inProcess"
import { logger } from "./observability/logger"

/**
 * Standalone backend entrypoint. Signal/IPC handlers are installed before any
 * startup work so termination also unwinds a partially initialized backend.
 */
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
  requestFatalShutdown(reason, "unhandledRejection")
})
process.on("uncaughtException", (error, origin) => {
  requestFatalShutdown(error, origin)
})
process.on("message", (msg: unknown) => {
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
    const started = await startNodeBackend({
      dataDir: process.env.BETTERC0DE_DATA_DIR,
      signal: startupAbort.signal,
      onStartupHeartbeat: () => {
        process.stderr.write(
          `${JSON.stringify({
            control: "betterc0de/backend-startup",
            status: "starting",
            protocol: 1,
          })}\n`
        )
      },
      onFatal: (error, origin) => requestFatalShutdown(error, origin),
    })
    startedBackend = started
    if (shutdownSignal) {
      await shutdownStartedBackend(started, shutdownSignal)
      return
    }

    process.stderr.write(
      `${JSON.stringify({
        port: started.port,
        token: started.token,
        status: "ready",
      })}\n`
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
    process.stderr.write(`${JSON.stringify({ status: "error", message })}\n`)
    process.exit(1)
  }
}

void main()
