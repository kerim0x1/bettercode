import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  createPreviewRequestFeed,
  installPreviewRequestCapture,
} = require("../apps/shell/preview-request-capture.cjs")

function fakeSession() {
  const listeners = { send: null, completed: null, error: null }
  return {
    listeners,
    webRequest: {
      onSendHeaders: (fn) => { listeners.send = fn },
      onCompleted: (fn) => { listeners.completed = fn },
      onErrorOccurred: (fn) => { listeners.error = fn },
    },
    finish(id, guestId, extra = {}) {
      listeners.send?.({ id, webContentsId: guestId, resourceType: "xhr", timestamp: 1, url: `http://localhost:3000/api/${id}`, method: "GET" })
      listeners.completed?.({ id, webContentsId: guestId, resourceType: "xhr", timestamp: 5, url: `http://localhost:3000/api/${id}`, method: "GET", statusCode: 200, ...extra })
    },
  }
}

function fakeWindow(id) {
  const contents = new EventEmitter()
  contents.id = id
  contents.destroyed = false
  contents.isDestroyed = () => contents.destroyed
  return contents
}

function fakeTimers() {
  const pending = new Set()
  return {
    pending,
    api: {
      setTimeout: (fn) => { const handle = { fn }; pending.add(handle); return handle },
      clearTimeout: (handle) => pending.delete(handle),
    },
    runAll() {
      for (const handle of [...pending]) {
        pending.delete(handle)
        handle.fn()
      }
    },
  }
}

function setup({ maxBufferedPerWindow } = {}) {
  const timers = fakeTimers()
  const sent = []
  const owners = new Map() // guest id -> window
  const feed = createPreviewRequestFeed({
    resolveOwner: (guestId) => owners.get(guestId) ?? null,
    send: (contents, entries) => sent.push([contents.id, entries]),
    timers: timers.api,
    ...(maxBufferedPerWindow ? { maxBufferedPerWindow } : {}),
    logger: { warn() {} },
  })
  return { feed, timers, sent, owners }
}

test("nothing is observed until a window subscribes, and listeners go when the last one leaves", () => {
  const { feed } = setup()
  const previewSession = fakeSession()
  feed.attachSession(previewSession)
  assert.equal(previewSession.listeners.completed, null)
  assert.equal(feed.isCapturing(), false)

  const win = fakeWindow(1)
  feed.setSubscribed(win, true)
  assert.equal(typeof previewSession.listeners.completed, "function")
  // A session attached later is observed at once while someone subscribes.
  const lateSession = fakeSession()
  feed.attachSession(lateSession)
  assert.equal(typeof lateSession.listeners.send, "function")

  feed.setSubscribed(win, false)
  assert.equal(previewSession.listeners.completed, null)
  assert.equal(lateSession.listeners.error, null)
  assert.equal(feed.isCapturing(), false)
})

test("entries are batched per flush and sent only to the window hosting the guest", () => {
  const { feed, timers, sent, owners } = setup()
  const previewSession = fakeSession()
  feed.attachSession(previewSession)
  const first = fakeWindow(1)
  const second = fakeWindow(2)
  const unsubscribed = fakeWindow(3)
  owners.set(10, first).set(20, second).set(30, unsubscribed)
  feed.setSubscribed(first, true)
  feed.setSubscribed(second, true)

  previewSession.finish(1, 10)
  previewSession.finish(2, 10)
  previewSession.finish(3, 20)
  previewSession.finish(4, 30) // its window never subscribed
  previewSession.finish(5, 99) // no owner at all
  assert.equal(sent.length, 0)
  assert.equal(timers.pending.size, 1)

  timers.runAll()
  assert.deepEqual(sent.map(([id, entries]) => [id, entries.map((entry) => entry.id)]), [
    [1, ["1", "2"]],
    [2, ["3"]],
  ])
  assert.equal(sent[0][1][0].durationMs, 4)
})

test("a window's buffer is capped and a destroyed window is unsubscribed", () => {
  const { feed, timers, sent, owners } = setup({ maxBufferedPerWindow: 3 })
  const previewSession = fakeSession()
  feed.attachSession(previewSession)
  const win = fakeWindow(1)
  owners.set(10, win)
  feed.setSubscribed(win, true)
  feed.setSubscribed(win, true)
  for (let id = 1; id <= 5; id += 1) previewSession.finish(id, 10)
  timers.runAll()
  assert.deepEqual(sent[0][1].map((entry) => entry.id), ["3", "4", "5"])

  win.destroyed = true
  win.emit("destroyed")
  assert.equal(feed.isCapturing(), false)
  assert.equal(previewSession.listeners.completed, null)
  assert.equal(win.listenerCount("destroyed"), 0)
})

test("the low-level capture returns a function that removes its listeners", () => {
  const previewSession = fakeSession()
  const emitted = []
  const uninstall = installPreviewRequestCapture(previewSession, (entry) => emitted.push(entry))
  previewSession.finish(1, 7)
  assert.equal(emitted.length, 1)
  uninstall()
  assert.equal(previewSession.listeners.send, null)
  assert.equal(previewSession.listeners.completed, null)
  assert.equal(previewSession.listeners.error, null)
})
