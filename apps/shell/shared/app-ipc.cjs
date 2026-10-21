/**
 * App-level IPC handlers: window controls, app info and runtime config,
 * bug reports, backend restart, external links and paths, the folder
 * picker, HTML previews, clipboard, confirm dialogs, the preview request
 * feed, shell capabilities and renderer client instances.
 *
 * Every handler goes through `registerHandler` (shared/trusted-ipc.cjs), so
 * the sender is checked against the trusted-renderer policy before it runs.
 * main.cjs calls `registerAppIpcHandlers` once, at load, with the parts of
 * the main process the handlers need.
 */

const path = require("path")
const { IpcChannel } = require("./ipc-contract.cjs")
const { ok } = require("./ipc-envelope.cjs")
const { registerHandler } = require("./trusted-ipc.cjs")
const { getBackendConnection } = require("./backend-endpoint.cjs")
const { isAllowedExternalUrl } = require("./urlPolicy.cjs")
const { normalizeHumanShellCapabilityScope } = require("./shell-capability-scope.cjs")

// Extensions the OS auto-executes via `shell.openPath` — explicitly refused
// to prevent a compromised renderer from triggering code execution via file
// association.
const DANGEROUS_OPEN_EXT = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".lnk", ".pif",
  ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
  ".hta", ".reg", ".jar", ".app", ".dmg", ".pkg", ".sh", ".bash",
])

// The global IPC guard restricts this to registered app main frames. Preview
// guests keep their isolated session and never receive this preload API.
const CLIPBOARD_TEXT_MAX_CHARS = 8 * 1024 * 1024
// Reading the clipboard follows a click or key press in the asking window
// (the terminal's right-click paste), never a page reading it on its own.
const CLIPBOARD_READ_INPUT_WINDOW_MS = 2_000

// A capability lets the renderer run one command or terminal operation. A
// hook command the user approved in the native dialog when saving it
// (hooks-ipc) needs no fresh input, so automatic hooks can run. Anything else
// must follow real input to the requesting window within this time.
const SHELL_CAPABILITY_INPUT_WINDOW_MS = 10_000

// What a terminal answers when a program asks it something: cursor position,
// device attributes, status, mode and colour reports. The terminal writes
// them by itself, often long after the last key press, so they cannot follow
// real input. None of them holds a line break or free text, so none can
// submit or spell out a command.
const TERMINAL_REPLY =
  /\x1b\[\??\d{1,5};\d{1,5}(?:;\d{1,5})?R|\x1b\[[?>]?\d{0,5}(?:;\d{1,5}){0,16}c|\x1b\[[03]n|\x1b\[\??\d{1,5};\d\$y|\x1b\]\d{1,3}(?:;\d{1,3})?;rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\)/y
const TERMINAL_REPLY_MAX_CHARS = 512

/** Whether `data` is nothing but terminal replies (see TERMINAL_REPLY). */
function isTerminalReply(data) {
  if (typeof data !== "string" || !data || data.length > TERMINAL_REPLY_MAX_CHARS) {
    return false
  }
  TERMINAL_REPLY.lastIndex = 0
  while (TERMINAL_REPLY.lastIndex < data.length) {
    const start = TERMINAL_REPLY.lastIndex
    if (!TERMINAL_REPLY.test(data) || TERMINAL_REPLY.lastIndex === start) return false
  }
  return true
}

/**
 * Whether the main process grants a shell capability for `scope`: an
 * approved hook command, a terminal's own reply to a program's query, or real
 * input (observed by the main process) to the requesting window moments ago.
 *
 * @param {{ sender?: unknown } | undefined} event
 * @param {{ operation: string, command?: string }} scope
 * @param {object} deps
 * @param {(command: unknown) => boolean} deps.isApprovedHookCommand
 * @param {{ hasRecentInput(contents: unknown, windowMs: number): boolean }} deps.inputTracker
 */
function isShellCapabilityAuthorized(event, scope, { isApprovedHookCommand, inputTracker }) {
  if (scope.operation === "run" && isApprovedHookCommand(scope.command)) return true
  if (scope.operation === "pty-write" && isTerminalReply(scope.data)) return true
  return inputTracker.hasRecentInput(event?.sender, SHELL_CAPABILITY_INPUT_WINDOW_MS)
}

/**
 * Validate a renderer-supplied `cwd` for a secondary window: an existing
 * directory inside the user's home, resolved through symlinks. Returns the
 * canonical path, or undefined.
 */
function resolveSecondaryWindowCwd(cwdRaw, { getHome, fsImpl = require("node:fs") }) {
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
      const fsLocal = fsImpl
      const resolved = path.resolve(cwdRaw)
      const initial = fsLocal.statSync(resolved)
      const canonical = fsLocal.realpathSync.native(resolved)
      const canonicalHome = fsLocal.realpathSync.native(getHome())
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
  return cwd
}

/**
 * Validate a renderer-supplied path for `open-path` and return what to open:
 * the canonical path and whether it is a directory. Throws for anything
 * unsafe (invalid input, a path that changes during validation, executable
 * file types).
 */
function resolveOpenPathTarget(p, { getHome, fsImpl = require("fs") }) {
  if (
    typeof p !== "string" ||
    p.length === 0 ||
    p.length > 2048 ||
    p.includes("\u0000")
  ) {
    throw new Error("Invalid path")
  }
  const fs = fsImpl
  const homeRelative =
    p === "~"
      ? ""
      : p.startsWith("~/") || p.startsWith("~\\")
        ? p.slice(2)
        : null
  const resolved = path.resolve(
    homeRelative === null
      ? p
      : path.join(getHome(), homeRelative),
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
  return { canonical, isDirectory: opened.isDirectory() }
}

/**
 * Ask the backend to end the terminals and shell runs one page load started
 * (`POST /shell/client/release`). Nothing to do while the backend is down: a
 * backend that stopped took its terminals with it.
 */
async function releaseRendererShellResources(clientInstanceId, reason, { isQuitting, fetchImpl = fetch, log = console }) {
  const connection = getBackendConnection()
  const serverPort = connection?.port
  const serverToken = connection?.token
  if (!serverPort || !serverToken || isQuitting()) return
  const response = await fetchImpl(
    `http://127.0.0.1:${serverPort}/api/v1/shell/client/release`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientInstanceId }),
      signal: AbortSignal.timeout(5_000),
    },
  )
  if (!response.ok) {
    throw new Error(`release request failed (${response.status})`)
  }
  const result = await response.json().catch(() => null)
  const terminals = Number(result?.terminals) || 0
  const runs = Number(result?.runs) || 0
  if (terminals > 0 || runs > 0) {
    log.log(
      `[electron] Ended ${terminals} terminal(s) and ${runs} shell run(s) of a renderer (${reason})`,
    )
  }
}

/**
 * Register the app-level handlers. Call once.
 *
 * @param {object} deps
 * @param {{ app: any, BrowserWindow: any, clipboard: any, dialog: any, shell: any }} [deps.electron]
 * @param {() => any} deps.getMainWindow
 * @param {(options: { mode?: string, cwd?: string }) => unknown} deps.openSecondaryWindow
 * @param {() => boolean} deps.areRendererDevToolsAllowed
 * @param {() => boolean} deps.getSecretsEncryptionAvailable
 * @param {() => string} deps.getApplicationLogsDir
 * @param {() => string | null} deps.getUpdatesDisabledReason
 * @param {() => object} deps.getUpdateStatus
 * @param {() => object} deps.getRuntimeConfig
 * @param {() => { sendReport(report: unknown): Promise<unknown> }} deps.getAppDiagnostics
 * @param {() => { onManualRestart(): void }} deps.getBackendSupervisor
 * @param {(reason: string) => Promise<{ port: number }>} deps.restartBackend
 * @param {() => any} deps.getHtmlPreviews
 * @param {() => { setSubscribed(contents: unknown, subscribed: boolean): void }} deps.getPreviewRequestFeed
 * @param {() => { hasRecentInput(contents: unknown, windowMs: number): boolean }} deps.getUserInputTracker
 * @param {(command: unknown) => boolean | Promise<boolean>} deps.isApprovedHookCommand
 *   Whether an enabled hook stores exactly this command with a valid approval
 *   (hooks-ipc.cjs; it reads hooks.json from the backend).
 * @param {() => boolean} deps.isQuitting
 */
function registerAppIpcHandlers(deps) {
  const {
    electron = require("electron"),
    getMainWindow,
    openSecondaryWindow,
    areRendererDevToolsAllowed,
    getSecretsEncryptionAvailable,
    getApplicationLogsDir,
    getUpdatesDisabledReason,
    getUpdateStatus,
    getRuntimeConfig,
    getAppDiagnostics,
    getBackendSupervisor,
    restartBackend,
    getHtmlPreviews,
    getPreviewRequestFeed,
    getUserInputTracker,
    isApprovedHookCommand,
    isQuitting,
  } = deps
  const { app, BrowserWindow, clipboard, dialog, shell } = electron

  registerHandler(IpcChannel.WindowMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  registerHandler(IpcChannel.WindowMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  registerHandler(IpcChannel.WindowClose, (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  registerHandler(IpcChannel.WindowIsMaximized, (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
  registerHandler(IpcChannel.WindowOpenWith, async (_event, opts = {}) => {
    // Renderer-supplied opts arrive shaped as `{mode?, cwd?}`. Sanitize
    // both fields here — `mode` is whitelisted to the known values,
    // and `cwd` is forced to a string + length-capped so a hostile
    // renderer can't push a multi-megabyte URL hash that crashes
    // electron's URL parser.
    const mode = opts.mode === "editor" || opts.mode === "agent" || opts.mode === "design" ? opts.mode : undefined
    const cwdRaw = typeof opts.cwd === "string" ? opts.cwd : ""
    const cwd = resolveSecondaryWindowCwd(cwdRaw, { getHome: () => app.getPath("home") })
    try {
      openSecondaryWindow({ mode, cwd })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Refused (false) in packaged builds unless BETTERC0DE_ENABLE_DEVTOOLS=1.
  registerHandler(IpcChannel.WindowToggleDevTools, (event) => {
    if (!areRendererDevToolsAllowed()) return false
    BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools()
    return true
  })

  registerHandler(IpcChannel.AppInfo, () => ({
    isPackaged: app.isPackaged,
    baseDirName: path.basename(require("./runtime-paths.cjs").getBaseDir()),
    baseDir: require("./runtime-paths.cjs").getBaseDir(),
    // S4: surface OS-keyring availability to the renderer so the UI can warn
    // the user when provider API keys are stored unencrypted (typical on
    // Linux without gnome-keyring/kwallet, headless containers, WSL).
    secretsEncryptionAvailable: getSecretsEncryptionAvailable(),
    platform: process.platform,
    appVersion: app.getVersion(),
    // Where app.log lives, for Settings → General → Privacy → Open logs folder.
    logsDir: (() => {
      try { return getApplicationLogsDir() } catch { return null }
    })(),
    // Null when updates install automatically. A non-null reason means this
    // install cannot install updates by itself (Settings → General → Updates
    // explains why and links to the download).
    updatesDisabledReason: getUpdatesDisabledReason(),
    updates: getUpdateStatus(),
  }))

  registerHandler(IpcChannel.RuntimeConfigGet, () => getRuntimeConfig())

  registerHandler(IpcChannel.BugReportSend, (_, report) => {
    return getAppDiagnostics().sendReport(report)
  })

  registerHandler(IpcChannel.BackendRestart, async () => {
    // Explicit user action (Restart backend banner, remote-access changes):
    // clears the crash-loop history and any pending automatic restart.
    getBackendSupervisor().onManualRestart()
    const started = await restartBackend("requested from the app")
    return { port: started.port }
  })

  registerHandler(IpcChannel.OpenExternal, async (_, url) => {
    if (typeof url === "string" && isAllowedExternalUrl(url, app.isPackaged)) {
      await shell.openExternal(url)
      return ok()
    }
    throw new Error("Blocked external URL")
  })

  registerHandler(IpcChannel.OpenPath, async (_, p) => {
    const { canonical, isDirectory } = resolveOpenPathTarget(p, { getHome: () => app.getPath("home") })
    if (isDirectory) {
      const error = await shell.openPath(canonical)
      if (error) throw new Error(`Could not open directory: ${error}`)
    } else {
      // Revealing a renderer-selected file avoids dispatching it to an
      // associated executable or script handler.
      shell.showItemInFolder(canonical)
    }
  })

  registerHandler(IpcChannel.PickFolder, async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ["openDirectory"],
      title: "Select Project Folder",
    })
    return result.canceled ? null : result.filePaths[0] || null
  })

  registerHandler(IpcChannel.OpenHtmlPreview, async (event, input) => {
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

  registerHandler(IpcChannel.ClipboardWriteText, (_event, text) => {
    if (typeof text !== "string") throw new TypeError("Clipboard text must be a string.")
    if (text.length > CLIPBOARD_TEXT_MAX_CHARS) {
      throw new Error("Clipboard text exceeds 8 MB.")
    }
    clipboard.writeText(text)
  })

  registerHandler(IpcChannel.ClipboardReadText, (event) => {
    if (!getUserInputTracker().hasRecentInput(event?.sender, CLIPBOARD_READ_INPUT_WINDOW_MS)) {
      throw new Error("Pasting needs a recent click or key press in BetterC0de.")
    }
    const text = clipboard.readText()
    if (text.length > CLIPBOARD_TEXT_MAX_CHARS) {
      throw new Error("Clipboard text exceeds 8 MB.")
    }
    return text
  })

  registerHandler(IpcChannel.ConfirmDialog, async (event, opts) => {
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

  // A window's runtime pane subscribes to its preview guests' request feed.
  registerHandler(IpcChannel.PreviewRequestSubscribe, (event, subscribed) => {
    if (typeof subscribed !== "boolean") {
      throw new TypeError("Preview request subscription must be true or false.")
    }
    getPreviewRequestFeed().setSubscribed(event.sender, subscribed)
  })

  registerHandler(IpcChannel.ShellCapability, async (event, requested) => {
    // Rebuilt from known fields; run and PTY scopes carry the launch (shell,
    // PTY arguments, environment) the backend binds the capability to.
    const scope = normalizeHumanShellCapabilityScope(requested)
    if (!scope) {
      throw new Error("Invalid shell capability scope.")
    }
    // The decision is made here, from what this process observed: an approved
    // hook command, or real input to the requesting window moments ago. The
    // hooks are read from the backend (hooks.json), so that answer is looked
    // up first; unreadable hooks approve nothing.
    const approvedHookCommand =
      scope.operation === "run" && (await isApprovedHookCommand(scope.command)) === true
    if (!isShellCapabilityAuthorized(event, scope, {
      isApprovedHookCommand: () => approvedHookCommand,
      inputTracker: getUserInputTracker(),
    })) {
      throw new Error(
        "This command needs a recent click or key press in BetterC0de. Automatic hooks run without one once their command is approved (save the hook again).",
      )
    }
    const connection = getBackendConnection()
    const serverPort = connection?.port
    const serverToken = connection?.token
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

  // ── Renderer client instances (terminal ownership per page load) ─────────
  let rendererClientInstances = null
  function getRendererClientInstances() {
    rendererClientInstances ??= require("./renderer-client-instances.cjs")
      .createRendererClientInstances({
        release: (clientInstanceId, reason) =>
          releaseRendererShellResources(clientInstanceId, reason, { isQuitting }),
      })
    return rendererClientInstances
  }

  registerHandler(IpcChannel.RendererClientInstance, (event, clientInstanceId) => {
    getRendererClientInstances().register(event.sender, clientInstanceId)
  })
}

module.exports = {
  CLIPBOARD_TEXT_MAX_CHARS,
  DANGEROUS_OPEN_EXT,
  SHELL_CAPABILITY_INPUT_WINDOW_MS,
  isShellCapabilityAuthorized,
  isTerminalReply,
  registerAppIpcHandlers,
  releaseRendererShellResources,
  resolveOpenPathTarget,
  resolveSecondaryWindowCwd,
}
