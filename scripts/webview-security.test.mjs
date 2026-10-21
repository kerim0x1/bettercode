import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const shellDirectory = fileURLToPath(new URL("../apps/shell/", import.meta.url))
const {
  PREVIEW_PRELOAD_PATH,
  createWebContentsPolicy,
  isOwnPreviewPreload,
} = require("../apps/shell/shared/web-contents-policy.cjs")
const previewPartition = "persist:test-preview"
const canvasPartition = "persist:test-canvas"

function policy() {
  return createWebContentsPolicy({
    previewPartition,
    canvasPartition,
    getUserInputTracker: () => ({ track() {} }),
    getPreviewPartitionJanitor: () => ({ trackGuest() {} }),
    getPreviewGuestGate: () => ({ forget() {} }),
    areRendererDevToolsAllowed: () => false,
  })
}

function attach(preferences, params) {
  const listeners = new Map()
  policy().attachWebviewPolicy({ on: (channel, listener) => listeners.set(channel, listener) })
  let prevented = false
  listeners.get("will-attach-webview")({ preventDefault: () => { prevented = true } }, preferences, params)
  return prevented
}

test("the app's own preview preload is the shell's browser-preview-preload.cjs", () => {
  assert.equal(PREVIEW_PRELOAD_PATH, path.join(shellDirectory, "browser-preview-preload.cjs"))
  assert.equal(isOwnPreviewPreload(PREVIEW_PRELOAD_PATH), true)
  assert.equal(isOwnPreviewPreload("/untrusted/browser-preview-preload.cjs"), false)
  assert.equal(isOwnPreviewPreload(""), false)
  assert.equal(isOwnPreviewPreload(undefined), false)
})

test("guest preferences cannot disable web security or enable nested Node contexts", () => {
  const preferences = {
    nodeIntegration: true, nodeIntegrationInWorker: true, nodeIntegrationInSubFrames: true,
    contextIsolation: false, sandbox: false, webSecurity: false,
    allowRunningInsecureContent: true, webviewTag: true,
    preload: "/untrusted/preload.cjs", additionalArguments: ["--untrusted"],
  }
  const params = { src: "https://example.com", partition: "persist:default" }
  assert.equal(attach(preferences, params), false)
  for (const flag of ["nodeIntegration", "nodeIntegrationInWorker", "nodeIntegrationInSubFrames", "allowRunningInsecureContent", "webviewTag"]) {
    assert.equal(preferences[flag], false, flag)
  }
  for (const flag of ["contextIsolation", "sandbox", "webSecurity"]) assert.equal(preferences[flag], true, flag)
  assert.equal(preferences.partition, previewPartition)
  assert.equal(params.partition, previewPartition)
  assert.equal(preferences.preload, undefined)
  assert.equal(preferences.additionalArguments.length, 0)
})

test("canvas guests retain only the app bridge and unapproved URL schemes are blocked", () => {
  const preferences = { preloadURL: "file:///untrusted/preload.cjs" }
  const params = { src: "http://localhost:8080", partition: canvasPartition }
  assert.equal(attach(preferences, params), false)
  assert.equal(preferences.preload, path.join(shellDirectory, "browser-preview-preload.cjs"))
  assert.equal(preferences.preloadURL, undefined)
  assert.deepEqual([...preferences.additionalArguments], ["--betterc0de-canvas-preview"])
  assert.equal(preferences.partition, canvasPartition)
  assert.equal(attach({}, { src: "file:///private.txt" }), true)
  assert.equal(attach({}, { src: "javascript:alert(1)" }), true)
})

test("an editor guest that asks for the app's own preload keeps it; nothing else is kept", () => {
  const own = { preload: PREVIEW_PRELOAD_PATH }
  assert.equal(attach(own, { src: "http://localhost:5173" }), false)
  assert.equal(own.preload, PREVIEW_PRELOAD_PATH)
  assert.equal(own.partition, previewPartition)

  const foreign = { preload: path.join(shellDirectory, "preload.cjs") }
  assert.equal(attach(foreign, { src: "http://localhost:5173" }), false)
  assert.equal(foreign.preload, undefined)
})

test("a destroyed guest is reported to the window that hosted it", () => {
  const listeners = new Map()
  const sent = []
  const host = {
    on: (channel, listener) => listeners.set(channel, listener),
    isDestroyed: () => false,
    send: (channel, payload) => sent.push([channel, payload]),
  }
  policy().attachWebviewPolicy(host)
  let onDestroyed = null
  listeners.get("did-attach-webview")({}, { id: 42, once: (name, listener) => { if (name === "destroyed") onDestroyed = listener } })
  onDestroyed()
  assert.deepEqual(sent, [["preview:guest-destroyed", { webContentsId: 42 }]])
})
