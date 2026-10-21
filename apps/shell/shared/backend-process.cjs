/**
 * The backend sidecar's process lifecycle: spawn, the startup handshake and
 * health probe, the bearer injection for renderer requests, supervision,
 * graceful and forced stop, restart and the development reloader. Extracted
 * from main.cjs, which creates one instance (`createBackendProcess`) and
 * keeps the application-level order: on start the window first, then the
 * settings key, the IPC handlers, plugins and the backend; on quit the CLI
 * processes and plugins first, then the backend.
 *
 * Every Electron object and every piece of main-process state this needs is
 * passed in, so the startup handshake can be tested with a fake child
 * process (scripts/backend-startup-watchdog.test.mjs):
 *
 * - `app` (`isPackaged`, `getAppPath()`) and `session` (`defaultSession`).
 * - `emitBackendStatus(status, payload)`: broadcast to every window.
 * - `isQuitting()`: whether the application is shutting down.
 * - `getSettingsEncryptionKey()`: the settings master key, handed to the
 *   backend over its private IPC channel at launch.
 * - `resolveUserDataDir()` and `resolveRuntimeHome()`
 *   (shared/runtime-paths.cjs): passed to the backend as
 *   `BETTERC0DE_DATA_DIR` and `BETTERC0DE_RUNTIME_HOME`.
 * - `resolveDevNodeExecPath()`, `resolveClaudeCodeBinaryPath()` and
 *   `resolveCliBinary(name)`: binaries forwarded to the backend.
 * - `getRendererSecurityPolicy()` and
 *   `isTrustedRendererRequest(details, policy)`: which renderer requests
 *   receive the bearer.
 * - Optional overrides for tests: `process`, `console`, `fork`, `spawn`,
 *   `readline`, `fs`, `shellDir`, `buildBackendEnvironment`,
 *   `createBackendStartupWatchdog`, `createBackendDevReloader`,
 *   `resolveDarwinChildPath`, `verifyBackendHealth`.
 */

const childProcess = require("child_process")
const path = require("path")
const appConfig = require("./appConfig.cjs")

const BACKEND_SHUTDOWN_TIMEOUT_MS = appConfig.BACKEND_SHUTDOWN_TIMEOUT_MS
const BACKEND_STARTUP_TIMEOUT_MS = appConfig.BACKEND_STARTUP_TIMEOUT_MS
const BACKEND_STARTUP_HARD_TIMEOUT_MS =
  appConfig.BACKEND_STARTUP_HARD_TIMEOUT_MS
const BACKEND_FORCE_KILL_EXIT_TIMEOUT_MS =
  appConfig.BACKEND_FORCE_KILL_EXIT_TIMEOUT_MS
const BACKEND_STOP_SIGNALS = ["SIGTERM", "SIGKILL"]

const REQUIRED_DEPENDENCIES = [
  "emitBackendStatus",
  "isQuitting",
  "getSettingsEncryptionKey",
  "resolveUserDataDir",
  "resolveRuntimeHome",
  "resolveDevNodeExecPath",
  "resolveClaudeCodeBinaryPath",
  "resolveCliBinary",
  "getRendererSecurityPolicy",
  "isTrustedRendererRequest",
]

function hasChildExited(child) {
  return (
    !child ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
}

function closeBackendReaders(handle) {
  try { handle.stdoutReader?.close() } catch {}
  try { handle.stderrReader?.close() } catch {}
}

// Startup frames the backend sends over the fork IPC channel
// (apps/backend/src/startupControl.ts). Readiness is accepted only from
// there: stderr carries logs, which anything the backend runs can write to.
const BACKEND_STARTUP_MESSAGE_TYPE = "betterc0de/backend-startup"
const BACKEND_STARTUP_PROTOCOL = 1

/** A startup frame from the backend's IPC channel, or null for anything else. */
function parseBackendStartupMessage(message) {
  if (
    !message ||
    typeof message !== "object" ||
    message.type !== BACKEND_STARTUP_MESSAGE_TYPE ||
    message.protocol !== BACKEND_STARTUP_PROTOCOL
  ) {
    return null
  }
  if (message.status === "starting") return { status: "starting" }
  if (
    message.status === "ready" &&
    Number.isInteger(message.port) &&
    message.port > 0 &&
    message.port <= 65_535 &&
    typeof message.token === "string" &&
    message.token.length >= 32 &&
    message.token.length <= 4_096
  ) {
    return { status: "ready", port: message.port, token: message.token }
  }
  if (message.status === "error") {
    return {
      status: "error",
      message:
        typeof message.message === "string" && message.message
          ? message.message.slice(0, 4_096)
          : "Node backend failed to start",
    }
  }
  return null
}

/**
 * Confirms the backend serves HTTP on the port its ready frame announced
 * (the same `/health` endpoint the supervisor's liveness checks use) before
 * renderers are pointed at it. Polls for up to ~3s (15 × 200ms) before
 * giving up and rejecting the startup promise.
 */
function verifyBackendHealth(port, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const http = require("http")
    const maxAttempts = appConfig.BACKEND_HEALTH_PROBE_MAX_ATTEMPTS
    const intervalMs = appConfig.BACKEND_HEALTH_PROBE_INTERVAL_MS
    let attempts = 0
    let settled = false
    let activeRequest = null
    let activeResponse = null
    let retryTimer = null
    const maxBodyBytes = 64 * 1024

    const finish = (error) => {
      if (settled) return
      settled = true
      if (retryTimer) clearTimeout(retryTimer)
      clearTimeout(overallTimer)
      signal?.removeEventListener("abort", onAbort)
      try { activeResponse?.destroy() } catch {}
      try { activeRequest?.destroy() } catch {}
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => {
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Backend health probe was aborted"),
      )
    }
    const scheduleRetry = (error) => {
      if (settled) return
      if (attempts >= maxAttempts) {
        finish(error)
        return
      }
      retryTimer = setTimeout(tryOnce, intervalMs)
      retryTimer.unref?.()
    }

    const tryOnce = () => {
      if (settled) return
      attempts++
      let attemptFinished = false
      const failAttempt = (error) => {
        if (attemptFinished || settled) return
        attemptFinished = true
        activeResponse = null
        activeRequest = null
        scheduleRetry(error)
      }
      const req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: "/health",
          timeout: appConfig.BACKEND_HEALTH_PROBE_REQUEST_TIMEOUT_MS,
        },
        (res) => {
          activeResponse = res
          let body = ""
          let bodyBytes = 0
          res.on("data", (chunk) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            bodyBytes += bytes.length
            if (bodyBytes > maxBodyBytes) {
              res.destroy(
                new Error(`/health response exceeds ${maxBodyBytes} bytes`),
              )
              return
            }
            body += bytes.toString("utf-8")
          })
          res.once("error", (error) => {
            failAttempt(error)
          })
          res.on("end", () => {
            if (attemptFinished) return
            attemptFinished = true
            activeResponse = null
            activeRequest = null
            if (settled || bodyBytes > maxBodyBytes) return
            let parsed = null
            try {
              parsed = JSON.parse(body)
            } catch {
              /* fall through — retry or fail */
            }
            if (res.statusCode === 200 && parsed && parsed.status === "ok") {
              finish()
              return
            }
            scheduleRetry(
              new Error(
                `/health probe rejected: status=${res.statusCode} body=${body.slice(0, 200)}`,
              ),
            )
          })
        },
      )
      activeRequest = req
      req.on("error", (err) => {
        failAttempt(
          new Error(
            `/health unreachable after ${attempts} attempts: ${
              err && err.message ? err.message : err
            }`,
            { cause: err },
          ),
        )
      })
      req.on("timeout", () => {
        req.destroy(new Error("/health request timed out"))
      })
    }

    const overallTimer = setTimeout(
      () =>
        finish(
          new Error(
            `/health probe exceeded ${BACKEND_STARTUP_TIMEOUT_MS}ms`,
          ),
        ),
      BACKEND_STARTUP_TIMEOUT_MS,
    )
    overallTimer.unref?.()
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    tryOnce()
  })
}

/**
 * One backend slot: at most one child process at a time, restarted in
 * place. See the module comment for `deps`.
 */
function createBackendProcess(deps) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (typeof deps?.[name] !== "function") {
      throw new TypeError(`createBackendProcess: ${name} must be a function`)
    }
  }
  const {
    app,
    session,
    emitBackendStatus,
    isQuitting,
    getSettingsEncryptionKey,
    resolveUserDataDir: resolveBetterC0deUserDataDir,
    resolveRuntimeHome: resolveBetterC0deRuntimeHome,
    resolveDevNodeExecPath,
    resolveClaudeCodeBinaryPath,
    resolveCliBinary,
    getRendererSecurityPolicy,
    isTrustedRendererRequest,
  } = deps
  const process = deps.process || globalThis.process
  const console = deps.console || globalThis.console
  // apps/shell (this file is in apps/shell/shared).
  const shellDir = deps.shellDir || path.join(__dirname, "..")
  const fork = deps.fork || childProcess.fork
  const spawn = deps.spawn || childProcess.spawn
  const readline = deps.readline || require("readline")
  const fs = deps.fs || require("fs")
  const buildBackendEnvironment =
    deps.buildBackendEnvironment ||
    require("./backend-environment.cjs").buildBackendEnvironment
  const createBackendStartupWatchdog =
    deps.createBackendStartupWatchdog ||
    require("./backend-startup-watchdog.cjs").createBackendStartupWatchdog
  const createBackendDevReloader =
    deps.createBackendDevReloader ||
    ((options) =>
      require("../backend-dev-reloader.cjs").createBackendDevReloader(options))
  const resolveDarwinChildPath =
    deps.resolveDarwinChildPath ||
    ((options) =>
      require("./login-shell-path.cjs").resolveDarwinChildPath(options))
  const checkBackendHealth = deps.verifyBackendHealth || verifyBackendHealth

  let nodeBackendHandle = null
  let serverPort = 0
  let serverToken = ""
  let backendDevReloader = null
  let backendRestartPromise = null
  let backendStopPromise = null
  // macOS: PATH from the user's login shell, resolved once (see
  // prepareBackendLaunchPath). Null elsewhere or until resolved.
  let backendLaunchPath = null
  let backendLaunchPathPromise = null
  let backendSupervisor = null

  function resetBackendRuntime() {
    serverPort = 0
    serverToken = ""
  }

  /**
   * Install (or replace) a `webRequest.onBeforeSendHeaders` listener that
   * transparently injects the backend Bearer token onto every renderer-
   * initiated HTTP / WebSocket request to the loopback backend port.
   *
   * Why: previously the token rode on `window.__BETTERC0DE__.token` so any
   * script in the renderer (LLM-rendered HTML, plugin UI, future XSS) could
   * read it and impersonate the user against the backend. Injecting at the
   * network layer means the renderer JS never sees the token at all — even
   * a compromised script can't exfiltrate what it can't observe.
   *
   * Filter URLs include the actual backend port; the listener cross-checks
   * the parsed URL inside the callback so a port-collision with another
   * loopback service can't trick us into attaching the bearer to that
   * service's traffic.
   */
  /**
   * Explain a refused bearer injection once per distinct cause. Deduped because
   * pollers (git status, provider instances) would otherwise flood the log.
   */
  const refusedBackendAuthReasons = new Set()
  function logRefusedBackendAuth(details) {
    const policy = getRendererSecurityPolicy()
    const contentsId = details?.webContentsId ?? details?.webContents?.id
    const frame = details?.frame
    const cause = !policy.trustedWebContentsIds.has(contentsId)
      ? "unregistered"
      : !frame ? "missing-frame" : frame.parent ? "subframe" : "untrusted-url"
    const reason = cause === "unregistered"
      ? `webContents ${contentsId} is not a registered app renderer`
      : !frame
        ? "Electron reported no frame for this request (details.frame is null)"
        : frame.parent
          ? "request came from a sub-frame, not the main frame"
          : `frame URL is not the trusted renderer origin (${String(frame.url || "unknown").slice(0, 1024)})`
    // URLs and webContents IDs can change indefinitely; dedupe by finite cause.
    const key = `${details?.resourceType}:${cause}`
    if (refusedBackendAuthReasons.has(key)) return
    refusedBackendAuthReasons.add(key)
    console.warn(
      `[electron] Backend request NOT authorized (resourceType=${details?.resourceType}): ${reason}. ` +
        `The renderer will see 403 "origin not allowed".`,
    )
  }

  function installBackendAuthInterceptor() {
    if (!serverPort || !serverToken) return
    const filter = {
      urls: [
        `http://127.0.0.1:${serverPort}/*`,
        `http://localhost:${serverPort}/*`,
        `ws://127.0.0.1:${serverPort}/*`,
        `ws://localhost:${serverPort}/*`,
      ],
    }
    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      // Defensive parse: `details.url` is always a fully-qualified URL string
      // here, but guarding against a future Electron change that loosens the
      // filter is cheap.
      let parsed
      try { parsed = new URL(details.url) } catch { parsed = null }
      const portMatches = parsed && Number(parsed.port) === serverPort
      const hostMatches = parsed && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      const trustedSource = isTrustedRendererRequest(
        details,
        getRendererSecurityPolicy(),
      )
      if (!portMatches || !hostMatches || !trustedSource) {
        // A request aimed AT our backend that we refused to authorize is the
        // single most confusing failure this app has: the renderer gets a bare
        // 403 "origin not allowed" with no CORS header, every poller retries
        // forever, and the UI just looks frozen. Say why, once per reason, so it
        // is diagnosable from the terminal instead of by inference.
        if (portMatches && hostMatches) {
          logRefusedBackendAuth(details)
        }
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Authorization: `Bearer ${serverToken}`,
        },
      })
    })
  }

  function getBackendEntryPath() {
    // After the apps/ + packages/ migration the shell lives at apps/shell/
    // and the backend at apps/backend/, so the relative path stays one
    // sibling step away — `..` lands in apps/, then into backend/dist/.
    return path.join(shellDir, "..", "backend", "dist", "index.js")
  }

  function stopProcessTree(child, signal) {
    if (hasChildExited(child) || !child.pid) {
      return Promise.resolve()
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // The process may already have exited.
        }
      }
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve()
      }
      let killer
      try {
        const windowsRoot =
          process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows"
        killer = spawn(
          path.join(windowsRoot, "System32", "taskkill.exe"),
          [
            "/pid",
            String(child.pid),
            "/T",
            ...(signal === "SIGKILL" ? ["/F"] : []),
          ],
          {
            cwd: windowsRoot,
            env: processControlEnvironment(),
            stdio: "ignore",
            windowsHide: true,
          },
        )
      } catch {
        try { child.kill(signal) } catch {}
        finish()
        return
      }
      timer = setTimeout(() => {
        try { killer.kill("SIGKILL") } catch {}
        try { child.kill(signal) } catch {}
        finish()
      }, 2_000)
      killer.once("error", () => {
        try { child.kill(signal) } catch {}
        finish()
      })
      killer.once("close", (code) => {
        if (code !== 0 && !hasChildExited(child)) {
          try { child.kill(signal) } catch {}
        }
        finish()
      })
    })
  }

  /**
   * Forced stop for a backend that ignored the graceful shutdown or stopped
   * responding. On POSIX the backend's provider CLIs, shells and formatters run
   * in their own process groups, so they are snapshotted while the backend is
   * still alive (afterwards they are re-parented and unreachable) and killed
   * along with it. On Windows `taskkill /T /F` walks the tree itself.
   */
  async function forceKillBackendTree(child) {
    if (hasChildExited(child) || !child.pid) return
    if (process.platform === "win32") {
      await stopProcessTree(child, "SIGKILL")
      return
    }
    const processTree = require("./process-tree.cjs")
    const descendants = await processTree.listDescendantProcesses(child.pid, {
      timeoutMs: appConfig.BACKEND_PROCESS_TREE_SNAPSHOT_TIMEOUT_MS,
    })
    await stopProcessTree(child, "SIGKILL")
    const groups = processTree.killProcesses(descendants)
    if (descendants.length > 0) {
      console.warn(
        `[electron] Killed ${descendants.length} backend child process(es) in ${groups} process group(s)`,
      )
    }
  }

  function processControlEnvironment() {
    const allowed = [
      "PATH",
      "PATHEXT",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "TEMP",
      "TMP",
    ]
    return Object.fromEntries(
      allowed.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    )
  }

  function stopSpawnedBackend(handle) {
    if (!handle.stopPromise) {
      const attempt = stopSpawnedBackendOnce(handle)
      const tracked = attempt.finally(() => {
        if (handle.stopPromise === tracked) handle.stopPromise = null
      })
      handle.stopPromise = tracked
    }
    return handle.stopPromise
  }

  async function stopSpawnedBackendOnce(handle) {
    const child = handle.child
    handle.stopRequested = true
    if (hasChildExited(child)) {
      closeBackendReaders(handle)
      return
    }

    await new Promise((resolve, reject) => {
      let settled = false
      let forceExitTimer = null
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(ipcTimer)
        clearTimeout(sigkillTimer)
        if (forceExitTimer) clearTimeout(forceExitTimer)
        child.removeListener("exit", finish)
        child.removeListener("close", finish)
        closeBackendReaders(handle)
        resolve()
      }

      child.once("exit", finish)
      child.once("close", finish)

      // Prefer graceful IPC shutdown — Windows has no real SIGTERM, so sending
      // it kills the child before `db.close()` runs and leaves SQLite's WAL
      // un-checkpointed. `child.send()` delivers a structured message that the
      // backend's `process.on("message")` handler turns into a clean stop.
      let ipcDelivered = false
      try {
        if (typeof child.send === "function" && child.connected) {
          child.send({ type: "shutdown" }, (err) => {
            if (!err) ipcDelivered = true
          })
        }
      } catch {
        /* fall through to signal path */
      }

      // If IPC delivery is not confirmed, send SIGTERM (graceful on
      // POSIX, effectively SIGKILL on Windows — still a last-resort fallback).
      const ipcTimer = setTimeout(() => {
        if (!ipcDelivered) {
          void stopProcessTree(child, BACKEND_STOP_SIGNALS[0])
        }
      }, appConfig.BACKEND_IPC_SHUTDOWN_ACK_MS)

      // Absolute fallback: SIGKILL after the full timeout window, including the
      // backend's own children so none outlive the app.
      const sigkillTimer = setTimeout(() => {
        void forceKillBackendTree(child)
          .then(() => {
            if (hasChildExited(child) || settled) return
            forceExitTimer = setTimeout(() => {
              if (settled) return
              settled = true
              child.removeListener("exit", finish)
              child.removeListener("close", finish)
              reject(
                new Error(
                  `Node backend survived forced shutdown (pid=${child.pid ?? "unknown"})`,
                ),
              )
            }, BACKEND_FORCE_KILL_EXIT_TIMEOUT_MS)
            if (settled) {
              clearTimeout(forceExitTimer)
              forceExitTimer = null
            }
          })
          .catch((err) => {
            if (settled) return
            settled = true
            child.removeListener("exit", finish)
            child.removeListener("close", finish)
            reject(err)
          })
      }, BACKEND_SHUTDOWN_TIMEOUT_MS)
    })
  }

  /** The started backend exited without being asked to. */
  function handleBackendExit(reason) {
    resetBackendRuntime()
    nodeBackendHandle = null
    if (isQuitting()) return
    console.error(`[electron] ${reason}`)
    // The supervisor reports `restarting` (with backoff) or, in a crash loop,
    // `failed` with a manual restart offered in the window.
    getBackendSupervisor().onUnexpectedExit(reason)
  }

  function getBackendSupervisor() {
    backendSupervisor ??= require("./backend-supervisor.cjs").createBackendSupervisor({
      restart: (reason) => restartBackend(reason),
      emitStatus: emitBackendStatus,
      probe: () => serverPort
        ? require("./backend-supervisor.cjs").probeBackendHealth(serverPort, {
            timeoutMs: appConfig.BACKEND_LIVENESS_TIMEOUT_MS,
          })
        : Promise.resolve(false),
      terminate: async (reason) => {
        const child = nodeBackendHandle?.child
        if (!child || hasChildExited(child)) return
        console.error(`[electron] Terminating the backend: ${reason}`)
        await forceKillBackendTree(child)
      },
      isQuitting: () => isQuitting(),
      isBusy: () => Boolean(backendRestartPromise || backendStopPromise),
      maxCrashes: appConfig.BACKEND_CRASH_LOOP_MAX_CRASHES,
      crashWindowMs: appConfig.BACKEND_CRASH_LOOP_WINDOW_MS,
      baseDelayMs: appConfig.BACKEND_RESTART_BASE_DELAY_MS,
      maxDelayMs: appConfig.BACKEND_RESTART_MAX_DELAY_MS,
      livenessIntervalMs: appConfig.BACKEND_LIVENESS_INTERVAL_MS,
      livenessMaxMisses: appConfig.BACKEND_LIVENESS_MAX_MISSES,
      resumeGraceMs: appConfig.BACKEND_LIVENESS_RESUME_GRACE_MS,
    })
    return backendSupervisor
  }

  async function startSpawnedBackend() {
    const backendEntry = getBackendEntryPath()
    try {
      fs.accessSync(backendEntry)
    } catch (err) {
      // shared/startup-failure.cjs turns this into install- or build-specific
      // advice for the dialog.
      const message = `Could not load the backend at ${backendEntry}.`
      console.error(`[electron] ${message}`, err)
      emitBackendStatus("failed", { reason: message })
      throw new Error(message)
    }

    const devNodeExecPath = resolveDevNodeExecPath()
    console.log(
      devNodeExecPath
        ? `[electron] Starting Node backend as child process via ${devNodeExecPath}`
        : "[electron] Starting Node backend as child process",
    )

    // `cwd` MUST be a real on-disk directory. In a packaged build,
    // `__dirname` lives inside `app.asar` (a virtual archive, not a real
    // filesystem), so `path.join(__dirname, "..")` resolves to the asar
    // mount point itself — Windows `CreateProcess` then fails with ENOENT
    // and reports the executable path (`BetterC0de.exe`, since Electron's
    // `fork()` defaults to `process.execPath`), surfacing to the user as
    // "Failed to start backend: spawn …\BetterC0de.exe ENOENT".
    // `resolveBetterC0deUserDataDir()` ensures the dir exists (mkdir-p)
    // before we hand it to fork, so cwd is always valid.
    const userDataDir = resolveBetterC0deUserDataDir()
    // Resolve the Claude Code native binary path here in the main process (where
    // `process.resourcesPath` is reliable) and forward it to the backend via env
    // var. The SDK's own `require.resolve` returns a path inside `app.asar` —
    // valid for `fs.statSync`, but `child_process.spawn` bypasses asar mapping
    // and the OS fails ENOENT trying to exec a binary out of a virtual archive.
    const claudeCodeBinaryPath = resolveClaudeCodeBinaryPath()
    const codexCliBinaryPath =
      process.platform === "darwin" && !process.env.BETTERC0DE_CODEX_CLI_PATH
        ? resolveCliBinary("codex")
        : null
    // The environment is built explicitly (shared/backend-environment.cjs):
    // loader/runtime injection such as NODE_OPTIONS is dropped, and the
    // settings master key is never part of it — it follows over the IPC channel
    // below. Without a dev Node binary the sidecar is the app binary running
    // as Node (ELECTRON_RUN_AS_NODE), which keeps the RunAsNode fuse required.
    const child = fork(backendEntry, [], {
      ...(devNodeExecPath ? { execPath: devNodeExecPath, execArgv: [] } : {}),
      cwd: userDataDir,
      env: buildBackendEnvironment(process.env, {
        runAsNode: !devNodeExecPath,
        overrides: {
          BETTERC0DE_DATA_DIR: userDataDir,
          // The desktop configuration folder (shared/runtime-paths.cjs). The
          // backend owns its files and must not guess it from the data dir.
          BETTERC0DE_RUNTIME_HOME: resolveBetterC0deRuntimeHome(),
          BETTERC0DE_WEB_ROOT: path.join(app.getAppPath(), "apps", "ui", "dist"),
          // The backend waits for the `settings-key` IPC message before it
          // reads settings.
          BETTERC0DE_SETTINGS_KEY_VIA_IPC: "1",
          // Startup heartbeats, readiness (with the bearer) and startup errors
          // come back over the IPC channel, never on stderr.
          BETTERC0DE_STARTUP_CONTROL: "ipc",
          ...(claudeCodeBinaryPath ? { BETTERC0DE_CLAUDE_CODE_PATH: claudeCodeBinaryPath } : {}),
          ...(codexCliBinaryPath ? { BETTERC0DE_CODEX_CLI_PATH: codexCliBinaryPath } : {}),
          // macOS: the login shell's PATH, so Homebrew/nvm/volta tools resolve
          // for Finder-launched apps. The backend uses the second variable as
          // the base PATH for the shells and tools it starts.
          ...(backendLaunchPath
            ? { PATH: backendLaunchPath, BETTERC0DE_LOGIN_SHELL_PATH: backendLaunchPath }
            : {}),
        },
      }),
      silent: true,
      detached: process.platform !== "win32",
    })

    const stdoutReader = readline.createInterface({ input: child.stdout })
    const stderrReader = readline.createInterface({ input: child.stderr })
    const handle = {
      mode: "spawn",
      child,
      stdoutReader,
      stderrReader,
      stopRequested: false,
      stopPromise: null,
      stop: () => stopSpawnedBackend(handle),
    }
    nodeBackendHandle = handle

    stdoutReader.on("line", (line) => {
      if (line) console.log(`[backend] ${line}`)
    })
    // The backend's recent stderr, for the start-up error dialog: an installed
    // app has no visible console, and a crash while loading modules explains
    // itself only there. Attached by reference, so lines that arrive after the
    // exit event are still shown.
    const stderrTail = []

    return await new Promise((resolve, reject) => {
      let settled = false
      let verifyingReadiness = false
      let startupWatchdog = null
      const healthAbort = new AbortController()

      const rejectStart = (err) => {
        if (settled) return
        settled = true
        startupWatchdog?.stop()
        const failure = err instanceof Error ? err : new Error(String(err))
        if (!Array.isArray(failure.backendStderr)) failure.backendStderr = stderrTail
        healthAbort.abort(failure)
        void stopSpawnedBackend(handle).then(
          () => {
            if (nodeBackendHandle === handle) nodeBackendHandle = null
            reject(failure)
          },
          (stopError) => {
            reject(
              new AggregateError(
                [failure, stopError],
                "Backend startup failed and its process did not stop cleanly",
              ),
            )
          },
        )
      }
      startupWatchdog = createBackendStartupWatchdog({
        idleTimeoutMs: BACKEND_STARTUP_TIMEOUT_MS,
        initialTimeoutMs: appConfig.BACKEND_STARTUP_INITIAL_TIMEOUT_MS,
        hardTimeoutMs: BACKEND_STARTUP_HARD_TIMEOUT_MS,
        onTimeout: ({ kind, timeoutMs }) =>
          rejectStart(
            new Error(
              kind === "initial"
                ? `Node backend did not send its first startup heartbeat within ${timeoutMs}ms (process launch or module loading)`
                : kind === "idle"
                ? `Node backend did not send a startup heartbeat within ${timeoutMs}ms`
                : `Node backend did not become ready within the ${timeoutMs}ms hard startup limit`,
            ),
          ),
      })

      child.once("error", rejectStart)

      child.once("exit", (code, signal) => {
        const reason = `Node backend exited (code=${code ?? "null"} signal=${signal ?? "none"})`
        if (!settled) {
          rejectStart(new Error(reason))
          return
        }
        if (nodeBackendHandle === handle) {
          if (handle.stopRequested) {
            resetBackendRuntime()
            nodeBackendHandle = null
          } else {
            handleBackendExit(reason)
          }
        }
        closeBackendReaders(handle)
      })

      // Startup frames arrive over the private fork IPC channel only
      // (parseBackendStartupMessage). The channel also delivers nothing else
      // to this process, so every other message is ignored.
      child.on("message", async (raw) => {
        const control = parseBackendStartupMessage(raw)
        if (!control) return

        if (control.status === "starting") {
          if (!settled && !verifyingReadiness) startupWatchdog?.pulse()
          return
        }

        if (control.status === "ready") {
          if (settled || verifyingReadiness) return
          verifyingReadiness = true
          // The ready frame ends the liveness-heartbeat phase. From here the
          // independently bounded health probe owns timeout reporting.
          startupWatchdog?.stop()
          const reportedPort = control.port
          const reportedToken = control.token
          // Confirm the advertised port answers before any window uses it.
          try {
            await checkBackendHealth(reportedPort, {
              signal: healthAbort.signal,
            })
          } catch (err) {
            rejectStart(
              err instanceof Error
                ? err
                : new Error(`Backend health probe failed: ${String(err)}`),
            )
            return
          }
          // The startup timeout or child-exit path may have won while the
          // asynchronous health probe was in flight. Never resurrect that
          // failed handle with a late successful probe.
          if (settled || hasChildExited(child) || nodeBackendHandle !== handle) {
            return
          }
          settled = true
          startupWatchdog?.stop()
          serverPort = reportedPort
          serverToken = reportedToken
          installBackendAuthInterceptor()
          console.log(`[electron] Node backend ready on port ${serverPort}`)
          emitBackendStatus("ready", { port: serverPort })
          resolve({ port: serverPort, token: serverToken })
          return
        }

        if (control.status === "error" && !settled) {
          emitBackendStatus("failed", { reason: control.message })
          rejectStart(new Error(control.message))
        }
      })

      stderrReader.on("line", (line) => {
        if (!line) return
        stderrTail.push(line)
        if (stderrTail.length > 50) stderrTail.shift()
        console.error(`[backend] ${line}`)
      })

      // Hand the settings master key over the private fork IPC channel. In the
      // environment it would stay readable for the process lifetime through
      // /proc/<pid>/environ or `ps eww` by any same-user process, including the
      // shells and agents the backend runs. An empty key means OS credential
      // storage is unavailable and the backend keeps plaintext settings.
      // A delivery failure means the child is already going away; its exit (or
      // the backend's own "no settings key" startup error) reports the cause.
      const reportKeyDeliveryFailure = (error) => {
        console.error(
          "[electron] Could not hand the settings key to the backend:",
          error instanceof Error ? error.message : String(error),
        )
      }
      try {
        child.send({ type: "settings-key", key: getSettingsEncryptionKey() }, (error) => {
          if (error) reportKeyDeliveryFailure(error)
        })
      } catch (error) {
        reportKeyDeliveryFailure(error)
      }
    })
  }

  /**
   * The backend always runs as a supervised child process. (The former
   * in-process mode, `BETTERC0DE_BACKEND=in-process`, ran SQLite and node-pty
   * on the UI thread, duplicated this lifecycle and put the settings key into
   * Electron's own environment; no build or test used it.)
   */
  async function startBackend() {
    try {
      await prepareBackendLaunchPath()
      const started = await startSpawnedBackend()
      getBackendSupervisor().onBackendReady()
      return started
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      console.error(`[electron] Node backend init failed: ${message}`)
      emitBackendStatus("failed", { reason: message })
      throw err
    }
  }

  /**
   * macOS apps started from Finder or the Dock get launchd's minimal PATH.
   * Resolve the login shell's PATH once (bounded, cached), use it for the
   * backend and for this process's own tool lookups. A failure falls back to
   * the current PATH plus the usual Homebrew locations.
   */
  function prepareBackendLaunchPath() {
    if (process.platform !== "darwin" || process.env.BETTERC0DE_SKIP_LOGIN_SHELL_PATH === "1") {
      return Promise.resolve(null)
    }
    backendLaunchPathPromise ??= resolveDarwinChildPath({ env: process.env })
      .then(({ path: resolvedPath, fromLoginShell }) => {
        if (!fromLoginShell) {
          console.warn("[electron] Could not read PATH from the login shell; using common tool locations")
        }
        backendLaunchPath = resolvedPath || null
        if (backendLaunchPath) process.env.PATH = backendLaunchPath
        return backendLaunchPath
      })
      .catch((error) => {
        console.warn("[electron] Login shell PATH resolution failed:", error?.message || error)
        return null
      })
    return backendLaunchPathPromise
  }

  function stopBackend() {
    if (backendStopPromise) return backendStopPromise
    if (!nodeBackendHandle) return Promise.resolve()
    const handle = nodeBackendHandle
    handle.stopRequested = true

    const attempt = (async () => {
      console.log("[electron] Stopping Node backend...")
      try {
        await handle.stop()
        if (!hasChildExited(handle.child)) {
          throw new Error("Backend stop returned before the child process exited")
        }
        if (nodeBackendHandle === handle) nodeBackendHandle = null
        resetBackendRuntime()
        console.log("[electron] Node backend stopped cleanly")
      } catch (err) {
        console.error("[electron] Error stopping Node backend:", err)
        throw err
      }
    })()
    const tracked = attempt.finally(() => {
      if (backendStopPromise === tracked) backendStopPromise = null
    })
    backendStopPromise = tracked
    return tracked
  }

  async function restartBackend(reason = "requested") {
    if (isQuitting()) throw new Error("BetterC0de is shutting down")
    if (backendRestartPromise) return backendRestartPromise

    backendRestartPromise = (async () => {
      console.log(`[electron] Restarting backend (${reason})...`)
      emitBackendStatus("restarting", { reason })
      await stopBackend()
      if (isQuitting()) throw new Error("BetterC0de is shutting down")
      if (nodeBackendHandle) {
        throw new Error("Cannot restart while the previous backend is still running")
      }
      // The `ready` status broadcast carries the new port to every window.
      return await startBackend()
    })()
    try {
      return await backendRestartPromise
    } finally {
      backendRestartPromise = null
    }
  }

  async function reloadBackendForDevelopment() {
    return restartBackend("development build changed")
  }

  function startBackendDevReloader() {
    if (
      app.isPackaged ||
      process.env.BETTERC0DE_BACKEND_WATCH !== "1" ||
      backendDevReloader
    ) {
      return
    }

    // The backend requires @betterc0de/schema from its compiled output
    // (`schema:dev` keeps it current), so a schema change needs a restart too.
    const directories = [
      path.join(shellDir, "..", "backend", "dist"),
      path.join(shellDir, "..", "..", "packages", "schema", "dist"),
    ]
    backendDevReloader = createBackendDevReloader({
      directories,
      onReload: reloadBackendForDevelopment,
    })
    console.log(`[dev] Watching backend build output at ${directories.join(", ")}`)
  }

  function stopBackendDevReloader() {
    backendDevReloader?.close()
    backendDevReloader = null
  }

  return {
    startBackend,
    stopBackend,
    restartBackend,
    prepareBackendLaunchPath,
    startBackendDevReloader,
    stopBackendDevReloader,
    getBackendSupervisor,
    /** The supervisor if one exists, without creating it. */
    peekBackendSupervisor: () => backendSupervisor,
    /** Port and bearer of the ready backend, or null. */
    getConnection: () =>
      serverPort && serverToken ? { port: serverPort, token: serverToken } : null,
    getServerPort: () => serverPort,
    /** A restart in progress; the shutdown sequence lets it settle first. */
    getPendingRestart: () => backendRestartPromise,
    /** One launch, without the supervisor and the login-shell PATH (tests). */
    startSpawnedBackend,
  }
}

module.exports = {
  BACKEND_STARTUP_MESSAGE_TYPE,
  BACKEND_STARTUP_PROTOCOL,
  createBackendProcess,
  closeBackendReaders,
  hasChildExited,
  parseBackendStartupMessage,
  verifyBackendHealth,
}
