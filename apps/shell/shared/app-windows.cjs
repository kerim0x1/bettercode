/**
 * The app's BrowserWindows: the main window, secondary windows opened by
 * `window:open-with`, and the crash/hang/session-end handling both share.
 *
 * Holds the current main window (`getMainWindow`). Everything the windows
 * need from the rest of the main process — trusted-renderer registration,
 * the webview attach policy, DevTools gating, the quit path — is passed in by
 * main.cjs.
 */

const path = require("path")
const appConfig = require("./appConfig.cjs")
const {
  isAllowedExternalUrl,
  isAllowedFrameNavigation,
  isAllowedNavigationUrl,
} = require("./urlPolicy.cjs")

const PRELOAD_PATH = path.join(__dirname, "..", "preload.cjs")

/**
 * @param {object} deps
 * @param {{ app: any, BrowserWindow: any, dialog: any, shell: any }} [deps.electron]
 * @param {ReturnType<typeof import("./window-state.cjs").createWindowStateStore>} deps.windowState
 * @param {(contents: any) => void} deps.registerTrustedRendererContents
 * @param {(contents: any) => void} deps.attachWebviewPolicy
 * @param {() => object} deps.getRendererSecurityPolicy
 * @param {() => boolean} deps.areRendererDevToolsAllowed
 * @param {(input: any) => boolean} deps.isDevToolsShortcut
 * @param {() => boolean} deps.isQuitting
 * @param {(reason: string) => void} deps.requestApplicationQuit
 * @param {() => void} deps.flushLogs Writes buffered log lines synchronously.
 * @param {{ setTimeout: typeof setTimeout }} [deps.timers]
 */
function createAppWindows({
  electron = require("electron"),
  windowState,
  registerTrustedRendererContents,
  attachWebviewPolicy,
  getRendererSecurityPolicy,
  areRendererDevToolsAllowed,
  isDevToolsShortcut,
  isQuitting,
  requestApplicationQuit,
  flushLogs = () => {},
  timers = { setTimeout },
}) {
  const { app, BrowserWindow, dialog, shell } = electron
  let mainWindow = null

  /**
   * Track every secondary window we've spawned so they don't get
   * garbage-collected, and so the per-window webContents listeners can
   * fire devtools toggling / external-link forwarding the same way the
   * primary window does.
   */
  const secondaryWindows = new Set()

  function createWindow() {
    const isDev = !app.isPackaged
    const isMac = process.platform === "darwin"
    const savedState = windowState.loadWindowState()

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
        preload: PRELOAD_PATH,
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
    timers.setTimeout(() => showOnce("timeout"), appConfig.WINDOW_READY_TO_SHOW_FALLBACK_MS)

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
          timers.setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return
            const vitePort = process.env.VITE_DEV_PORT || appConfig.VITE_DEV_PORT_FALLBACK
            mainWindow.loadURL(`http://localhost:${vitePort}`)
          }, DEV_LOAD_RETRY_DELAY_MS)
          return
        }
        const msg = `Renderer failed to load: ${errorDescription} (${errorCode}) — ${validatedURL}`
        console.error(`[electron] ${msg}`)
        showOnce("did-fail-load")
        // Asynchronous, unlike showErrorBox: a modal error box blocks the whole
        // main process, including backend auth injection for other windows.
        const win = mainWindow
        void dialog.showMessageBox(win, {
          type: "error",
          title: "BetterC0de",
          message: "BetterC0de could not load its window.",
          detail: msg,
          buttons: ["Reload", "Close Window"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        }).then(({ response }) => {
          if (!win || win.isDestroyed()) return
          if (response === 0) win.webContents.reload()
          else win.close()
        }).catch(() => {})
      },
    )

    // Crash and hang recovery (reload, unresponsive prompt) shared with
    // secondary windows.
    attachWindowLifecycle(mainWindow, { onProblem: (reason) => showOnce(reason) })
    attachSessionEndHandlers(mainWindow)

    // DevTools shortcut (packaged builds have no default menu, hence no F12
    // binding). Packaged builds honour it only with BETTERC0DE_ENABLE_DEVTOOLS=1
    // (see areRendererDevToolsAllowed).
    mainWindow.webContents.on("before-input-event", (_event, input) => {
      if (isDevToolsShortcut(input) && areRendererDevToolsAllowed()) {
        mainWindow?.webContents.toggleDevTools()
      }
    })

    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: "right" })
    }

    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigationUrl(url, getRendererSecurityPolicy())) {
        event.preventDefault()
      }
    })
    // A visual reply's frame stays on its page (urlPolicy.cjs).
    mainWindow.webContents.on("will-frame-navigate", (event) => {
      if (!isAllowedFrameNavigation(event, getRendererSecurityPolicy())) {
        event.preventDefault()
      }
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

    // The renderer asks for its runtime config over IPC (`runtime:config`);
    // nothing is injected into the page.
    mainWindow.webContents.on("did-finish-load", () => {
      devLoadRetries = 0
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
    const persist = () => windowState.saveWindowStateDebounced(mainWindow)
    mainWindow.on("resize", persist)
    mainWindow.on("move", persist)
    mainWindow.on("maximize", persist)
    mainWindow.on("unmaximize", persist)
    mainWindow.on("close", () => {
      windowState.cancelPendingSave()
      windowState.writeWindowState(windowState.captureWindowState(mainWindow))
    })

    const createdWindow = mainWindow
    mainWindow.on("closed", () => {
      if (mainWindow === createdWindow) mainWindow = null
    })
  }

  /**
   * Renderer crash and hang handling for every app window.
   *
   * - A crash reloads the window once on its own. A second crash within
   *   RENDERER_CRASH_WINDOW_MS asks first, so a page that crashes on load does
   *   not loop.
   * - A hung renderer gets a non-blocking Wait / Reload prompt that closes by
   *   itself when the page responds again.
   *
   * Every prompt is asynchronous: a modal `showErrorBox` would block the main
   * process (and with it backend auth for all windows) while open.
   */
  function attachWindowLifecycle(win, { onProblem = () => {} } = {}) {
    const contents = win.webContents
    let crashTimes = []
    let intentionalCrash = false
    let unresponsivePrompt = null

    const reload = () => {
      if (!win.isDestroyed()) contents.reload()
    }

    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || isQuitting() || win.isDestroyed()) return
      unresponsivePrompt?.abort()
      if (intentionalCrash) {
        // The user chose Reload on a hung window; the crash was ours.
        intentionalCrash = false
        reload()
        return
      }
      const msg = `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`
      console.error(`[electron] ${msg}`)
      onProblem("render-process-gone")
      const now = Date.now()
      crashTimes = crashTimes.filter((time) => now - time < appConfig.RENDERER_CRASH_WINDOW_MS)
      crashTimes.push(now)
      if (crashTimes.length === 1) {
        console.warn("[electron] Reloading the window after a renderer crash")
        reload()
        return
      }
      void dialog.showMessageBox(win, {
        type: "error",
        title: "BetterC0de",
        message: "This window stopped working again.",
        detail: `${msg}\n\nReload the window to continue. Your chats and files are kept by the backend.`,
        buttons: ["Reload", "Close Window"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => {
        if (win.isDestroyed()) return
        if (response === 0) reload()
        else win.close()
      }).catch(() => {})
    })

    contents.on("unresponsive", () => {
      if (unresponsivePrompt || isQuitting() || win.isDestroyed()) return
      console.warn("[electron] Window is not responding")
      const controller = new AbortController()
      unresponsivePrompt = controller
      void dialog.showMessageBox(win, {
        type: "warning",
        title: "BetterC0de",
        message: "This window is not responding.",
        detail: "You can wait for it to recover or reload it. Reloading discards unsaved text in this window.",
        buttons: ["Wait", "Reload"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: controller.signal,
      }).then(({ response }) => {
        if (response !== 1 || controller.signal.aborted || win.isDestroyed()) return
        console.warn("[electron] Reloading the unresponsive window")
        // A hung renderer cannot run unload handlers; end it, then reload.
        intentionalCrash = true
        contents.forcefullyCrashRenderer()
      }).catch(() => {}).finally(() => {
        if (unresponsivePrompt === controller) unresponsivePrompt = null
      })
    })

    contents.on("responsive", () => {
      if (!unresponsivePrompt) return
      console.log("[electron] Window is responding again")
      unresponsivePrompt.abort()
      unresponsivePrompt = null
    })
  }

  /**
   * Windows logoff, shutdown and update restarts end the session without
   * `before-quit`. Start the graceful shutdown (backend IPC stop: flush event
   * logs, close SQLite) as soon as Windows asks, instead of being hard-killed
   * with the job object. Best effort: Windows bounds how long it waits.
   */
  function attachSessionEndHandlers(win) {
    if (process.platform !== "win32") return
    win.on("query-session-end", () => {
      console.log("[electron] Windows session is ending; shutting down")
      requestApplicationQuit("Windows session ending")
    })
    win.on("session-end", () => {
      requestApplicationQuit("Windows session ended")
      try { flushLogs() } catch { /* best effort */ }
    })
  }

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
        preload: PRELOAD_PATH,
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
    timers.setTimeout(showOnce, appConfig.WINDOW_READY_TO_SHOW_FALLBACK_MS)

    win.webContents.on("before-input-event", (_event, input) => {
      if (isDevToolsShortcut(input) && areRendererDevToolsAllowed()) {
        win.webContents.toggleDevTools()
      }
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url, app.isPackaged)) shell.openExternal(url)
      return { action: "deny" }
    })

    win.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigationUrl(url, getRendererSecurityPolicy())) {
        event.preventDefault()
      }
    })
    win.webContents.on("will-frame-navigate", (event) => {
      if (!isAllowedFrameNavigation(event, getRendererSecurityPolicy())) {
        event.preventDefault()
      }
    })

    // Secondary windows previously had NO will-attach-webview handler, so a
    // webview there attached with whatever preferences the renderer supplied.
    // Apply the same hardened policy as the main window.
    attachWebviewPolicy(win.webContents)

    // Same crash/hang recovery as the main window. Runtime config comes from
    // the `runtime:config` IPC call, not page injection.
    attachWindowLifecycle(win, { onProblem: showOnce })
    attachSessionEndHandlers(win)

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

  return {
    createWindow,
    openSecondaryWindow,
    getMainWindow: () => mainWindow,
  }
}

module.exports = { PRELOAD_PATH, createAppWindows }
