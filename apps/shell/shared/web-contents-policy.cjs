/**
 * Security policy for the webContents the app creates: app windows, the
 * preview <webview> guests they host, and the sessions behind both.
 *
 * - `hardenWebContents` is applied to every webContents from the
 *   app-level "web-contents-created" event (main.cjs).
 * - `attachWebviewPolicy` is applied to every app window and forces each
 *   <webview> it attaches into a hardened, sandboxed preview session.
 * - `installDefaultSessionPermissionHandlers` / `denyAllPermissions` decide
 *   permission requests (microphone for voice input; nothing for previews).
 * - `createPreviewGuestSenderValidator` is the IPC sender policy for the
 *   app's own preview preload.
 *
 * Everything Electron-specific is passed in, so tests drive these functions
 * with plain objects.
 */

const path = require("path")
const { IpcEvent } = require("./ipc-contract.cjs")
const {
  forcePreviewPartition,
  isAllowedWebviewUrl,
  isTrustedRendererPermission,
} = require("./urlPolicy.cjs")

// ── Webview attach policy ────────────────────────────────────────────────
// Webviews are force-hardened (no node, isolated, sandboxed) and any
// renderer-supplied preload is stripped — EXCEPT the app's own
// browser-preview preload, which carries the element-inspector bridge
// (window.cursorBrowser) used by the editor preview and the design-mode
// canvas. Canvas guests always receive our own gesture/inspector bridge;
// other guests require an exact preload path match. Never trust a supplied path.
const PREVIEW_PRELOAD_PATH = path.join(__dirname, "..", "browser-preview-preload.cjs")

// ── Renderer DevTools ────────────────────────────────────────────────────
// DevTools on an app window can drive every bridge that window has (plugin
// install, hook and MCP writes, shell capabilities), and "paste this into the
// console" is a known social-engineering trick. Development runs always allow
// them; a packaged build only when started with BETTERC0DE_ENABLE_DEVTOOLS=1.
// Preview guests (the user's own pages) keep their DevTools either way.
function areRendererDevToolsAllowed({ isPackaged, env = process.env }) {
  return !isPackaged || env.BETTERC0DE_ENABLE_DEVTOOLS === "1"
}

function isDevToolsShortcut(input) {
  if (input?.type !== "keyDown") return false
  const key = String(input.key || "")
  return key === "F12" || Boolean((input.control || input.meta) && input.shift && key.toLowerCase() === "i")
}

// ── Global webContents hardening ─────────────────────────────────────────
/** Navigations a preview guest's page may start on its own. */
function isAllowedGuestNavigationUrl(rawUrl) {
  if (rawUrl === "about:blank" || rawUrl === "about:srcdoc") return true
  if (isAllowedWebviewUrl(rawUrl)) return true
  try {
    // blob: documents a previewed page created itself (exports, reports).
    const parsed = new URL(rawUrl)
    return parsed.protocol === "blob:" && isAllowedWebviewUrl(parsed.pathname)
  } catch {
    return false
  }
}

function isOwnPreviewPreload(requested, { platform = process.platform } = {}) {
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
  return platform === "win32"
    ? resolved.toLowerCase() === expected.toLowerCase()
    : resolved === expected
}

/**
 * @param {object} options
 * @param {string} options.previewPartition Session partition of editor-browser guests.
 * @param {string} options.canvasPartition Session partition of design-canvas guests.
 * @param {() => { track(contents: unknown): void }} options.getUserInputTracker
 * @param {() => { trackGuest(contents: unknown): void }} options.getPreviewPartitionJanitor
 * @param {() => { forget(contents: unknown): void }} options.getPreviewGuestGate
 * @param {() => boolean} options.areRendererDevToolsAllowed
 */
function createWebContentsPolicy({
  previewPartition,
  canvasPartition,
  getUserInputTracker,
  getPreviewPartitionJanitor,
  getPreviewGuestGate,
  areRendererDevToolsAllowed: devToolsAllowed,
}) {
  /**
   * Applied to every webContents the app creates, before any creation site adds
   * its own listeners, so a new window or guest is safe by default:
   *  - popups are denied; app windows replace this with their own handler
   *    (allowed external links open in the system browser);
   *  - preview guests may only navigate, or be redirected, to what a preview can
   *    show (http, https, issued HTML previews, their own blob: documents),
   *    never to file:, chrome:, devtools: or similar;
   *  - packaged app windows close DevTools opened without the debug switch.
   */
  function hardenWebContents(contents) {
    let type = ""
    try {
      type = contents.getType()
    } catch {
      type = ""
    }
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    if (type === "window") {
      getUserInputTracker().track(contents)
      contents.on("devtools-opened", () => {
        if (!devToolsAllowed()) contents.closeDevTools()
      })
      return
    }
    if (type !== "webview") return
    const refuseNavigation = (event, url) => {
      if (event?.isMainFrame === false) return
      const target = typeof url === "string" ? url : event?.url
      if (!isAllowedGuestNavigationUrl(String(target || ""))) event.preventDefault()
    }
    contents.on("will-navigate", refuseNavigation)
    contents.on("will-redirect", refuseNavigation)
    getUserInputTracker().track(contents)
    getPreviewPartitionJanitor().trackGuest(contents)
    contents.once("destroyed", () => getPreviewGuestGate().forget(contents))
  }

  function attachWebviewPolicy(contents) {
    // Tell the hosting window when one of its preview guests is gone, so the
    // renderer drops what it keeps per guest id (request buffers). The
    // viewport that owned the guest normally does this itself; this covers a
    // guest that died without its viewport noticing.
    contents.on("did-attach-webview", (_event, guest) => {
      let guestId
      try {
        guestId = guest.id
      } catch {
        return
      }
      guest.once("destroyed", () => {
        if (contents.isDestroyed()) return
        try {
          contents.send(IpcEvent.PreviewGuestDestroyed, { webContentsId: guestId })
        } catch {
          // The host is closing as well.
        }
      })
    })
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
      const canvas = params?.partition === canvasPartition
      forcePreviewPartition(webPreferences, params, canvas ? canvasPartition : previewPartition)
      webPreferences.additionalArguments = canvas ? ["--betterc0de-canvas-preview"] : []
      delete webPreferences.preload
      delete webPreferences.preloadURL
      if (canvas || isOwnPreviewPreload(requestedPreload)) {
        webPreferences.preload = PREVIEW_PRELOAD_PATH
      }
    })
  }

  return { hardenWebContents, attachWebviewPolicy }
}

/**
 * A registered app main frame may use voice input (audio only) and system
 * notifications for finished chats, approvals and errors. Deny camera,
 * subframe and unknown-context requests, including permission checks that
 * Chromium may perform without calling the request handler.
 */
function installDefaultSessionPermissionHandlers(defaultSession, getRendererSecurityPolicy) {
  defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const allowedKind = permission === "notifications"
        || (permission === "media"
          && Array.isArray(details.mediaTypes)
          && details.mediaTypes.length > 0
          && details.mediaTypes.every((type) => type === "audio"))
      callback(allowedKind
        && isTrustedRendererPermission(webContents, details, getRendererSecurityPolicy()))
    },
  )
  defaultSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) => (permission === "notifications"
      || (permission === "media" && details.mediaType === "audio"))
      && isTrustedRendererPermission(webContents, details, getRendererSecurityPolicy()),
  )
}

/** Preview sessions show the user's own pages: they get no permission at all. */
function denyAllPermissions(previewSession) {
  previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  previewSession.setPermissionCheckHandler(() => false)
}

/**
 * The app's preview preload inside a <webview> guest of a trusted window, in
 * one of the two preview sessions. Only handlers registered for that preload
 * accept it.
 *
 * @param {object} options
 * @param {() => unknown[]} options.getPreviewSessions The two preview sessions.
 * @param {Set<number>} options.trustedWebContentsIds Registered app windows.
 */
function createPreviewGuestSenderValidator({ getPreviewSessions, trustedWebContentsIds }) {
  return (event, channel) => {
    const guest = event?.sender
    let host = null
    let guestSession = null
    try {
      host = guest?.hostWebContents || null
      guestSession = guest?.session || null
    } catch {
      host = null
    }
    const previewSessions = getPreviewSessions()
    if (
      !guest ||
      guest.isDestroyed?.() ||
      guest.getType?.() !== "webview" ||
      !host ||
      !trustedWebContentsIds.has(host.id) ||
      !previewSessions.includes(guestSession) ||
      (event.senderFrame && event.senderFrame.parent)
    ) {
      throw new Error(`Rejected IPC from untrusted sender for ${channel}`)
    }
  }
}

module.exports = {
  PREVIEW_PRELOAD_PATH,
  areRendererDevToolsAllowed,
  createPreviewGuestSenderValidator,
  createWebContentsPolicy,
  denyAllPermissions,
  installDefaultSessionPermissionHandlers,
  isAllowedGuestNavigationUrl,
  isDevToolsShortcut,
  isOwnPreviewPreload,
}
