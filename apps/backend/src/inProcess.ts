import http from "node:http"
import { candidatePorts } from "./config"
import { logger } from "./observability/logger"
import { closeHttpServer, type ShutdownStep } from "./shutdown"
import type {
  BootRoot,
  HttpApp,
  PersistenceContext,
  ProvidersContext,
  RecoveryContext,
  RetentionContext,
  SettingsContext,
  StartOptions,
  StartedBackend,
  TimersContext,
  TransportContext,
} from "./bootstrap/context"
import { createBootRoot, reopenResourceAdmissions } from "./bootstrap/lifecycle"
import { openPersistence } from "./bootstrap/persistence"
import {
  loadSettingsAndRemote,
  reconcileTailscaleServeForPort,
} from "./bootstrap/settings"
import { wireProviders } from "./bootstrap/providers"
import {
  attachRuntimeErrorListener,
  bindHttpServer,
  buildHttpApp,
  createTransport,
} from "./bootstrap/http"
import {
  recoverCheckpointsAndWorktrees,
  recoverProviderRuntime,
} from "./bootstrap/recovery"
import { startRetention, startTimers } from "./bootstrap/schedulers"
import { createStopHandle, unwindStartup } from "./bootstrap/shutdown"

export type { StartOptions, StartedBackend } from "./bootstrap/context"

/**
 * Observe the registered startup cleanup steps once every service is built and
 * before the HTTP listener binds — test hook only. The unwind runs these steps
 * reversed, so their order is load-bearing and pinned by `inProcess.test.ts`.
 */
let startupCleanupObserver: ((steps: readonly ShutdownStep[]) => void) | null =
  null
export function __observeStartupCleanupForTests(
  observer: ((steps: readonly ShutdownStep[]) => void) | null
): void {
  startupCleanupObserver = observer
}

/**
 * Bootstraps every service layer, then binds HTTP+WS on a free port.
 *
 * The phases live in `bootstrap/` and run in the one order their
 * construction dependencies allow; each takes the contexts built before it
 * and returns its own. Every phase pushes its cleanup steps onto the shared
 * `root.startupCleanup` ledger, which `unwindStartup` runs reversed if any
 * later phase throws — so the call order below is load-bearing.
 */
export async function startNodeBackend(
  options: StartOptions = {}
): Promise<StartedBackend> {
  options.signal?.throwIfAborted()
  const root = createBootRoot(options)
  const heartbeat = startStartupHeartbeat(options)
  try {
    reopenResourceAdmissions(root)
  } catch (error) {
    heartbeat.stop()
    throw error
  }

  try {
    const persistence = openPersistence(root)
    const settingsCtx = loadSettingsAndRemote(root, persistence)
    const providersCtx = wireProviders(root, persistence, settingsCtx)
    const { state } = providersCtx
    const { hub } = createTransport(root, settingsCtx, state)
    const recovery = recoverProviderRuntime(
      root,
      persistence,
      settingsCtx,
      providersCtx,
      hub
    )
    await recoverCheckpointsAndWorktrees(root, providersCtx)
    const retention = startRetention(
      root,
      persistence,
      settingsCtx,
      providersCtx
    )
    const app = buildHttpApp(root, state, hub)
    const timers = startTimers(root, persistence, settingsCtx, providersCtx)
    startupCleanupObserver?.(root.startupCleanup)
    return await bindAndPublish(root, app, {
      persistence,
      settingsCtx,
      providersCtx,
      hub,
      recovery,
      retention,
      timers,
    })
  } catch (error) {
    await unwindStartup(root)
    throw error
  } finally {
    heartbeat.stop()
  }
}

interface BuiltBackend {
  readonly persistence: PersistenceContext
  readonly settingsCtx: SettingsContext
  readonly providersCtx: ProvidersContext
  readonly hub: TransportContext["hub"]
  readonly recovery: RecoveryContext
  readonly retention: RetentionContext
  readonly timers: TimersContext
}

/**
 * The port loop: try each candidate port, and on the first successful bind
 * attach the hub, mint the `stop()` handle and publish the backend. A bind
 * failure on a busy port moves on to the next candidate; any other failure
 * after a bind (or an abort) closes that candidate and propagates.
 */
async function bindAndPublish(
  root: BootRoot,
  app: HttpApp,
  built: BuiltBackend
): Promise<StartedBackend> {
  const { options, config } = root
  const { taintBackend, isBackendTainted, fatalLifecycle } = root.taint
  const {
    persistence,
    settingsCtx,
    providersCtx,
    hub,
    recovery,
    retention,
    timers,
  } = built
  const { state } = providersCtx
  const { threadRetention } = retention
  const ports = candidatePorts(config.port)
  let lastError: unknown = null
  for (const port of ports) {
    let candidateServer: http.Server | null = null
    let candidateServerShuttingDown = false
    let candidateRuntimeErrorListener: ((error: Error) => void) | null = null
    try {
      const server = await bindHttpServer(app.fetch as never, config.host, port)
      candidateServer = server
      candidateRuntimeErrorListener = attachRuntimeErrorListener(
        server,
        port,
        taintBackend,
        () => candidateServerShuttingDown
      )
      options.signal?.throwIfAborted()
      hub.attach(server)
      const actual = (server.address() as { port: number }).port
      config.port = actual
      logger.info({ host: config.host, port: actual }, "Node backend ready")
      reconcileTailscaleServeForPort(settingsCtx, actual)
      setImmediate(() => {
        void threadRetention.runNow().catch((error) => {
          logger.error({ err: error }, "initial thread retention pass failed")
        })
      }).unref?.()
      const stop = createStopHandle(
        {
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
        },
        () => {
          candidateServerShuttingDown = true
        }
      )
      const startedBackend: StartedBackend = {
        port: actual,
        token: config.authToken!,
        httpServer: server,
        hub,
        config,
        state,
        taint: taintBackend,
        stop,
      }
      fatalLifecycle.stop = () => startedBackend.stop()
      if (isBackendTainted()) {
        await startedBackend.stop()
        throw new Error("Backend became tainted during startup")
      }
      return startedBackend
    } catch (err) {
      lastError = err
      if (candidateServer) {
        candidateServerShuttingDown = true
        try {
          await closeHttpServer(candidateServer, 1_000).catch((closeError) => {
            logger.warn(
              { port, err: closeError },
              "failed to close partially initialized HTTP server"
            )
          })
        } finally {
          if (candidateRuntimeErrorListener) {
            candidateServer.off("error", candidateRuntimeErrorListener)
          }
        }
      }
      if (options.signal?.aborted || candidateServer) {
        throw err
      }
      logger.warn(
        { port, err: (err as Error).message },
        "port busy, trying next"
      )
    }
  }
  throw new Error(
    `Failed to bind on any candidate port: ${(lastError as Error | null)?.message ?? "unknown"}`
  )
}

/**
 * Host progress reporting: one heartbeat immediately, then every five seconds
 * until startup settles. Advisory — a throwing callback must never break
 * startup. Lives here because `startNodeBackend` owns the `finally` that
 * stops it.
 */
function startStartupHeartbeat(options: StartOptions): { stop(): void } {
  const emitStartupHeartbeat = () => {
    try {
      options.onStartupHeartbeat?.()
    } catch {
      // Host progress reporting is advisory and must never break startup.
    }
  }
  const startupHeartbeatTimer: NodeJS.Timeout | null =
    options.onStartupHeartbeat ? setInterval(emitStartupHeartbeat, 5_000) : null
  startupHeartbeatTimer?.unref()
  emitStartupHeartbeat()
  return {
    stop: () => {
      if (startupHeartbeatTimer) clearInterval(startupHeartbeatTimer)
    },
  }
}
