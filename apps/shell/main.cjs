const { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, protocol, session, shell } = require("electron")
const { fork, spawn } = require("child_process")
const path = require("path")
const readline = require("readline")
let appDiagnostics = null

function getAppDiagnostics() {
  if (!appDiagnostics) {
    let installId = null
    try {
      installId = require("./shared/app-ping.cjs").getOrCreateInstallId(
        require("./shared/runtime-paths.cjs").getBaseDir(),
      )
    } catch { /* Reports remain available when the profile cannot be written. */ }
    appDiagnostics = require("./shared/app-diagnostics.cjs").createAppDiagnostics({
      appVersion: app.getVersion(), os: process.platform, arch: process.arch, installId,
      automaticReports: process.env.BETTERC0DE_DISABLE_CRASH_REPORTS !== "1",
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
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
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

/**
 * Lazily-loaded electron-updater.  Isolated in a try/catch so the app keeps
 * booting on setups where the dep hasn't been installed yet (e.g. a checkout
 * that skipped `npm install`).  The release pipeline configures the GitHub
 * provider through `build.publish` in package.json, so no runtime URL is
 * hardcoded here — the generated `app-update.yml` ships inside the asar.
 */
// Loaded lazily: electron-updater pulls in js-yaml and builder-util-runtime,
// which is a pointless parse cost at boot given the update check is deferred
// until after first paint — and is skipped entirely on unsigned builds.
let autoUpdater = null
let autoUpdaterLoaded = false
function loadAutoUpdater() {
  if (autoUpdaterLoaded) return autoUpdater
  autoUpdaterLoaded = true
  try {
    ;({ autoUpdater } = require("electron-updater"))
  } catch (err) {
    console.warn(
      "[electron] electron-updater not installed — auto-update disabled:",
      err && err.message ? err.message : err,
    )
  }
  return autoUpdater
}

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

process.on("uncaughtException", (err, origin) => {
  void reportAppCrash(err)
  console.error(
    "[electron] Uncaught exception (" + origin + "):",
    err.message,
    "\n",
    err.stack ?? "(no stack)",
  )
  process.exitCode = 1
  if (fatalMainShutdownStarted) return
  fatalMainShutdownStarted = true

  if (!mainModuleReady) {
    setImmediate(() => app.exit(1))
    return
  }

  const forcedExit = setTimeout(() => {
    console.error("[electron] Fatal shutdown deadline exceeded; forcing exit")
    app.exit(1)
  }, 15_000)
  requestApplicationQuit(`uncaught exception (${origin})`)
  app.once("will-quit", () => clearTimeout(forcedExit))
})

const {
  registerPluginHandlers,
  setPluginWindow,
  installDefaultPlugins,
  setPluginEncryptionKey,
  disposePlugins,
} = require("./plugin-ipc.cjs")
const { registerOnboardingHandlers } = require("./onboarding-ipc.cjs")
const { registerCliPluginHandlers } = require("./cli-plugins-ipc.cjs")
const { registerMcpHandlers } = require("./mcp-ipc.cjs")
const { registerSkillsHandlers } = require("./skills-ipc.cjs")
const { registerHooksHandlers } = require("./hooks-ipc.cjs")
const { registerSubagentsHandlers } = require("./subagents-ipc.cjs")
const { registerProviderHandlers } = require("./provider-ipc.cjs")
const {
  assertTrustedIpcSender,
  forcePreviewPartition,
  isAllowedExternalUrl,
  isAllowedNavigationUrl,
  isAllowedWebviewUrl,
  isTrustedRendererRequest,
  isTrustedRendererPermission,
} = require("./shared/urlPolicy.cjs")
const { buildRuntimeConfigScript } = require("./shared/runtimeConfig.cjs")
const { setBackendConnection } = require("./shared/backend-endpoint.cjs")
const { IpcChannel, IpcEvent } = require("./shared/ipc-contract.cjs")
const { ok } = require("./shared/ipc-envelope.cjs")
const { broadcast } = require("./shared/broadcast.cjs")
const { describeStartupFailure, projectLinks } = require("./shared/startup-failure.cjs")
const { installPreviewRequestCapture } = require("./preview-request-capture.cjs")
const {
  createBackendStartupWatchdog,
} = require("./shared/backend-startup-watchdog.cjs")
const appConfig = require("./shared/appConfig.cjs")
const { resolveClaudeCodeBinaryPath } = require("./shared/claude-binary-path.cjs")
const { createBackendDevReloader } = require("./backend-dev-reloader.cjs")
const {
  beginCliProcessShutdown,
  resumeCliProcessAdmissions,
  shutdownAllCliProcesses,
  resolveCliBinary,
} = require("./shared/spawn-cli.cjs")

const BACKEND_SHUTDOWN_TIMEOUT_MS = appConfig.BACKEND_SHUTDOWN_TIMEOUT_MS
const BACKEND_STARTUP_TIMEOUT_MS = appConfig.BACKEND_STARTUP_TIMEOUT_MS
const BACKEND_STARTUP_HARD_TIMEOUT_MS =
  appConfig.BACKEND_STARTUP_HARD_TIMEOUT_MS
const BACKEND_FORCE_KILL_EXIT_TIMEOUT_MS =
  appConfig.BACKEND_FORCE_KILL_EXIT_TIMEOUT_MS
const BACKEND_STOP_SIGNALS = ["SIGTERM", "SIGKILL"]
const SETTINGS_KEY_FILENAME = "settings-key.bin"
const WINDOW_STATE_FILENAME = "window-state.json"
// No `persist:` prefix: preview cookies/storage live only for this app
// process and are never shared with the trusted renderer's default session.
const PREVIEW_SESSION_PARTITION = "betterc0de-preview"

let nodeBackendHandle = null
let mainWindow = null
let serverPort = 0
let serverToken = ""
// Provider OAuth and workspace-trust checks read this live. A boot-time
// copy would go stale the first time the backend restarts on a new port.
setBackendConnection(() =>
  serverPort && serverToken ? { port: serverPort, token: serverToken } : null,
)
let settingsEncryptionKey = ""
let isAppQuitting = false
let backendDevReloader = null
let backendRestartPromise = null
let backendStopPromise = null
let applicationShutdownPromise = null
let applicationShutdownComplete = false
let stopAppPing = () => {}
let quitAfterShutdownScheduled = false
let resolvedBackendDataDir = null
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
 * Resolve the on-disk data root for the backend (SQLite + settings.json +
 * settings-key.bin). Previously we passed `app.getPath("userData")`, which
 * on Windows maps to `%APPDATA%\betterc0de\` — i.e. Roaming AppData, a
 * sync-sensitive location that's a poor fit for a multi-MB chat DB.
 *
 * Follows the BetterC0de convention (`~/.betterc0de`, overridable via
 * `BETTERC0DE_HOME`) so the path is identical on Windows, macOS, and Linux
 * and sits next to the existing `~/.betterc0de[-dev]/plugins/` directory
 * that the plugin loader already manages. Dev builds use
 * `~/.betterc0de-dev/` to keep test data separate from a user's packaged
 * install's real history.
 *
 * Override with `BETTERC0DE_HOME=/some/path` — the backend then writes to
 * `/some/path/userdata/`. `BETTERC0DE_DATA_DIR` (already wired inside the
 * backend) still wins for power users who want to point at an absolute
 * path with no `/userdata` suffix; we don't read it here because this
 * helper's sole job is to compute the default.
 */
function resolveBetterC0deUserDataDir() {
  const fs = require("fs")
  if (resolvedBackendDataDir) return resolvedBackendDataDir

  const explicitDataDir = String(
    process.env.BETTERC0DE_DATA_DIR || "",
  ).trim()
  const homeOverride = String(process.env.BETTERC0DE_HOME || "").trim()
  for (const [name, value] of [
    ["BETTERC0DE_DATA_DIR", explicitDataDir],
    ["BETTERC0DE_HOME", homeOverride],
  ]) {
    if (value && (!path.isAbsolute(value) || value.includes("\u0000"))) {
      throw new Error(`${name} must be an absolute filesystem path`)
    }
  }

  const base = homeOverride
    ? path.resolve(homeOverride)
    : path.join(
        app.getPath("home"),
        app.isPackaged ? ".betterc0de" : ".betterc0de-dev",
      )
  const requested = path.resolve(
    explicitDataDir || path.join(base, "userdata"),
  )
  if (requested === path.parse(requested).root) {
    throw new Error("Refusing to use a filesystem root as BetterC0de data dir")
  }

  fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(requested)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`BetterC0de data dir is not a regular directory: ${requested}`)
  }
  resolvedBackendDataDir = fs.realpathSync.native(requested)
  return resolvedBackendDataDir
}

/**
 * Provision (or load) the symmetric key used by the backend to encrypt
 * provider API keys in settings.json.  The raw 32-byte key is kept only in
 * memory; on disk we store the OS-bound ciphertext produced by Electron's
 * `safeStorage` (backed by DPAPI on Windows, Keychain on macOS, and
 * libsecret / kwallet on Linux).  When safeStorage is unavailable — e.g.
 * Linux without a working keyring — we skip key provisioning and the
 * backend transparently falls back to plaintext settings, matching the
 * pre-encryption behaviour rather than blocking the app.
 *
 * Must be called after `app.whenReady()`.
 */
// S4: track once whether the OS keyring is available so the renderer can show
// a persistent warning banner when API keys are stored in plaintext.  Set
// during the first call to `ensureSettingsEncryptionKey` and surfaced via the
// AppInfo handler.
let secretsEncryptionAvailable = null

function getSecretsEncryptionAvailable() {
  if (secretsEncryptionAvailable === null) {
    try {
      const { safeStorage } = require("electron")
      secretsEncryptionAvailable = !!safeStorage.isEncryptionAvailable()
    } catch {
      secretsEncryptionAvailable = false
    }
  }
  return secretsEncryptionAvailable
}

function readBoundedRegularFileSync(filePath, maxBytes) {
  const fs = require("fs")
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(`Unsafe or oversized legacy companion: ${filePath}`)
  }
  const noFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = fs.fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      // Node can report a volume identifier from fstat() while path-based
      // stat() reports dev=0 on Windows. The inode/file index remains the
      // stable identity there; POSIX requires both device and inode.
      (process.platform !== "win32" && opened.dev !== stat.dev) ||
      opened.ino !== stat.ino
    ) {
      throw new Error(`Legacy companion changed while opening: ${filePath}`)
    }
    const bytes = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    if (offset !== bytes.length) {
      throw new Error(`Legacy companion was truncated while reading: ${filePath}`)
    }
    return bytes
  } finally {
    fs.closeSync(fd)
  }
}

function publishBufferAtomicallyIfAbsentSync(
  targetPath,
  bytes,
  temporaryPrefix,
) {
  const fs = require("fs")
  const crypto = require("crypto")
  const directory = path.dirname(targetPath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const staged = path.join(
    directory,
    `.${temporaryPrefix}-${crypto.randomUUID()}.tmp`,
  )
  const fd = fs.openSync(
    staged,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  )
  try {
    let offset = 0
    while (offset < bytes.length) {
      offset += fs.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(staged, targetPath)
    // The staged file contents are durable above; persist the new directory
    // entry as well before the backend can write settings encrypted by this
    // key. Windows does not support opening directories through Node's fs API
    // consistently, so its filesystem/OS remains the durability boundary.
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY)
      try {
        fs.fsyncSync(directoryFd)
      } finally {
        fs.closeSync(directoryFd)
      }
    }
    return true
  } catch (error) {
    try {
      fs.lstatSync(targetPath)
      return false
    } catch (targetError) {
      if (targetError?.code !== "ENOENT") throw targetError
      throw error
    }
  } finally {
    fs.rmSync(staged, { force: true })
  }
}

function legacyDataCandidates(targetDbPath) {
  const home = app.getPath("home")
  const devRoot = path.resolve(home, ".betterc0de-dev")
  const resolvedTarget = path.resolve(targetDbPath)
  const relativeToDevRoot = path.relative(devRoot, resolvedTarget)
  if (
    relativeToDevRoot === "" ||
    (
      !relativeToDevRoot.startsWith("..") &&
      !path.isAbsolute(relativeToDevRoot)
    )
  ) {
    // Development data must never silently import production credentials.
    return [devRoot]
  }
  const candidates = [path.join(home, ".betterc0de")]
  if (process.platform === "win32") {
    candidates.push(
      path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        "betterc0de",
      ),
    )
  } else if (process.platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "betterc0de"),
    )
  } else {
    candidates.push(
      path.join(
        process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
        "betterc0de",
      ),
    )
  }
  return candidates
}

function containsValidLegacyDatabase(filePath) {
  const fs = require("fs")
  const Database = require("better-sqlite3")
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`SQLite migration path is not a regular file: ${filePath}`)
  }
  if (stat.size < 16) return false

  let db = null
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true })
    const quickCheck = db.pragma("quick_check", { simple: true })
    if (quickCheck !== "ok") return false
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .get()
    return Number(row?.count) > 0
  } catch (error) {
    const code = String(error?.code || "").toUpperCase()
    if (
      code === "SQLITE_CORRUPT" ||
      code === "SQLITE_NOTADB" ||
      code === "SQLITE_FORMAT"
    ) {
      return false
    }
    throw error
  } finally {
    db?.close()
  }
}

/**
 * Adopt only the wrapped legacy key before provisioning a new one. The
 * backend subsequently migrates settings first and the SQLite snapshot last.
 * This ordering ensures the raw key passed to the backend matches encrypted
 * legacy settings even on the very first migrated boot.
 */
function adoptLegacySettingsKeyIfNeeded(targetKeyPath, safeStorage) {
  const fs = require("fs")
  if (fs.existsSync(targetKeyPath)) return
  const targetSettingsPath = path.join(
    path.dirname(targetKeyPath),
    "settings.json",
  )
  let targetSettings = null
  let targetSettingsEncrypted = false
  if (fs.existsSync(targetSettingsPath)) {
    targetSettings = readBoundedRegularFileSync(
      targetSettingsPath,
      16 * 1024 * 1024,
    )
    // Plaintext target settings do not need a legacy encryption identity.
    targetSettingsEncrypted = targetSettings.includes(
      Buffer.from("enc:v1:", "utf8"),
    )
    if (!targetSettingsEncrypted) return
  }

  const targetDbPath = path.join(path.dirname(targetKeyPath), "betterc0de.db")
  for (const sourceDir of legacyDataCandidates(targetDbPath)) {
    if (path.resolve(sourceDir) === path.resolve(path.dirname(targetKeyPath))) {
      continue
    }
    const sourceDb = path.join(sourceDir, "betterc0de.db")
    const sourceSettings = path.join(sourceDir, "settings.json")
    if (!containsValidLegacyDatabase(sourceDb)) continue
    // Keep candidate ordering identical to the backend migration. Once a
    // database candidate wins, never borrow a key from a later installation.
    if (!fs.existsSync(sourceSettings)) {
      if (targetSettingsEncrypted) {
        throw new Error(
          `Encrypted target settings have no matching legacy settings at ${sourceDir}`,
        )
      }
      return
    }
    const settings = readBoundedRegularFileSync(
      sourceSettings,
      16 * 1024 * 1024,
    )
    if (targetSettings && !targetSettings.equals(settings)) {
      throw new Error(
        `Encrypted target settings do not match the selected legacy database at ${sourceDir}`,
      )
    }
    if (!settings.includes(Buffer.from("enc:v1:", "utf8"))) {
      if (targetSettingsEncrypted) {
        throw new Error(
          `Encrypted target settings do not have an encrypted legacy companion at ${sourceDir}`,
        )
      }
      return
    }

    const sourceKey = path.join(sourceDir, SETTINGS_KEY_FILENAME)
    if (!fs.existsSync(sourceKey)) {
      throw new Error(
        `Encrypted legacy settings at ${sourceDir} have no ${SETTINGS_KEY_FILENAME}`,
      )
    }
    const wrappedKey = readBoundedRegularFileSync(sourceKey, 1024 * 1024)
    // Validate the OS-bound ciphertext before publishing it. A moved/corrupt
    // legacy key must not become an immutable target file that blocks all
    // subsequent recovery attempts.
    decryptSettingsKeyBytes(safeStorage, wrappedKey)
    publishBufferAtomicallyIfAbsentSync(
      targetKeyPath,
      wrappedKey,
      "settings-key-migration",
    )
    console.log(`[electron] Adopted legacy ${SETTINGS_KEY_FILENAME}`)
    return
  }
  if (targetSettingsEncrypted) {
    throw new Error(
      "Encrypted settings exist, but no matching recoverable settings key was found",
    )
  }
}

function decryptSettingsKeyBytes(safeStorage, wrapped) {
  const keyB64 = safeStorage.decryptString(wrapped)
  if (typeof keyB64 !== "string" || keyB64.length === 0) {
    throw new Error("settings-key.bin decrypted to an empty key")
  }
  const decoded = Buffer.from(keyB64, "base64")
  if (decoded.length !== 32) {
    throw new Error("settings-key.bin does not contain a 32-byte key")
  }
  return keyB64
}

function decryptSettingsKeyFile(safeStorage, keyPath) {
  const wrapped = readBoundedRegularFileSync(keyPath, 1024 * 1024)
  return decryptSettingsKeyBytes(safeStorage, wrapped)
}

function ensureSettingsEncryptionKey() {
  const { safeStorage } = require("electron")
  const fs = require("fs")
  const crypto = require("crypto")

  if (!safeStorage.isEncryptionAvailable()) {
    secretsEncryptionAvailable = false
    const dataDir = resolveBetterC0deUserDataDir()
    const existingKeyPath = path.join(dataDir, SETTINGS_KEY_FILENAME)
    const existingSettingsPath = path.join(dataDir, "settings.json")
    if (fs.existsSync(existingKeyPath)) {
      throw new Error(
        "Encrypted settings key exists, but OS credential storage is unavailable",
      )
    }
    if (fs.existsSync(existingSettingsPath)) {
      const settingsBytes = readBoundedRegularFileSync(
        existingSettingsPath,
        16 * 1024 * 1024,
      )
      if (settingsBytes.includes(Buffer.from("enc:v1:", "utf8"))) {
        throw new Error(
          "Encrypted settings exist, but OS credential storage is unavailable",
        )
      }
    }
    console.warn("[electron] safeStorage unavailable — provider API keys will remain plaintext on disk")
    return ""
  }
  secretsEncryptionAvailable = true

  const keyPath = path.join(resolveBetterC0deUserDataDir(), SETTINGS_KEY_FILENAME)
  adoptLegacySettingsKeyIfNeeded(keyPath, safeStorage)
  try {
    return decryptSettingsKeyFile(safeStorage, keyPath)
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw new Error(
        "Existing settings-key.bin could not be read or decrypted; refusing to replace it",
        { cause: err },
      )
    }
  }

  const keyB64 = crypto.randomBytes(32).toString("base64")
  const wrapped = safeStorage.encryptString(keyB64)
  publishBufferAtomicallyIfAbsentSync(
    keyPath,
    wrapped,
    "settings-key-create",
  )
  // A concurrent creator may have won the no-overwrite publish. Always read
  // the durable winner rather than returning an unpublished in-memory key.
  return decryptSettingsKeyFile(safeStorage, keyPath)
}

const originalIpcHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalIpcHandle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, channel, getRendererSecurityPolicy())
    return listener(event, ...args)
  })

function emitBackendStatus(status, payload = {}) {
  // Broadcast to every BrowserWindow — the primary plus any secondary
  // window spawned via `WindowOpenWith`. Without this, secondary
  // windows missed the "ready" event and stayed stuck on the
  // backend-bootstrap splash forever.
  broadcast(IpcEvent.BackendStatus, { status, ...payload })
}

function resetBackendRuntime() {
  serverPort = 0
  serverToken = ""
}

function getRuntimeConfigScript() {
  return buildRuntimeConfigScript({
    port: serverPort,
    electronPath: path.join(__dirname).replace(/\\/g, "/"),
    previewPartition: PREVIEW_SESSION_PARTITION,
  })
}

async function syncRuntimeConfigToRenderers() {
  const script = getRuntimeConfigScript()
  const updates = []
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    updates.push(win.webContents.executeJavaScript(script))
  }
  const results = await Promise.allSettled(updates)
  for (const result of results) {
    if (result.status !== "rejected") continue
    const err = result.reason
    console.warn(
      "[electron] could not refresh renderer backend config:",
      err && err.message ? err.message : err,
    )
  }
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

function getBackendMode() {
  const raw = String(process.env.BETTERC0DE_BACKEND || "").trim().toLowerCase()
  return raw === "in-process" ? "in-process" : "spawn"
}

function getBackendEntryPath() {
  // After the apps/ + packages/ migration the shell lives at apps/shell/
  // and the backend at apps/backend/, so the relative path stays one
  // sibling step away — `..` lands in apps/, then into backend/dist/.
  return path.join(__dirname, "..", "backend", "dist", "index.js")
}

function hasChildExited(child) {
  return (
    !child ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
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

function closeBackendReaders(handle) {
  try { handle.stdoutReader?.close() } catch {}
  try { handle.stderrReader?.close() } catch {}
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

    // Absolute fallback: SIGKILL after the full timeout window.
    const sigkillTimer = setTimeout(() => {
      void stopProcessTree(child, BACKEND_STOP_SIGNALS[1])
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

function handleBackendExit(reason) {
  const wasReady = !!serverPort
  resetBackendRuntime()
  nodeBackendHandle = null

  if (!isAppQuitting && wasReady) {
    console.error(`[electron] ${reason}`)
    emitBackendStatus("failed", { reason })
  }
}

function tryParseBackendControlLine(line) {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

/**
 * Verifies the backend is actually serving HTTP on the reported port.
 * Guards against a stray log line happening to look like the readiness
 * control frame — until `/health` returns `{ status: "ok" }` we refuse to
 * mark the backend ready.  Polls for up to ~3s (15 × 200ms) before giving
 * up and rejecting the startup promise.
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

async function startSpawnedBackend() {
  const backendEntry = getBackendEntryPath()
  try {
    require("fs").accessSync(backendEntry)
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
  const child = fork(backendEntry, [], {
    ...(devNodeExecPath ? { execPath: devNodeExecPath, execArgv: [] } : {}),
    cwd: userDataDir,
    env: {
      ...process.env,
      BETTERC0DE_DATA_DIR: userDataDir,
      BETTERC0DE_WEB_ROOT: path.join(app.getAppPath(), "apps", "ui", "dist"),
      // Only forwarded when safeStorage could provision a key; empty value
      // makes the backend treat encryption as unavailable and fall back to
      // plaintext storage, matching pre-encryption behaviour.
      BETTERC0DE_SETTINGS_KEY: settingsEncryptionKey,
      ...(claudeCodeBinaryPath ? { BETTERC0DE_CLAUDE_CODE_PATH: claudeCodeBinaryPath } : {}),
      ...(codexCliBinaryPath ? { BETTERC0DE_CODEX_CLI_PATH: codexCliBinaryPath } : {}),
    },
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

    stderrReader.on("line", async (line) => {
      if (!line) return
      const control = tryParseBackendControlLine(line)

      if (
        control?.control === "betterc0de/backend-startup" &&
        control?.status === "starting" &&
        control.protocol === 1
      ) {
        startupWatchdog?.pulse()
        return
      }

      if (
        control?.status === "ready" &&
        Number.isInteger(control.port) &&
        control.port > 0 &&
        control.port <= 65_535 &&
        typeof control.token === "string" &&
        control.token.length >= 32 &&
        control.token.length <= 4_096
      ) {
        if (settled || verifyingReadiness) return
        verifyingReadiness = true
        // The ready frame ends the liveness-heartbeat phase. From here the
        // independently bounded health probe owns timeout reporting.
        startupWatchdog?.stop()
        const reportedPort = control.port
        const reportedToken = control.token
        // Confirm the process is actually listening on the advertised port
        // before trusting the readiness frame — any stray log shaped like
        // `{"status":"ready","port":...}` would otherwise spoof readiness.
        try {
          await verifyBackendHealth(reportedPort, {
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

      if (control?.status === "error") {
        const message = typeof control.message === "string" ? control.message : "Node backend failed to start"
        emitBackendStatus("failed", { reason: message })
        rejectStart(new Error(message))
        return
      }

      stderrTail.push(line)
      if (stderrTail.length > 50) stderrTail.shift()
      console.error(`[backend] ${line}`)
    })
  })
}

async function startInProcessBackend() {
  console.log("[electron] Starting Node backend in-process")
  let startNodeBackend

  // In-process mode shares our process.env, so the backend's
  // `getMasterKey()` will read the freshly-provisioned key straight from
  // here rather than from a child process env.
  if (settingsEncryptionKey) {
    process.env.BETTERC0DE_SETTINGS_KEY = settingsEncryptionKey
  }
  const claudeCodeBinaryPath = resolveClaudeCodeBinaryPath()
  if (claudeCodeBinaryPath) {
    process.env.BETTERC0DE_CLAUDE_CODE_PATH = claudeCodeBinaryPath
  }
  const codexCliBinaryPath =
    process.platform === "darwin" && !process.env.BETTERC0DE_CODEX_CLI_PATH
      ? resolveCliBinary("codex")
      : null
  if (codexCliBinaryPath) {
    process.env.BETTERC0DE_CODEX_CLI_PATH = codexCliBinaryPath
  }

  try {
    ;({ startNodeBackend } = require("../backend/dist/inProcess.js"))
  } catch (err) {
    const message =
      "Could not load backend. Run `npm run backend:build` from the repo root first."
    console.error(`[electron] ${message}`, err)
    emitBackendStatus("failed", { reason: message })
    throw new Error(message)
  }

  const startupAbort = new AbortController()
  let fatalFailure = null
  let backendPublished = false
  let rejectFatalStartup
  const fatalStartup = new Promise((_resolve, reject) => {
    rejectFatalStartup = reject
  })
  let rejectStartupTimeout
  const startupTimeout = new Promise((_resolve, reject) => {
    rejectStartupTimeout = reject
  })
  const startupWatchdog = createBackendStartupWatchdog({
    idleTimeoutMs: BACKEND_STARTUP_TIMEOUT_MS,
    initialTimeoutMs: appConfig.BACKEND_STARTUP_INITIAL_TIMEOUT_MS,
    hardTimeoutMs: BACKEND_STARTUP_HARD_TIMEOUT_MS,
    onTimeout: ({ kind, timeoutMs }) => {
      const error = new Error(
        kind === "initial"
          ? `In-process backend did not send its first startup heartbeat within ${timeoutMs}ms (module loading)`
          : kind === "idle"
            ? `In-process backend did not send a startup heartbeat within ${timeoutMs}ms`
          : `In-process backend did not become ready within the ${timeoutMs}ms hard startup limit`,
      )
      startupAbort.abort(error)
      rejectStartupTimeout(error)
    },
  })
  const backendStartup = Promise.resolve().then(() =>
    startNodeBackend({
      dataDir: resolveBetterC0deUserDataDir(),
      webRoot: path.join(app.getAppPath(), "apps", "ui", "dist"),
      signal: startupAbort.signal,
      onStartupHeartbeat: () => startupWatchdog.pulse(),
      onFatal: (error, origin) => {
        void reportAppCrash(error)
        const reason =
          error && error.message ? error.message : String(error)
        fatalFailure ??= Object.assign(
          new Error(`Backend became unhealthy (${origin}): ${reason}`),
          { cause: error },
        )
        console.error(
          `[electron] In-process backend became unhealthy (${origin}): ${reason}`
        )
        resetBackendRuntime()
        emitBackendStatus("failed", { reason: fatalFailure.message })
        process.exitCode = 1
        startupAbort.abort(fatalFailure)
        rejectFatalStartup(fatalFailure)
        // A tainted in-process backend shares Electron's process and cannot
        // be replaced safely in place. Drive the normal application teardown
        // so plugins, IPC handlers, the backend handle, and windows all stop.
        if (backendPublished) {
          requestApplicationQuit(`in-process backend fatal (${origin})`)
        }
      },
    }),
  )

  let handle
  try {
    handle = await Promise.race([
      backendStartup,
      startupTimeout,
      fatalStartup,
    ])
  } catch (error) {
    startupAbort.abort(error)
    // If synchronous startup work observes cancellation late and still
    // produces a handle, stop it instead of leaving an unreachable backend
    // alive after the timeout/fatal path has already rejected.
    const lateCleanup = backendStartup.then(
      async (lateHandle) => {
        await lateHandle.stop()
      },
      () => {},
    )
    let cleanupTimer = null
    let cleanupFailure = null
    try {
      await Promise.race([
        lateCleanup,
        new Promise((_resolve, reject) => {
          cleanupTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `In-process backend startup cleanup exceeded ${BACKEND_SHUTDOWN_TIMEOUT_MS}ms`,
                ),
              ),
            BACKEND_SHUTDOWN_TIMEOUT_MS,
          )
          cleanupTimer.unref?.()
        }),
      ])
    } catch (stopError) {
      cleanupFailure = stopError
      console.error(
        "[electron] Late in-process backend cleanup failed:",
        stopError,
      )
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer)
    }
    if (fatalFailure) {
      requestApplicationQuit("in-process backend fatal during startup")
    }
    if (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure],
        "In-process backend startup failed and cleanup did not complete",
      )
    }
    throw error
  } finally {
    startupWatchdog.stop()
  }

  if (fatalFailure || startupAbort.signal.aborted || isAppQuitting) {
    const failure =
      fatalFailure ||
      startupAbort.signal.reason ||
      new Error("BetterC0de is shutting down")
    try {
      await handle.stop()
    } catch (stopError) {
      throw new AggregateError(
        [failure, stopError],
        "In-process backend startup was cancelled and cleanup failed",
      )
    }
    throw failure
  }

  nodeBackendHandle = {
    mode: "in-process",
    stop: () => handle.stop(),
  }
  backendPublished = true
  serverPort = handle.port
  serverToken = handle.token
  installBackendAuthInterceptor()
  console.log(`[electron] Node backend ready on port ${serverPort}`)
  emitBackendStatus("ready", { port: serverPort })
  return { port: serverPort, token: serverToken }
}

async function startBackend() {
  try {
    if (getBackendMode() === "in-process") {
      return await startInProcessBackend()
    }
    return await startSpawnedBackend()
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    console.error(`[electron] Node backend init failed: ${message}`)
    emitBackendStatus("failed", { reason: message })
    throw err
  }
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
      if (
        handle.mode === "spawn" &&
        !hasChildExited(handle.child)
      ) {
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
  if (isAppQuitting) throw new Error("BetterC0de is shutting down")
  if (backendRestartPromise) return backendRestartPromise

  backendRestartPromise = (async () => {
    console.log(`[electron] Restarting backend (${reason})...`)
    emitBackendStatus("restarting", { reason })
    await stopBackend()
    if (isAppQuitting) throw new Error("BetterC0de is shutting down")
    if (nodeBackendHandle) {
      throw new Error("Cannot restart while the previous backend is still running")
    }
    const started = await startBackend()
    await syncRuntimeConfigToRenderers()
    return started
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

  const directory = path.join(__dirname, "..", "backend", "dist")
  backendDevReloader = createBackendDevReloader({
    directory,
    onReload: reloadBackendForDevelopment,
  })
  console.log(`[dev] Watching backend build output at ${directory}`)
}

function stopBackendDevReloader() {
  backendDevReloader?.close()
  backendDevReloader = null
}

function shutdownApplication(reason) {
  if (applicationShutdownPromise) return applicationShutdownPromise
  isAppQuitting = true
  beginCliProcessShutdown()
  stopBackendDevReloader()

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
    await runStep("CLI process", shutdownAllCliProcesses)
    await runStep("Plugin", disposePlugins)

    // A development restart may already be between its stop and start phases.
    // Let it observe `isAppQuitting`, then stop whichever handle remains.
    if (backendRestartPromise) {
      try {
        await backendRestartPromise
      } catch {
        // Expected when restartBackend observes the shutdown gate.
      }
    }
    await runStep("Backend", stopBackend)
    await runStep("Crash report", () => appDiagnostics?.flush())
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
      app.quit()
    })
}

/**
 * Load persisted window bounds (size + position + maximized state) from
 * `~/.betterc0de[-dev]/userdata/window-state.json`. Returns sane defaults on
 * first launch, corrupt JSON, or bounds that no longer intersect any
 * connected display (e.g. user unplugged an external monitor).
 */
function loadWindowState() {
  const { readJson } = require("./shared/json-fs.cjs")
  const { screen } = require("electron")
  const fallback = {
    width: appConfig.DEFAULT_WINDOW_WIDTH,
    height: appConfig.DEFAULT_WINDOW_HEIGHT,
    x: undefined,
    y: undefined,
    isMaximized: false,
  }
  try {
    const statePath = path.join(resolveBetterC0deUserDataDir(), WINDOW_STATE_FILENAME)
    const parsed = readJson(statePath, null, { maxBytes: 64 * 1024, strict: true })
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback
    const width = Number(parsed.width)
    const height = Number(parsed.height)
    if (!Number.isInteger(width) || !Number.isInteger(height)
      || width < 400 || height < 300 || width > 32_768 || height > 32_768) {
      return fallback
    }
    const x = Number(parsed.x)
    const y = Number(parsed.y)
    const hasPosition = parsed.x != null && parsed.y != null
      && Number.isInteger(x) && Number.isInteger(y)
      && Math.abs(x) <= 2_147_483_647 && Math.abs(y) <= 2_147_483_647

    // If saved bounds don't intersect any current display, the window would
    // be invisible off-screen. Drop position and let the OS center it.
    let positionOk = hasPosition
    if (hasPosition) {
      const displays = screen.getAllDisplays()
      positionOk = displays.some((d) => {
        const b = d.bounds
        return x < b.x + b.width && x + width > b.x && y < b.y + b.height && y + height > b.y
      })
    }
    return {
      width,
      height,
      x: positionOk ? x : undefined,
      y: positionOk ? y : undefined,
      isMaximized: parsed.isMaximized === true,
    }
  } catch (err) {
    console.warn("[electron] could not load window state, using defaults:", err?.message || err)
    return fallback
  }
}

/**
 * Snapshot a window's bounds + maximize state to a plain object. Called
 * synchronously on window events; the returned object is durable — the
 * window can safely be destroyed before `writeWindowState` runs.
 *
 * `getNormalBounds()` returns the unmaximized rect even when the window is
 * currently maximized — so next launch still has a sensible size/position
 * to restore to after the user un-maximizes.
 */
function captureWindowState(win) {
  if (!win || win.isDestroyed()) return null
  const isMaximized = win.isMaximized()
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
  return { ...bounds, isMaximized }
}

function writeWindowState(state) {
  if (!state) return
  try {
    const { writeJson } = require("./shared/json-fs.cjs")
    const statePath = path.join(resolveBetterC0deUserDataDir(), WINDOW_STATE_FILENAME)
    writeJson(statePath, state, { maxBytes: 64 * 1024 })
  } catch (err) {
    console.warn("[electron] could not persist window state:", err?.message || err)
  }
}

let windowStateSaveTimer = null
function saveWindowStateDebounced(win) {
  const state = captureWindowState(win)
  if (!state) return
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null
    writeWindowState(state)
  }, appConfig.WINDOW_STATE_SAVE_DEBOUNCE_MS)
}

// ── Webview attach policy ────────────────────────────────────────────────
// Webviews are force-hardened (no node, isolated, sandboxed) and any
// renderer-supplied preload is stripped — EXCEPT the app's own
// browser-preview preload, which carries the element-inspector bridge
// (window.cursorBrowser) used by the editor preview and the design-mode
// canvas. Canvas guests always receive our own gesture/inspector bridge;
// other guests require an exact preload path match. Never trust a supplied path.
const PREVIEW_PRELOAD_PATH = path.join(__dirname, "browser-preview-preload.cjs")

function isOwnPreviewPreload(requested) {
  if (!requested || typeof requested !== "string") return false
  let candidate = requested
  try {
    if (candidate.startsWith("file:")) {
      candidate = require("url").fileURLToPath(candidate)
    }
  } catch {
    return false
  }
  const resolved = path.resolve(candidate)
  const expected = path.resolve(PREVIEW_PRELOAD_PATH)
  return process.platform === "win32"
    ? resolved.toLowerCase() === expected.toLowerCase()
    : resolved === expected
}

function attachWebviewPolicy(contents) {
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isAllowedWebviewUrl(params?.src || "")) {
      event.preventDefault()
      return
    }
    // Capture the requested preload BEFORE force-stripping — depending on
    // Electron version the <webview preload> attribute lands in
    // webPreferences.preloadURL, webPreferences.preload, or params.preload.
    const requestedPreload =
      webPreferences.preloadURL || webPreferences.preload || params?.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.webviewTag = false
    // Both fixed guest sessions are sandboxed and denied app permissions.
    // Canvas guests keep a fixed page zoom, independent of the editor browser.
    const canvas = params?.partition === CANVAS_PREVIEW_PARTITION
    forcePreviewPartition(webPreferences, params, canvas ? CANVAS_PREVIEW_PARTITION : PREVIEW_SESSION_PARTITION)
    webPreferences.additionalArguments = canvas ? ["--betterc0de-canvas-preview"] : []
    delete webPreferences.preload
    delete webPreferences.preloadURL
    if (canvas || isOwnPreviewPreload(requestedPreload)) {
      webPreferences.preload = PREVIEW_PRELOAD_PATH
    }
  })
}

function createWindow() {
  const isDev = !app.isPackaged
  const isMac = process.platform === "darwin"
  const savedState = loadWindowState()

  mainWindow = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    x: savedState.x,
    y: savedState.y,
    title: "BetterC0de",
    frame: isMac,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 13 },
        }
      : {}),
    // Don't override the icon at runtime: in packaged builds the OS uses
    // the EXE icon (set by electron-builder from build/icon.ico) for the
    // taskbar / Alt-Tab. Pointing this at the 32-px dist/favicon.png used
    // to *downscale* the proper multi-resolution EXE icon to a blurry
    // 32-px sprite. In dev there's no app icon either way.
    icon: undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      // Perf: kill the ~20–50 MB resident dictionary + background checking
      // thread. Not useful for a code-first IDE and the user can re-enable
      // per-field via `contenteditable="true" spellcheck="true"` if needed.
      spellcheck: false,
      // Perf: throttle timers / rAF while the window is hidden or
      // backgrounded. Default is true in recent Electron versions but we
      // set it explicitly so a future default flip can't regress us.
      backgroundThrottling: true,
    },
    // Don't show until the renderer has painted; eliminates the white-flash
    // blocking paint, lets the chrome appear only when we're actually
    // ready, and shaves perceived startup time.
    show: false,
  })
  registerTrustedRendererContents(mainWindow.webContents)
  if (isMac && typeof mainWindow.setWindowButtonVisibility === "function") {
    mainWindow.setWindowButtonVisibility(true)
  }

  let didShow = false
  const showOnce = (reason) => {
    if (didShow || !mainWindow) return
    didShow = true
    if (reason !== "ready-to-show") {
      console.warn(`[electron] window forced visible via ${reason}`)
    }
    mainWindow.show()
  }

  mainWindow.once("ready-to-show", () => showOnce("ready-to-show"))

  // Safety net: if `ready-to-show` never fires (silent renderer failure,
  // GPU stall, missing asset), the window stays invisible forever and the
  // user has no way to debug. After the configured fallback window, show
  // it anyway so devtools can be opened and the failure becomes
  // diagnosable instead of mysterious.
  setTimeout(() => showOnce("timeout"), appConfig.WINDOW_READY_TO_SHOW_FALLBACK_MS)

  // Surface the two classes of silent renderer failure that otherwise
  // leave the user with a blank screen and no error: (a) `loadFile` /
  // network couldn't fetch the entry HTML; (b) the renderer process
  // crashed after starting. Both used to pass unnoticed because there
  // was no listener for either event.
  //
  // Dev-only self-heal: the initial Vite load races the dev server —
  // ERR_ABORTED (-3) when Vite's dep-optimizer restarts the page mid-load,
  // ERR_CONNECTION_REFUSED (-102) when Electron connects before Vite is
  // actually listening. Both used to leave a permanently white window that
  // needed a manual reload; retry instead and only surface the dialog once
  // the retry budget is spent.
  const DEV_LOAD_RETRY_LIMIT = 40
  const DEV_LOAD_RETRY_DELAY_MS = 500
  let devLoadRetries = 0
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      const retryable = errorCode === -3 || errorCode === -102
      if (isDev && retryable && devLoadRetries < DEV_LOAD_RETRY_LIMIT) {
        devLoadRetries += 1
        console.warn(
          `[electron] dev renderer load failed (${errorCode}); retrying ${devLoadRetries}/${DEV_LOAD_RETRY_LIMIT}...`
        )
        setTimeout(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return
          const vitePort = process.env.VITE_DEV_PORT || appConfig.VITE_DEV_PORT_FALLBACK
          mainWindow.loadURL(`http://localhost:${vitePort}`)
        }, DEV_LOAD_RETRY_DELAY_MS)
        return
      }
      const msg = `Renderer failed to load: ${errorDescription} (${errorCode}) — ${validatedURL}`
      console.error(`[electron] ${msg}`)
      showOnce("did-fail-load")
      try { dialog.showErrorBox("BetterC0de", msg) } catch {}
    },
  )

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const msg = `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`
    console.error(`[electron] ${msg}`)
    showOnce("render-process-gone")
    try { dialog.showErrorBox("BetterC0de", msg) } catch {}
  })

  // Always-on devtools shortcut. Packaged builds have no default app menu
  // (and therefore no default F12 binding), so without this the user can
  // never open devtools to diagnose anything in production.
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return
    const isF12 = input.key === "F12"
    const isCtrlShiftI =
      (input.control || input.meta) && input.shift && input.key.toLowerCase() === "i"
    if (isF12 || isCtrlShiftI) mainWindow?.webContents.toggleDevTools()
  })

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "right" })
  }

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigationUrl(url, getRendererSecurityPolicy())) {
      event.preventDefault()
      return
    }
    mainWindow.webContents.executeJavaScript(getRuntimeConfigScript())
  })

  attachWebviewPolicy(mainWindow.webContents)

  if (isDev) {
    const vitePort = process.env.VITE_DEV_PORT || appConfig.VITE_DEV_PORT_FALLBACK
    console.log(`[electron] Loading Vite on port ${vitePort}`)
    mainWindow.loadURL(`http://localhost:${vitePort}`)
  } else {
    // After the apps/ migration the renderer's Vite output lives at
    // `apps/ui/dist/index.html` inside the packaged app root. Update if
    // electron-builder ever flattens this layout into the asar root.
    const distPath = path.join(app.getAppPath(), "apps", "ui", "dist", "index.html")
    mainWindow.loadFile(distPath)
  }

  mainWindow.webContents.on("did-finish-load", () => {
    devLoadRetries = 0
    mainWindow.webContents.executeJavaScript(getRuntimeConfigScript())
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url, app.isPackaged)) {
      shell.openExternal(url)
    }
    return { action: "deny" }
  })

  // Restore the maximized state AFTER the initial bounds are applied so the
  // pre-maximize size persisted by `getNormalBounds()` is what the window
  // un-maximizes to. Deferred until `ready-to-show` so the flicker from
  // size → maximize only happens once the window is visible.
  if (savedState.isMaximized) {
    mainWindow.once("ready-to-show", () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.maximize()
    })
  }

  // Persist bounds + maximize state on any change. Debounced so drag-resize
  // doesn't hammer the disk. `close` captures a final snapshot synchronously
  // (before the window is destroyed) and writes it immediately, bypassing
  // the debounce so the state isn't lost on quick-quit.
  const persist = () => saveWindowStateDebounced(mainWindow)
  mainWindow.on("resize", persist)
  mainWindow.on("move", persist)
  mainWindow.on("maximize", persist)
  mainWindow.on("unmaximize", persist)
  mainWindow.on("close", () => {
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer)
      windowStateSaveTimer = null
    }
    writeWindowState(captureWindowState(mainWindow))
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

/**
 * Track every secondary window we've spawned so they don't get
 * garbage-collected, and so the per-window webContents listeners can
 * fire devtools toggling / external-link forwarding the same way the
 * primary window does.
 */
const secondaryWindows = new Set()

/**
 * Open a secondary BrowserWindow that loads the same renderer entry as
 * `mainWindow` but with a URL hash carrying launch params (`mode=editor`
 * + an optional `cwd=<encoded>`). The renderer reads
 * `window.location.hash` once at boot to apply those overrides — see
 * `apps/ui/src/lib/launch-params.ts`.
 *
 * The secondary window participates in the SAME Electron app process
 * and the SAME renderer session, so:
 *  - localStorage / IndexedDB are shared with the primary,
 *  - backend auth is injected only when this registered window's main frame
 *    makes the request,
 *  - `electronAPI` is exposed exactly the same way via the preload.
 *
 * Backend status and plugin events use the shared broadcaster, so secondary
 * windows receive the same streams as the primary window.
 */
function openSecondaryWindow({ mode, cwd } = {}) {
  const isDev = !app.isPackaged
  const isMac = process.platform === "darwin"
  const params = new URLSearchParams()
  if (mode === "editor" || mode === "agent" || mode === "design") params.set("mode", mode)
  if (typeof cwd === "string" && cwd.length > 0) params.set("cwd", cwd)
  const hash = params.toString()

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "BetterC0de",
    frame: isMac,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 13 },
        }
      : {}),
    icon: undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: true,
    },
    show: false,
  })
  registerTrustedRendererContents(win.webContents)
  if (isMac && typeof win.setWindowButtonVisibility === "function") {
    win.setWindowButtonVisibility(true)
  }

  let didShow = false
  const showOnce = () => {
    if (didShow || win.isDestroyed()) return
    didShow = true
    win.show()
  }
  win.once("ready-to-show", showOnce)
  setTimeout(showOnce, appConfig.WINDOW_READY_TO_SHOW_FALLBACK_MS)

  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return
    const isF12 = input.key === "F12"
    const isCtrlShiftI =
      (input.control || input.meta) && input.shift && input.key.toLowerCase() === "i"
    if (isF12 || isCtrlShiftI) win.webContents.toggleDevTools()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url, app.isPackaged)) shell.openExternal(url)
    return { action: "deny" }
  })

  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigationUrl(url, getRendererSecurityPolicy())) {
      event.preventDefault()
      return
    }
    win.webContents.executeJavaScript(getRuntimeConfigScript())
  })

  // Secondary windows previously had NO will-attach-webview handler, so a
  // webview there attached with whatever preferences the renderer supplied.
  // Apply the same hardened policy as the main window.
  attachWebviewPolicy(win.webContents)

  win.webContents.on("did-finish-load", () => {
    win.webContents.executeJavaScript(getRuntimeConfigScript())
  })

  if (isDev) {
    const vitePort = process.env.VITE_DEV_PORT || appConfig.VITE_DEV_PORT_FALLBACK
    win.loadURL(`http://localhost:${vitePort}${hash ? `#${hash}` : ""}`)
  } else {
    const distPath = path.join(app.getAppPath(), "apps", "ui", "dist", "index.html")
    win.loadFile(distPath, hash ? { hash } : undefined)
  }

  secondaryWindows.add(win)
  win.on("closed", () => secondaryWindows.delete(win))

  return win
}

ipcMain.handle(IpcChannel.WindowMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
ipcMain.handle(IpcChannel.WindowMaximize, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?.isMaximized()) win.unmaximize()
  else win?.maximize()
})
ipcMain.handle(IpcChannel.WindowClose, (event) => BrowserWindow.fromWebContents(event.sender)?.close())
ipcMain.handle(IpcChannel.WindowIsMaximized, (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
ipcMain.handle(IpcChannel.WindowOpenWith, async (_event, opts = {}) => {
  // Renderer-supplied opts arrive shaped as `{mode?, cwd?}`. Sanitize
  // both fields here — `mode` is whitelisted to the known values,
  // and `cwd` is forced to a string + length-capped so a hostile
  // renderer can't push a multi-megabyte URL hash that crashes
  // electron's URL parser.
  const mode = opts.mode === "editor" || opts.mode === "agent" || opts.mode === "design" ? opts.mode : undefined
  const cwdRaw = typeof opts.cwd === "string" ? opts.cwd : ""
  // M3: cwd must be a real path the user has access to, NOT just a string of
  // bounded length.  Resolve it and require absolute + existing-directory.
  // Reject anything that escapes the user's home dir so a compromised
  // renderer can't open a window pointed at `/etc` or another user's home.
  let cwd
  if (
    cwdRaw.length > 0 &&
    cwdRaw.length <= 2048 &&
    !cwdRaw.includes("\u0000")
  ) {
    try {
      const fsLocal = require("node:fs")
      const resolved = path.resolve(cwdRaw)
      const initial = fsLocal.statSync(resolved)
      const canonical = fsLocal.realpathSync.native(resolved)
      const canonicalHome = fsLocal.realpathSync.native(app.getPath("home"))
      const opened = fsLocal.statSync(canonical)
      const relative = path.relative(canonicalHome, canonical)
      const inHome =
        relative === "" ||
        (
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        )
      const sameEntry =
        initial.dev === opened.dev &&
        initial.ino === opened.ino
      if (opened.isDirectory() && inHome && sameEntry) cwd = canonical
    } catch {
      // Non-existent / unreadable / outside home → drop to undefined.
      cwd = undefined
    }
  }
  try {
    openSecondaryWindow({ mode, cwd })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle(IpcChannel.WindowToggleDevTools, (event) =>
  BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools()
)

ipcMain.handle(IpcChannel.AppInfo, () => ({
  isPackaged: app.isPackaged,
  baseDirName: path.basename(require("./shared/runtime-paths.cjs").getBaseDir()),
  baseDir: require("./shared/runtime-paths.cjs").getBaseDir(),
  // S4: surface OS-keyring availability to the renderer so the UI can warn
  // the user when provider API keys are stored unencrypted (typical on
  // Linux without gnome-keyring/kwallet, headless containers, WSL).
  secretsEncryptionAvailable: getSecretsEncryptionAvailable(),
  platform: process.platform,
  // Null when auto-update is active. A non-null reason means this install will
  // never update itself, which the user should be told about rather than
  // finding out from a console line they never see.
  updatesDisabledReason,
}))

ipcMain.handle(IpcChannel.BugReportSend, (_, report) => {
  return getAppDiagnostics().sendReport(report)
})

ipcMain.handle(IpcChannel.BackendRestart, async () => {
  const started = await restartBackend("remote access setting changed")
  return { port: started.port }
})

ipcMain.handle(IpcChannel.OpenExternal, async (_, url) => {
  if (typeof url === "string" && isAllowedExternalUrl(url, app.isPackaged)) {
    await shell.openExternal(url)
    return ok()
  }
  throw new Error("Blocked external URL")
})

// Extensions the OS auto-executes via `shell.openPath` — explicitly refused
// to prevent a compromised renderer from triggering code execution via file
// association.
const DANGEROUS_OPEN_EXT = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".lnk", ".pif",
  ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
  ".hta", ".reg", ".jar", ".app", ".dmg", ".pkg", ".sh", ".bash",
])

ipcMain.handle(IpcChannel.OpenPath, async (_, p) => {
  if (
    typeof p !== "string" ||
    p.length === 0 ||
    p.length > 2048 ||
    p.includes("\u0000")
  ) {
    throw new Error("Invalid path")
  }
  const fs = require("fs")
  const homeRelative =
    p === "~"
      ? ""
      : p.startsWith("~/") || p.startsWith("~\\")
        ? p.slice(2)
        : null
  const resolved = path.resolve(
    homeRelative === null
      ? p
      : path.join(app.getPath("home"), homeRelative),
  )
  let initial
  let canonical
  let opened
  try {
    initial = fs.statSync(resolved)
    canonical = fs.realpathSync.native(resolved)
    opened = fs.statSync(canonical)
  } catch {
    throw new Error("Path does not exist or cannot be resolved safely")
  }
  if (
    initial.dev !== opened.dev ||
    initial.ino !== opened.ino ||
    (!opened.isDirectory() && !opened.isFile())
  ) {
    throw new Error("Path changed during validation or has an unsupported type")
  }
  const ext = path.extname(canonical).toLowerCase()
  if (DANGEROUS_OPEN_EXT.has(ext)) {
    throw new Error(`Refusing to open executable path: ${ext}`)
  }
  // Must already exist — `open-path` is for revealing existing user content,
  // not for creating arbitrary directories on disk from renderer input.
  const finalEntry = fs.statSync(canonical)
  if (
    finalEntry.dev !== opened.dev ||
    finalEntry.ino !== opened.ino ||
    finalEntry.isDirectory() !== opened.isDirectory()
  ) {
    throw new Error("Path changed immediately before opening")
  }
  if (opened.isDirectory()) {
    const error = await shell.openPath(canonical)
    if (error) throw new Error(`Could not open directory: ${error}`)
  } else {
    // Revealing a renderer-selected file avoids dispatching it to an
    // associated executable or script handler.
    shell.showItemInFolder(canonical)
  }
})

ipcMain.handle(IpcChannel.PickFolder, async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Project Folder",
  })
  return result.canceled ? null : result.filePaths[0] || null
})

ipcMain.handle(IpcChannel.OpenHtmlPreview, async (event, input) => {
  if (!input || typeof input.projectPath !== "string" || !path.isAbsolute(input.projectPath) ||
      (input.relativePath !== undefined && (typeof input.relativePath !== "string" || path.isAbsolute(input.relativePath)))) {
    throw new TypeError("Choose a project folder and a relative HTML file path.")
  }
  let selected = input.relativePath
  if (selected === undefined) {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = { title: "Preview HTML file", defaultPath: input.projectPath, properties: ["openFile"], filters: [{ name: "HTML files", extensions: ["html", "htm"] }] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { status: "cancelled" }
    selected = result.filePaths[0]
  }
  if (event.sender.isDestroyed()) return { status: "cancelled" }
  const result = await getHtmlPreviews().open(event.sender.id, input.projectPath, selected)
  if (event.sender.isDestroyed()) {
    getHtmlPreviews().revokeOwner(event.sender.id)
    return { status: "cancelled" }
  }
  return result
})

// The global IPC guard restricts this to registered app main frames. Preview
// guests keep their isolated session and never receive this preload API.
const CLIPBOARD_TEXT_MAX_CHARS = 8 * 1024 * 1024

ipcMain.handle(IpcChannel.ClipboardWriteText, (_event, text) => {
  if (typeof text !== "string") throw new TypeError("Clipboard text must be a string.")
  if (text.length > CLIPBOARD_TEXT_MAX_CHARS) {
    throw new Error("Clipboard text exceeds 8 MB.")
  }
  clipboard.writeText(text)
})

ipcMain.handle(IpcChannel.ConfirmDialog, async (event, opts) => {
  const options = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}
  const title = typeof options.title === "string" && options.title.trim()
    ? options.title.slice(0, 200)
    : "Are you sure?"
  const message = typeof options.message === "string" ? options.message.slice(0, 4_000) : ""
  const dialogOptions = {
    type: "warning",
    title,
    message,
    buttons: ["Cancel", "Confirm"],
    defaultId: 0,
    cancelId: 0,
  }
  const parent = BrowserWindow.fromWebContents(event.sender)
  const result = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, dialogOptions)
    : await dialog.showMessageBox(dialogOptions)
  return result.response === 1
})

ipcMain.handle(IpcChannel.ShellCapability, async (_event, scope) => {
  if (!isValidHumanShellCapabilityScope(scope)) {
    throw new Error("Invalid shell capability scope.")
  }
  if (!serverPort || !serverToken) {
    throw new Error("Backend is not ready.")
  }
  const response = await fetch(
    `http://127.0.0.1:${serverPort}/api/v1/shell/capability`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverToken}`,
        "Content-Type": "application/json",
        "X-BetterC0de-Human-Capability": serverToken,
      },
      body: JSON.stringify(scope),
      signal: AbortSignal.timeout(5_000),
    }
  )
  if (!response.ok) {
    throw new Error(`Shell capability request failed (${response.status}).`)
  }
  const payload = await response.json()
  if (!payload || typeof payload.capability !== "string") {
    throw new Error("Backend returned an invalid shell capability.")
  }
  return payload.capability
})

function isValidHumanShellCapabilityScope(scope) {
  if (!scope || typeof scope !== "object") return false
  if (scope.operation === "run") {
    return (
      typeof scope.command === "string" &&
      scope.command.length > 0 &&
      scope.command.length <= 100_000 &&
      typeof scope.cwd === "string" &&
      scope.cwd.length > 0 &&
      scope.cwd.length <= 32_768
    )
  }
  if (scope.operation === "pty-open") {
    return (
      typeof scope.cwd === "string" &&
      scope.cwd.length > 0 &&
      scope.cwd.length <= 32_768 &&
      (scope.sessionId === undefined ||
        (typeof scope.sessionId === "string" && scope.sessionId.length <= 256)) &&
      (scope.command === undefined ||
        (typeof scope.command === "string" && scope.command.length <= 32_768))
    )
  }
  return (
    scope.operation === "pty-write" &&
    typeof scope.sessionId === "string" &&
    scope.sessionId.length > 0 &&
    scope.sessionId.length <= 256 &&
    typeof scope.data === "string" &&
    scope.data.length <= 1_000_000
  )
}

/**
 * Signing posture baked into the packaged `package.json` at build time by
 * `scripts/pack-electron.cjs` (`extraMetadata.betterc0deCodeSigned`).
 * Unpackaged dev runs report false and never reach the update path anyway.
 */
function isCodeSignedBuild() {
  try {
    const meta = require(path.join(app.getAppPath(), "package.json"))
    return meta?.betterc0deCodeSigned === true
  } catch {
    return false
  }
}

/** Surfaced through `app:info` so the UI can tell the user updates are off. */
let updatesDisabledReason = null

function scheduleUpdateCheck() {
  if (!app.isPackaged) {
    console.log("[electron] skipping update check — not a packaged build")
    return
  }
  // Windows builds are unsigned by default. electron-updater would download
  // the new installer, attempt to launch it, and Windows SmartScreen would
  // re-warn — users perceive that as "the update is broken". Skip the check
  // entirely on unsigned Windows builds.
  //
  // This used to read `process.env.WIN_CSC_LINK`, which is a BUILD-time
  // variable: in an installed app it is never set, so the condition was always
  // true and EVERY shipped Windows build silently never checked for updates,
  // including security fixes. The signing posture is now baked into the
  // packaged package.json by `scripts/pack-electron.cjs` so it survives
  // packaging and can be read at runtime.
  if (process.platform === "win32" && !isCodeSignedBuild()) {
    console.log(
      "[electron] skipping update check — this Windows build is unsigned; configure WIN_CSC_LINK at build time to enable auto-update.",
    )
    // Reported through `app:info` rather than the backend-status channel —
    // that channel drives the bootstrap splash state machine and does not
    // model update state.
    updatesDisabledReason = "unsigned-build"
    return
  }

  if (!loadAutoUpdater()) {
    updatesDisabledReason = "updater-unavailable"
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("update-available", (info) => {
    console.log(
      "[electron] update available:",
      info && info.version ? info.version : "(unknown version)",
    )
  })
  autoUpdater.on("update-not-available", () => {
    console.log("[electron] up to date")
  })
  autoUpdater.on("update-downloaded", (info) => {
    console.log(
      "[electron] update downloaded:",
      info && info.version ? info.version : "(unknown version)",
      "— will install on next quit",
    )
  })
  autoUpdater.on("error", (err) => {
    // Network failures, missing release feed, unsigned builds — all land
    // here.  Never let an update error crash the app.
    console.warn(
      "[electron] update check failed:",
      err && err.message ? err.message : err,
    )
  })

  // Fire-and-forget: a failure here is already caught by the "error"
  // listener above; the `.catch` is defensive against the promise being
  // rejected synchronously before the listener attaches.
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.warn(
      "[electron] initial update check rejected:",
      err && err.message ? err.message : err,
    )
  })
}

app.whenReady().then(async () => {
  try {
    getAppDiagnostics()
    resumeCliProcessAdmissions()
    // Voice input needs audio from a registered app main frame. Deny camera,
    // subframe and unknown-context requests, including permission checks that
    // Chromium may perform without calling the request handler.
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        callback(permission === "media"
          && isTrustedRendererPermission(webContents, details, getRendererSecurityPolicy())
          && Array.isArray(details.mediaTypes)
          && details.mediaTypes.length > 0
          && details.mediaTypes.every((type) => type === "audio"))
      },
    )
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, _origin, details) => permission === "media"
        && isTrustedRendererPermission(webContents, details, getRendererSecurityPolicy())
        && details.mediaType === "audio",
    )
    for (const partition of [PREVIEW_SESSION_PARTITION, CANVAS_PREVIEW_PARTITION]) {
      const previewSession = session.fromPartition(partition)
      previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      previewSession.setPermissionCheckHandler(() => false)
      previewSession.protocol.handle("betterc0de-html", (request) => getHtmlPreviews().handle(request))
      installPreviewRequestCapture(previewSession, (entry) => broadcast(IpcEvent.PreviewRequest, entry))
    }

    // Must run before startBackend() so the backend fork inherits the
    // encryption key through its environment — without it the backend
    // boots in plaintext-fallback mode.
    settingsEncryptionKey = ensureSettingsEncryptionKey()
    setPluginEncryptionKey(settingsEncryptionKey)

    await installDefaultPlugins()
    await registerPluginHandlers()
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

    // The window is created BEFORE the backend so the renderer's boot (a
    // multi-megabyte parse) overlaps the backend's boot and health probe
    // instead of queueing behind it. The renderer is built for this: it polls
    // `window.__BETTERC0DE__.port` before loading threads or opening the
    // WebSocket, so it simply waits out a backend that is not up yet.
    createWindow()
    await startBackend()
    // The first config injection (on `did-finish-load`) necessarily carried
    // no port. Push the real one now, or the renderer would poll forever.
    await syncRuntimeConfigToRenderers()
    startBackendDevReloader()

    setPluginWindow(mainWindow)

    // Kick off the update check AFTER the window is shown so a slow
    // network probe never delays first paint.
    scheduleUpdateCheck()
    if (!isAppQuitting && process.env.BETTERC0DE_DISABLE_PING !== "1") {
      stopAppPing = require("./shared/app-ping.cjs").startAppPing({
        dataDir: require("./shared/runtime-paths.cjs").getBaseDir(),
        appVersion: app.getVersion(),
      })
    }
  } catch (err) {
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

app.on("window-all-closed", () => {
  requestApplicationQuit("all windows closed")
})

app.on("before-quit", (event) => {
  if (applicationShutdownComplete) return
  event.preventDefault()
  requestApplicationQuit("quit requested")
})

mainModuleReady = true
