// App windows (shared/app-windows.cjs), extracted from main.cjs: every window
// is created sandboxed with the app preload, registered as a trusted
// renderer, given the webview policy, and keeps navigation and popups in
// check. Driven with a stand-in BrowserWindow.
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const { PRELOAD_PATH, createAppWindows } = require("../apps/shell/shared/app-windows.cjs")
const shellDirectory = fileURLToPath(new URL("../apps/shell/", import.meta.url))
const appPath = path.resolve("/fixture/app")

class FakeWebContents extends EventEmitter {
  constructor(id) {
    super()
    this.id = id
    this.reloads = 0
  }
  setWindowOpenHandler(handler) { this.openHandler = handler }
  openDevTools() {}
  toggleDevTools() {}
  reload() { this.reloads += 1 }
}

function windowHarness({ isPackaged = true } = {}) {
  const created = []
  const registered = []
  const attached = []
  const opened = []
  const dialogs = []
  const saved = []
  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.webContents = new FakeWebContents(created.length + 1)
      this.destroyed = false
      created.push(this)
    }
    isDestroyed() { return this.destroyed }
    show() {}
    maximize() {}
    close() {}
    setWindowButtonVisibility() {}
    loadURL(url) { this.loaded = { url } }
    loadFile(file, options) { this.loaded = { file, options } }
  }
  const policy = {
    isPackaged,
    devRendererOrigin: "http://localhost:49123",
    packagedRendererRoot: path.join(appPath, "apps", "ui", "dist"),
    trustedWebContentsIds: new Set(),
  }
  const windows = createAppWindows({
    electron: {
      app: { isPackaged, getAppPath: () => appPath },
      BrowserWindow: FakeBrowserWindow,
      dialog: { showMessageBox: async (_win, options) => { dialogs.push(options); return { response: 1 } } },
      shell: { openExternal: (url) => { opened.push(url) } },
    },
    windowState: {
      loadWindowState: () => ({ width: 1000, height: 700, x: 10, y: 20, isMaximized: false }),
      saveWindowStateDebounced: (win) => saved.push(["debounced", win]),
      cancelPendingSave: () => saved.push(["cancel"]),
      captureWindowState: () => ({ width: 1000, height: 700 }),
      writeWindowState: (state) => saved.push(["write", state]),
    },
    registerTrustedRendererContents: (contents) => registered.push(contents.id),
    attachWebviewPolicy: (contents) => attached.push(contents.id),
    getRendererSecurityPolicy: () => policy,
    areRendererDevToolsAllowed: () => false,
    isDevToolsShortcut: () => false,
    isQuitting: () => false,
    requestApplicationQuit: () => {},
    timers: { setTimeout: () => ({}) },
  })
  return { windows, created, registered, attached, opened, dialogs, saved }
}

const HARDENED = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: true,
}

test("the main window is sandboxed, uses the app preload and is registered before it loads", () => {
  const { windows, created, registered, attached, saved } = windowHarness()
  assert.equal(windows.getMainWindow(), null)
  windows.createWindow()
  const [win] = created
  assert.equal(windows.getMainWindow(), win)
  assert.equal(PRELOAD_PATH, path.join(shellDirectory, "preload.cjs"))
  assert.equal(win.options.webPreferences.preload, PRELOAD_PATH)
  for (const [key, value] of Object.entries(HARDENED)) assert.equal(win.options.webPreferences[key], value, key)
  assert.equal(win.options.show, false)
  assert.deepEqual([win.options.width, win.options.height, win.options.x, win.options.y], [1000, 700, 10, 20])
  assert.deepEqual(registered, [win.webContents.id])
  assert.deepEqual(attached, [win.webContents.id])
  assert.deepEqual(win.loaded, { file: path.join(appPath, "apps", "ui", "dist", "index.html"), options: undefined })

  win.emit("resize")
  assert.equal(saved.at(-1)[0], "debounced")
  win.emit("close")
  assert.deepEqual(saved.slice(-2), [["cancel"], ["write", { width: 1000, height: 700 }]])
  win.emit("closed")
  assert.equal(windows.getMainWindow(), null)
})

test("app windows open only allowed links externally and never navigate off the renderer", () => {
  const { windows, created, opened } = windowHarness()
  windows.createWindow()
  const [win] = created
  assert.equal(win.webContents.openHandler({ url: "https://example.com/docs" }).action, "deny")
  assert.equal(win.webContents.openHandler({ url: "file:///etc/passwd" }).action, "deny")
  assert.equal(win.webContents.openHandler({ url: "http://localhost:3000" }).action, "deny")
  assert.deepEqual(opened, ["https://example.com/docs"], "packaged builds open only https links")

  const navigate = (url) => {
    let prevented = false
    win.webContents.emit("will-navigate", { preventDefault: () => { prevented = true } }, url)
    return prevented
  }
  assert.equal(navigate("https://attacker.example/"), true)
  assert.equal(navigate(pathToFileURL(path.join(appPath, "apps", "ui", "dist", "index.html")).href), false)
})

test("a visual reply's frame stays on its page in every app window", () => {
  const { windows, created } = windowHarness()
  windows.createWindow()
  windows.openSecondaryWindow({ mode: "editor" })
  const dist = path.join(appPath, "apps", "ui", "dist")
  const replyPage = pathToFileURL(path.join(dist, "visual-reply-frame.html")).href
  assert.equal(created.length, 2)
  for (const win of created) {
    const navigate = (from, to) => {
      let prevented = false
      win.webContents.emit("will-frame-navigate", {
        isMainFrame: false,
        url: to,
        frame: { url: from },
        preventDefault: () => { prevented = true },
      })
      return prevented
    }
    assert.equal(navigate(replyPage, "https://attacker.example/"), true)
    assert.equal(navigate(replyPage, pathToFileURL(path.join(dist, "index.html")).href), true)
    assert.equal(navigate(replyPage, replyPage), false, "reloading the page is fine")
    assert.equal(navigate("about:blank", replyPage), false, "the chat loads the page into a new frame")
  }
})

test("secondary windows get the same hardening and only known launch parameters", () => {
  const { windows, created, registered, attached } = windowHarness()
  const editor = windows.openSecondaryWindow({ mode: "editor", cwd: "/projects/a b" })
  assert.equal(created.length, 1)
  for (const [key, value] of Object.entries(HARDENED)) assert.equal(editor.options.webPreferences[key], value, key)
  assert.equal(editor.options.webPreferences.preload, PRELOAD_PATH)
  assert.deepEqual(registered, [editor.webContents.id])
  assert.deepEqual(attached, [editor.webContents.id])
  assert.equal(editor.loaded.options.hash, "mode=editor&cwd=%2Fprojects%2Fa+b")
  assert.equal(windows.getMainWindow(), null, "a secondary window is not the main window")

  const plain = windows.openSecondaryWindow({ mode: "evil" })
  assert.equal(plain.loaded.options, undefined)
})

test("a renderer crash reloads once, then asks before reloading again", async () => {
  const { windows, created, dialogs } = windowHarness()
  windows.createWindow()
  const [win] = created
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 })
  assert.equal(win.webContents.reloads, 1)
  assert.equal(dialogs.length, 0)
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 })
  assert.equal(dialogs.length, 1)
  assert.match(dialogs[0].message, /stopped working again/)
  win.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 })
  assert.equal(dialogs.length, 1)
})
