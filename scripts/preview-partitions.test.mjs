import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const { createPreviewPartitionJanitor } = require("../apps/shell/shared/preview-partitions.cjs")

function fakeSession(name) {
  const calls = []
  return {
    name,
    calls,
    clearCache: async () => { calls.push("cache") },
    clearStorageData: async (options) => { calls.push(options.storages.join(",")) },
  }
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

function guest(id, session) {
  const contents = new EventEmitter()
  contents.id = id
  contents.session = session
  return contents
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("a partition is cleared only after its last guest is gone for the grace period", async () => {
  const preview = fakeSession("preview")
  const canvas = fakeSession("canvas")
  const timers = fakeTimers()
  const janitor = createPreviewPartitionJanitor({
    partitions: new Map([["betterc0de-preview", preview], ["betterc0de-canvas-preview", canvas]]),
    timers: timers.api,
    logger: { warn() {} },
  })

  const first = guest(1, preview)
  const second = guest(2, preview)
  assert.equal(janitor.trackGuest(first), "betterc0de-preview")
  janitor.trackGuest(second)
  assert.equal(janitor.trackGuest(guest(9, fakeSession("other"))), null)

  first.emit("destroyed")
  assert.equal(timers.pending.size, 0, "a guest is still open")
  second.emit("destroyed")
  assert.equal(timers.pending.size, 1)

  // A reload re-creates the guest before the grace period ends: no clear.
  const reloaded = guest(3, preview)
  janitor.trackGuest(reloaded)
  assert.equal(timers.pending.size, 0)
  reloaded.emit("destroyed")
  timers.runAll()
  await settle()
  assert.deepEqual(preview.calls.sort(), ["cache", "cachestorage,serviceworkers,shadercache"])
  // Cookies, localStorage and IndexedDB are kept.
  assert.equal(preview.calls.some((call) => /cookies|localstorage|indexdb/.test(call)), false)
  assert.deepEqual(canvas.calls, [])
})
