const { app, BrowserWindow, crashReporter, dialog, protocol, session, shell } = require("electron")
const path = require("path")
let appDiagnostics = null
let privacyPreferences = null

/**
 * Telemetry consent from Settings → General → Privacy (`settings.json`).
 * Automatic crash reports and the usage ping are both off until the user
 * turns them on; BETTERC0DE_DISABLE_CRASH_REPORTS / BETTERC0DE_DISABLE_PING
 * stay hard opt-outs for CI and managed machines.
 */
function getPrivacyPreferences() {
  privacyPreferences ??= require("./shared/privacy-preferences.cjs").createPrivacyPreferences({
    getSettingsPath: () => path.join(resolveBetterC0deUserDataDir(), "settings.json"),
  })
  return privacyPreferences
}

/** `<data dir>/logs`, next to the backend's provider logs. */
function getApplicationLogsDir() {
  return path.join(resolveBetterC0deUserDataDir(), "logs")
}

function createApplicationLogFile() {
  try {
    // Persistent, size-capped log of main-process and backend output
    // (app.log + 2 older generations, 5 MB each). Lines arrive redacted.
    return require("./shared/rotating-log-file.cjs").createRotatingLogFile({
      directory: getApplicationLogsDir(),
      fileName: "app.log",
    })
  } catch {
    // Too early (data dir not resolvable yet) or an unusable profile: the
    // in-memory diagnostics still work.
    return null
  }
}

function getAppDiagnostics() {
  if (!appDiagnostics) {
    appDiagnostics = require("./shared/app-diagnostics.cjs").createAppDiagnostics({
      appVersion: app.getVersion(), os: process.platform, arch: process.arch,
      // Asked at report time, so turning the setting off applies immediately.
      automaticReports: () => getPrivacyPreferences().crashReportsEnabled(),
      // The installation ID is attached only while the user has opted in to
      // the usage ping, the one feature that needs a stable identifier.
      getInstallId: () => getPrivacyPreferences().usagePingEnabled()
        ? require("./shared/app-ping.cjs").readInstallId(require("./shared/runtime-paths.cjs").getBaseDir())
        : null,
      logSink: createApplicationLogFile(),
      getDeviceInfo: () => require("./shared/bug-report-device-info.cjs").collectBugReportDeviceInfo({ app }),
    })
  }
  return appDiagnostics
}

function reportAppCrash(error) {
  try { return getAppDiagnostics().reportError(error) } catch { return Promise.resolve() }
}

protocol.registerSchemesAsPrivileged([
  { scheme: "betterc0de-html", privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
let htmlPreviews = null
function getHtmlPreviews() {
  htmlPreviews ??= require("./html-preview.cjs").createHtmlPreviewRegistry()
  return htmlPreviews
}
const CANVAS_PREVIEW_PARTITION = "betterc0de-canvas-preview"

// Enforce single-instance before anything else — a second launch of
// BetterC0de.exe otherwise spawns a second process that fights the first
// over SQLite (WAL + shm lock contention), the `~/.betterc0de/userdata/`
// settings file, the backend port, and the plugin loader's require-cache.
// `requestSingleInstanceLock` returns false in the losing process; we quit
// it immediately and focus the primary window on `second-instance`.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
// Set when a launch arrives during shutdown; honoured just before the final quit.
let relaunchRequested = false
app.on("second-instance", () => {
  // A relaunch while the previous session is still shutting down (it holds
  // the lock for up to ~40 s) must not silently disappear.
  if (isAppQuitting || quitAfterShutdownScheduled) {
    relaunchRequested = true
    console.log("[electron] Launch requested during shutdown; relaunching once it completes")
    return
  }
  const mainWindow = getMainWindow()
  const target = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  if (target) {
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    return
  }
  // Before startup has created its window, that window is about to appear.
  if (app.isReady() && startupWindowCreated) recreateMainWindow("second instance")
})

// Certificate errors are silently rejected by Electron's default, which gives
// us zero telemetry on MITM attempts against the update feed or the loopback
// backend. Explicit listener logs the URL + error and calls callback(false)
// so the intent (fail-closed on bad certs) is visible in the source, not an
// implicit default that could change in a future Electron release.
app.on("certificate-error", (event, _webContents, url, error, _certificate, callback) => {
  console.error(`[electron] certificate-error for ${url}: ${error}`)
  event.preventDefault()
  callback(false)
})

// Start the native crash reporter BEFORE anything else so we capture
// Electron/Chromium crashes from the very first frame.  Dumps land in the
// per-user crashes folder alongside the userData directory — surfaced to
// users via `app.getPath("crashDumps")` if they ever need to send one in.
// No upload server is configured; crashes stay on the user's machine.
try {
  crashReporter.start({
    productName: "BetterC0de",
    companyName: "BetterC0de",
    submitURL: "",
    uploadToServer: false,
    ignoreSystemCrashHandler: false,
    compress: true,
  })
} catch (err) {
  console.error("[electron] crashReporter.start failed:", err && err.message)
}

let mainModuleReady = false
let fatalMainShutdownStarted = false

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  void reportAppCrash(err)
  console.error(
    "[electron] Unhandled promise rejection:",
    err.message,
    "\n",
    err.stack ?? "(no stack)",
  )
})

// A plugin's own timer or listener must not take the app down: when the
// error's stack points into a loaded plugin, plugin-ipc unloads and disables
// that plugin and the app keeps running. Consulted only once plugin-ipc has
// loaded; an error before that is an app error.
function containPluginFault(err) {
  try {
    const pluginIpc = require.cache[require.resolve("./plugin-ipc.cjs")]?.exports
    return pluginIpc?.handlePluginUncaughtException?.(err) === true
  } catch {
    return false
  }
}

process.on("uncaughtException", (err, origin) => {
  if (containPluginFault(err)) return
  void reportAppCrash(err)
  console.error(
    "[electron] Uncaught exception (" + origin + "):",
    err.message,
    "\n",
    err.stack ?? "(no stack)",
  )
  // The process may not get another event-loop turn; keep the log on disk.
  try { appDiagnostics?.flushLogs() } catch { /* best effort */ }
  process.exitCode = 1
  if (fatalMainShutdownStarted) return
  fatalMainShutdownStarted = true

  if (!mainModuleReady) {
    setImmediate(() => app.exit(1))
    return
  }

  // Long enough for the whole graceful sequence (CLI/plugins, backend with
  // its forced-kill escalation, crash-report flush) so it is not cut short.
  const forcedExit = setTimeout(() => {
    console.error("[electron] Fatal shutdown deadline exceeded; forcing exit")
    try { appDiagnostics?.flushLogs() } catch { /* best effort */ }
    app.exit(1)
  }, require("./shared/appConfig.cjs").FATAL_SHUTDOWN_DEADLINE_MS)
  requestApplicationQuit(`uncaught exception (${origin})`)
  app.once("will-quit", () => clearTimeout(forcedExit))
})

// Every IPC handler is sender-checked (shared/trusted-ipc.cjs). Modules use
// `registerHandler`; the guard installed here also wraps any direct
// `ipcMain.handle/handleOnce/on/once` call. It goes in before the IPC modules
// below are required, so a registration made at require time cannot bypass
// it, and a message that arrives before a sender policy is configured (further
// down) is refused.
const {
  PREVIEW_GUEST_SENDER_POLICY,
  configureIpcSenderPolicy,
  installIpcMainGuard,
  registerHandler,
} = require("./shared/trusted-ipc.cjs")
installIpcMainGuard()

const {
  registerPluginHandlers,
  startPlugins,
  setPluginWindow,
  setPluginEncryptionKey,
  disposePlugins,
} = require("./plugin-ipc.cjs")
const { registerOnboardingHandlers } = require("./onboarding-ipc.cjs")
const { registerCliPluginHandlers } = require("./cli-plugins-ipc.cjs")
const { registerMcpHandlers, setMcpEncryptionKey } = require("./mcp-ipc.cjs")
const { registerSkillsHandlers } = require("./skills-ipc.cjs")
const { registerHooksHandlers, isApprovedHookCommand } = require("./hooks-ipc.cjs")
const { setCommandApprovalKey } = require("./shared/command-approval.cjs")
const { registerSubagentsHandlers } = require("./subagents-ipc.cjs")
const { registerProviderHandlers } = require("./provider-ipc.cjs")
const {
  assertTrustedIpcSender,
  isTrustedRendererRequest,
} = require("./shared/urlPolicy.cjs")
const { buildRuntimeConfig } = require("./shared/runtimeConfig.cjs")
const { setBackendConnection } = require("./shared/backend-endpoint.cjs")
const { IpcEvent } = require("./shared/ipc-contract.cjs")
const { broadcast } = require("./shared/broadcast.cjs")
// Extracted main-process modules. Each exports factories that take their
// dependencies explicitly; nothing below runs at require time.
const { registerAppIpcHandlers } = require("./shared/app-ipc.cjs")
const { createAppWindows } = require("./shared/app-windows.cjs")
const { createUpdateChecker } = require("./shared/update-check.cjs")
const {
  areRendererDevToolsAllowed: areRendererDevToolsAllowedFor,
  createPreviewGuestSenderValidator,
  createWebContentsPolicy,
  denyAllPermissions,
  installDefaultSessionPermissionHandlers,
  isDevToolsShortcut,
} = require("./shared/web-contents-policy.cjs")
const { createWindowStateStore } = require("./shared/window-state.cjs")
const { describeStartupFailure, projectLinks } = require("./shared/startup-failure.cjs")
const { createPreviewRequestFeed } = require("./preview-request-capture.cjs")
const { createPreviewPartitionJanitor } = require("./shared/preview-partitions.cjs")
const {
  PREVIEW_GUEST_GATE_CHANNEL,
  createPreviewGuestGate,
  createUserInputTracker,
} = require("./shared/user-input-gate.cjs")
const appConfig = require("./shared/appConfig.cjs")
const {
  resolveClaudeCodeBinaryPath,
  resolveClaudeCodeBinaryPathAsync,
} = require("./shared/claude-binary-path.cjs")
const { createBackendDevReloader } = require("./backend-dev-reloader.cjs")
const {
  beginCliProcessShutdown,
  resumeCliProcessAdmissions,
  shutdownAllCliProcesses,
  resolveCliBinary,
} = require("./shared/spawn-cli.cjs")

// No `persist:` prefix: preview cookies/storage live only for this app
// process and are never shared with the trusted renderer's default session.
const PREVIEW_SESSION_PARTITION = "betterc0de-preview"

// The backend sidecar (spawn, handshake, supervision, stop, restart):
// shared/backend-process.cjs, created on first use by getBackendProcess().
let backendProcess = null
// Provider OAuth and workspace-trust checks read this live. A boot-time
// copy would go stale the first time the backend restarts on a new port.
setBackendConnection(() => backendProcess?.getConnection() ?? null)
let settingsEncryptionKey = ""
let isAppQuitting = false
let applicationShutdownPromise = null
let applicationShutdownComplete = false
let stopAppPing = () => {}
let quitAfterShutdownScheduled = false
const trustedRendererWebContentsIds = new Set()

function getRendererSecurityPolicy() {
  const vitePort = process.env.VITE_DEV_PORT || appConfig.VITE_DEV_PORT_FALLBACK
  return {
    isPackaged: app.isPackaged,
    devRendererOrigin: `http://localhost:${vitePort}`,
    packagedRendererRoot: path.join(app.getAppPath(), "apps", "ui", "dist"),
    trustedWebContentsIds: trustedRendererWebContentsIds,
  }
}

function registerTrustedRendererContents(contents) {
  trustedRendererWebContentsIds.add(contents.id)
  getAppDiagnostics().attachRenderer(contents)
  contents.once("destroyed", () => {
    trustedRendererWebContentsIds.delete(contents.id)
    htmlPreviews?.revokeOwner(contents.id)
  })
}

function resolveDevNodeExecPath() {
  if (app.isPackaged) return null

  const fs = require("fs")
  const candidates = [
    process.env.BETTERC0DE_DEV_NODE_EXEC_PATH,
    process.env.npm_node_execpath,
  ]

  for (const rawCandidate of candidates) {
    const candidate = typeof rawCandidate === "string" ? rawCandidate.trim() : ""
    if (!candidate) continue
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile()) return candidate
    } catch {
      /* try next candidate */
    }
  }

  return null
}

/**
 * The backend's data directory (SQLite + settings.json + settings-key.bin)
 * and the runtime home that holds the desktop configuration. Both come from
 * shared/runtime-paths.cjs, the shell's only resolver, and are passed to the
 * backend explicitly (`BETTERC0DE_DATA_DIR`, `BETTERC0DE_RUNTIME_HOME`).
 */
function resolveBetterC0deUserDataDir() {
  return require("./shared/runtime-paths.cjs").resolveUserDataDir()
}

function resolveBetterC0deRuntimeHome() {
  return require("./shared/runtime-paths.cjs").getBaseDir()
}

// ── Settings encryption key ──────────────────────────────────────────────
// The OS-protected key for provider secrets in settings.json (and the MCP
// store, plugin config and command approvals): shared/settings-key.cjs. A
// legacy installation's wrapped key is adopted first (shared/legacy-data.cjs)
// so migrated encrypted settings stay readable. Must be used after
// `app.whenReady()`.
let settingsKeyStore = null
function getSettingsKeyStore() {
  settingsKeyStore ??= require("./shared/settings-key.cjs").createSettingsKeyStore({
    resolveDataDir: resolveBetterC0deUserDataDir,
    adoptLegacyKey: (keyPath, safeStorage) =>
      require("./shared/legacy-data.cjs").adoptLegacySettingsKeyIfNeeded(
        keyPath,
        safeStorage,
        { home: app.getPath("home") },
      ),
  })
  return settingsKeyStore
}

function ensureSettingsEncryptionKey() {
  return getSettingsKeyStore().ensureSettingsEncryptionKey()
}

/** S4: whether provider API keys can be encrypted (surfaced by `app:info`). */
function getSecretsEncryptionAvailable() {
  return getSettingsKeyStore().getSecretsEncryptionAvailable()
}

// Who may call which IPC handler (see the guard installed near the top).
// Default: a registered BetterC0de window's main frame on the trusted
// renderer URL.
configureIpcSenderPolicy("trusted-renderer", (event, channel) =>
  assertTrustedIpcSender(event, channel, getRendererSecurityPolicy()),
)
// The app's preview preload inside a <webview> guest of a trusted window,
// in one of the two preview sessions. Only handlers registered for that
// preload accept it (shared/web-contents-policy.cjs).
let previewGuestSenderValidator = null
configureIpcSenderPolicy(PREVIEW_GUEST_SENDER_POLICY, (event, channel) => {
  previewGuestSenderValidator ??= createPreviewGuestSenderValidator({
    getPreviewSessions: () =>
      [PREVIEW_SESSION_PARTITION, CANVAS_PREVIEW_PARTITION].map(
        (partition) => session.fromPartition(partition),
      ),
    trustedWebContentsIds: trustedRendererWebContentsIds,
  })
  previewGuestSenderValidator(event, channel)
})

function emitBackendStatus(status, payload = {}) {
  // Broadcast to every BrowserWindow — the primary plus any secondary
  // window spawned via `WindowOpenWith`. Without this, secondary
  // windows missed the "ready" event and stayed stuck on the
  // backend-bootstrap splash forever.
  broadcast(IpcEvent.BackendStatus, { status, ...payload })
}

// ── Backend process ──────────────────────────────────────────────────────
// Created lazily: nothing from shared/backend-process.cjs runs while this
// module loads. Everything it needs from this process is passed in here.
function getBackendProcess() {
  backendProcess ??= require("./shared/backend-process.cjs").createBackendProcess({
    app,
    session,
    emitBackendStatus,
    isQuitting: () => isAppQuitting,
    getSettingsEncryptionKey: () => settingsEncryptionKey,
    resolveUserDataDir: resolveBetterC0deUserDataDir,
    resolveRuntimeHome: resolveBetterC0deRuntimeHome,
    resolveDevNodeExecPath,
    resolveClaudeCodeBinaryPath,
    resolveCliBinary,
    getRendererSecurityPolicy,
    isTrustedRendererRequest,
    createBackendDevReloader,
  })
  return backendProcess
}

function getBackendSupervisor() {
  return getBackendProcess().getBackendSupervisor()
}

function restartBackend(reason) {
  return getBackendProcess().restartBackend(reason)
}

/**
 * Served to the renderer through `runtime:config` (preload
 * `getRuntimeConfig`). Port changes after a restart reach already-loaded
 * windows through the `ready` backend-status event, so nothing is injected
 * into page JavaScript.
 */
function getRuntimeConfig() {
  return buildRuntimeConfig({
    port: backendProcess?.getServerPort() ?? 0,
    electronPath: path.join(__dirname).replace(/\\/g, "/"),
    previewPartition: PREVIEW_SESSION_PARTITION,
  })
}

function shutdownApplication(reason) {
  if (applicationShutdownPromise) return applicationShutdownPromise
  isAppQuitting = true
  backendProcess?.peekBackendSupervisor()?.dispose()
  updateChecker?.stopUpdateChecks()
  beginCliProcessShutdown()
  backendProcess?.stopBackendDevReloader()

  applicationShutdownPromise = (async () => {
    const failures = []
    const runStep = async (label, operation) => {
      try {
        await operation()
      } catch (err) {
        failures.push(err)
        console.error(`[electron] ${label} shutdown failed:`, err)
      }
    }

    console.log(`[electron] Shutting down (${reason})...`)
    // Independent of each other and of the backend: run them side by side so
    // their budgets do not add up ahead of the backend's.
    await Promise.all([
      runStep("CLI process", shutdownAllCliProcesses),
      runStep("Plugin", disposePlugins),
    ])

    // A development restart may already be between its stop and start phases.
    // Let it observe `isAppQuitting`, then stop whichever handle remains.
    const pendingRestart = backendProcess?.getPendingRestart()
    if (pendingRestart) {
      try {
        await pendingRestart
      } catch {
        // Expected when restartBackend observes the shutdown gate.
      }
    }
    await runStep("Backend", () => backendProcess?.stopBackend())
    await runStep("Crash report", () => appDiagnostics?.flush())
    // dispose() also writes the remaining log lines synchronously.
    appDiagnostics?.dispose()

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more application shutdown steps failed",
      )
    }
  })()
  return applicationShutdownPromise
}

function requestApplicationQuit(reason) {
  stopAppPing()
  if (applicationShutdownComplete) {
    app.quit()
    return
  }
  if (quitAfterShutdownScheduled) return
  quitAfterShutdownScheduled = true
  void shutdownApplication(reason)
    .catch((err) => {
      console.error("[electron] Application shutdown completed with errors:", err)
      process.exitCode = 1
    })
    .finally(() => {
      applicationShutdownComplete = true
      console.log("[electron] Application resources stopped; quitting")
      if (relaunchRequested) {
        // Someone launched the app while it was shutting down.
        try { app.relaunch() } catch (err) {
          console.error("[electron] Relaunch failed:", err)
        }
      }
      app.quit()
    })
}

// ── Windows ──────────────────────────────────────────────────────────────
// Window bounds persistence: shared/window-state.cjs. Main and secondary
// window creation, crash/hang recovery and Windows session end:
// shared/app-windows.cjs, which also holds the current main window.
let appWindows = null
function getAppWindows() {
  appWindows ??= createAppWindows({
    windowState: createWindowStateStore({
      resolveDataDir: resolveBetterC0deUserDataDir,
    }),
    registerTrustedRendererContents,
    attachWebviewPolicy: (contents) =>
      getWebContentsPolicy().attachWebviewPolicy(contents),
    getRendererSecurityPolicy,
    areRendererDevToolsAllowed,
    isDevToolsShortcut,
    isQuitting: () => isAppQuitting,
    requestApplicationQuit,
    flushLogs: () => appDiagnostics?.flushLogs(),
  })
  return appWindows
}

/** The primary window, or null before startup created it / after it closed. */
function getMainWindow() {
  return appWindows?.getMainWindow() ?? null
}

function createWindow() {
  getAppWindows().createWindow()
}

// ── Renderer DevTools ────────────────────────────────────────────────────
// Development runs always allow them; a packaged build only when started
// with BETTERC0DE_ENABLE_DEVTOOLS=1 (shared/web-contents-policy.cjs).
function areRendererDevToolsAllowed() {
  return areRendererDevToolsAllowedFor({ isPackaged: app.isPackaged, env: process.env })
}

// ── User intent observed by the main process ─────────────────────────────
// Real keyboard, mouse and touch input to app windows and preview guests, as
// Chromium reports it to this process; renderer or page script cannot fake
// it. Shell capabilities and preview element selections are granted only
// shortly after such input (or, for capabilities, for approved hooks).
let userInputTracker = null
function getUserInputTracker() {
  userInputTracker ??= createUserInputTracker()
  return userInputTracker
}

let previewGuestGate = null
function getPreviewGuestGate() {
  previewGuestGate ??= createPreviewGuestGate({ inputTracker: getUserInputTracker() })
  return previewGuestGate
}

// ── Preview request feed and partitions ──────────────────────────────────
let previewRequestFeed = null
function getPreviewRequestFeed() {
  previewRequestFeed ??= createPreviewRequestFeed({
    // A guest's requests go only to the app window hosting it.
    resolveOwner: (guestId) => {
      const { webContents } = require("electron")
      const guest = typeof guestId === "number" ? webContents.fromId(guestId) : null
      const host = guest && !guest.isDestroyed() ? guest.hostWebContents : null
      return host && trustedRendererWebContentsIds.has(host.id) ? host : null
    },
    send: (contents, entries) => contents.send(IpcEvent.PreviewRequest, entries),
  })
  return previewRequestFeed
}

let previewPartitionJanitor = null
function getPreviewPartitionJanitor() {
  previewPartitionJanitor ??= createPreviewPartitionJanitor({
    partitions: new Map(
      [PREVIEW_SESSION_PARTITION, CANVAS_PREVIEW_PARTITION].map((partition) => [
        partition,
        session.fromPartition(partition),
      ]),
    ),
  })
  return previewPartitionJanitor
}

// ── Global webContents hardening and the webview attach policy ───────────
// shared/web-contents-policy.cjs: popups denied, preview guests confined to
// what a preview can show, packaged DevTools closed, and every <webview>
// forced into a sandboxed preview session with only the app's own preload.
let webContentsPolicy = null
function getWebContentsPolicy() {
  webContentsPolicy ??= createWebContentsPolicy({
    previewPartition: PREVIEW_SESSION_PARTITION,
    canvasPartition: CANVAS_PREVIEW_PARTITION,
    getUserInputTracker,
    getPreviewPartitionJanitor,
    getPreviewGuestGate,
    areRendererDevToolsAllowed,
  })
  return webContentsPolicy
}

app.on("web-contents-created", (_event, contents) => {
  try {
    getWebContentsPolicy().hardenWebContents(contents)
  } catch (error) {
    console.error("[electron] Could not apply the webContents policy:", error)
  }
})

/** A launch or Dock click found no window while the app keeps running. */
function recreateMainWindow(reason) {
  if (isAppQuitting) return
  console.log(`[electron] Opening a new main window (${reason})`)
  createWindow()
  setPluginWindow(getMainWindow())
}

// ── App-level IPC handlers ───────────────────────────────────────────────
// Window controls, app info, runtime config, dialogs, external links and
// paths, clipboard, the preview request feed, shell capabilities and
// renderer client instances: shared/app-ipc.cjs. Registered at load, like
// before; every registration goes through the sender-checked guard.
registerAppIpcHandlers({
  getMainWindow,
  openSecondaryWindow: (options) => getAppWindows().openSecondaryWindow(options),
  areRendererDevToolsAllowed,
  getSecretsEncryptionAvailable,
  getApplicationLogsDir,
  getUpdatesDisabledReason: () => getUpdateChecker().getUpdatesDisabledReason(),
  getUpdateStatus: () => getUpdateChecker().getUpdateStatus(),
  getRuntimeConfig,
  getAppDiagnostics,
  getBackendSupervisor,
  restartBackend,
  getHtmlPreviews,
  getPreviewRequestFeed,
  getUserInputTracker,
  isApprovedHookCommand,
  isQuitting: () => isAppQuitting,
})

// ── Updates ──────────────────────────────────────────────────────────────
// Update mode (auto / notify-only / disabled) and release-feed checks:
// shared/update-check.cjs.
let updateChecker = null
function getUpdateChecker() {
  updateChecker ??= createUpdateChecker({
    app,
    dialog,
    shell,
    getParentWindow: getMainWindow,
    isQuitting: () => isAppQuitting,
  })
  return updateChecker
}

// Set once startup has created the first main window; before that, launch
// and Dock events must not open a second one.
let startupWindowCreated = false

app.whenReady().then(async () => {
  try {
    getAppDiagnostics()
    // Decided before any window exists, so `app:info` is right from the start.
    getUpdateChecker().initUpdatePolicy()
    // macOS: ask the login shell for PATH while the rest of startup runs.
    void getBackendProcess().prepareBackendLaunchPath()
    resumeCliProcessAdmissions()
    // Voice input needs audio from a registered app main frame; preview
    // sessions get no permission at all (shared/web-contents-policy.cjs).
    installDefaultSessionPermissionHandlers(session.defaultSession, getRendererSecurityPolicy)
    for (const partition of [PREVIEW_SESSION_PARTITION, CANVAS_PREVIEW_PARTITION]) {
      const previewSession = session.fromPartition(partition)
      denyAllPermissions(previewSession)
      previewSession.protocol.handle("betterc0de-html", (request) => getHtmlPreviews().handle(request))
      // Observed only while a window's runtime pane subscribes.
      getPreviewRequestFeed().attachSession(previewSession)
    }
    // The preview preload asks before forwarding an element selection.
    registerHandler(
      PREVIEW_GUEST_GATE_CHANNEL,
      (event, channel) => getPreviewGuestGate().allow(event.sender, channel),
      { sender: PREVIEW_GUEST_SENDER_POLICY },
    )
    // A few file checks; started now so the backend launch below usually
    // finds the Claude Code binary already resolved.
    void resolveClaudeCodeBinaryPathAsync().catch(() => {})

    // The window is created first, BEFORE the settings key and the backend,
    // so the renderer process starts and parses its multi-megabyte bundle
    // while this process unwraps the key (an OS keychain round trip) and the
    // backend boots. The renderer is built for this: it asks for its runtime
    // config over IPC and waits for the `ready` backend status (which
    // carries the port) before loading threads or opening the WebSocket.
    createWindow()
    startupWindowCreated = true

    // Everything from here to the first `await` runs in the same task as
    // createWindow(), so no renderer IPC message is handled before the key is
    // installed and every handler is registered.
    //
    // Before startBackend(): the key is handed to the backend over its IPC
    // channel at launch (without it the backend boots in plaintext-fallback
    // mode), and the MCP store and plugin config encrypt with it.
    settingsEncryptionKey = ensureSettingsEncryptionKey()
    setPluginEncryptionKey(settingsEncryptionKey)
    setMcpEncryptionKey(settingsEncryptionKey)
    // Hook and MCP command approvals are MACs under a key derived from the
    // same secret.
    setCommandApprovalKey(settingsEncryptionKey)

    // Registration only: no plugin code runs and nothing is loaded here.
    // Plugins are installed, loaded and wired below, next to the backend.
    registerPluginHandlers()
    registerOnboardingHandlers()
    // Previously one monolith — now each concern registers its own subset
    // of IpcChannel.* handlers. Order doesn't matter (each module's
    // `registered` flag is idempotent); consistent registration prevents
    // dropping a handler when adding new features.
    registerMcpHandlers()
    registerCliPluginHandlers()
    registerSkillsHandlers()
    registerHooksHandlers()
    registerSubagentsHandlers()
    registerProviderHandlers()

    // Plugin install/scan/require and event setup run alongside the backend
    // start instead of delaying the first window; handlers that need loaded
    // plugins wait for it. Never rejects.
    void startPlugins()
    await getBackendProcess().startBackend()
    getBackendProcess().startBackendDevReloader()

    setPluginWindow(getMainWindow())
    watchSystemPowerEvents()

    // Kick off the update check AFTER the window is shown so a slow
    // network probe never delays first paint.
    getUpdateChecker().scheduleUpdateCheck()
    if (!isAppQuitting) {
      const appPing = require("./shared/app-ping.cjs")
      const baseDir = require("./shared/runtime-paths.cjs").getBaseDir()
      if (getPrivacyPreferences().usagePingEnabled()) {
        // Opted in: one ping for this launch.
        stopAppPing = appPing.startAppPing({ dataDir: baseDir, appVersion: app.getVersion() })
      } else {
        // No consent, no persistent identifier (older versions created one).
        appPing.forgetInstallId(baseDir)
      }
    }
  } catch (err) {
    if (isAppQuitting) {
      // The user closed the window or quit while the backend was starting:
      // the "failure" is the requested shutdown, not something to report.
      console.log("[electron] Startup cancelled because BetterC0de is quitting:", err?.message || err)
      return
    }
    void reportAppCrash(err)
    console.error("[electron] Failed to start:", err)
    let links
    try {
      links = projectLinks(require(path.join(app.getAppPath(), "package.json")))
    } catch {
      links = undefined
    }
    const { title, message } = describeStartupFailure({
      error: err,
      isPackaged: app.isPackaged,
      links,
    })
    dialog.showErrorBox(title, message)
    app.quit()
  }
})

/**
 * Sleep and wake: liveness checks pause while the machine sleeps (timers
 * stretch across suspend and would misread a waking backend as hung) and run
 * shortly after resume to catch a backend that did not survive it. Windows
 * hear about the resume too (`system:resumed`): a reconnect they scheduled
 * before the sleep may now be far in the future, so they retry at once.
 */
function watchSystemPowerEvents() {
  const { powerMonitor } = require("electron")
  powerMonitor.on("suspend", () => {
    console.log("[electron] System is suspending; pausing backend health checks")
    backendProcess?.peekBackendSupervisor()?.pause()
  })
  powerMonitor.on("resume", () => {
    console.log("[electron] System resumed; re-checking the backend")
    backendProcess?.peekBackendSupervisor()?.resume()
    broadcast(IpcEvent.SystemResumed, { resumedAt: Date.now() })
  })
}

app.on("window-all-closed", () => {
  requestApplicationQuit("all windows closed")
})

// Runs before windows close on macOS (Cmd+Q, Dock → Quit) and on every other
// quit path. The quit is held until the backend and plugins have stopped,
// then re-issued once shutdown is complete.
app.on("before-quit", (event) => {
  if (applicationShutdownComplete) return
  event.preventDefault()
  requestApplicationQuit("quit requested")
})

// macOS Dock click with no open window while the app is still running.
app.on("activate", () => {
  if (!startupWindowCreated || isAppQuitting) return
  if (BrowserWindow.getAllWindows().length === 0) recreateMainWindow("activate")
})

// GPU, utility and other helper process crashes: log them (and report them
// when the user opted in to automatic crash reports).
app.on("child-process-gone", (_event, details) => {
  if (!details || details.reason === "clean-exit" || isAppQuitting) return
  const message = `${details.type} process gone: reason=${details.reason} exitCode=${details.exitCode}${details.serviceName ? ` service=${details.serviceName}` : ""}`
  console.error(`[electron] ${message}`)
  if (details.reason !== "killed") void reportAppCrash(new Error(message))
})

mainModuleReady = true
