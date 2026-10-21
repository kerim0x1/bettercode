import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  PREVIEW_GUEST_GATE_CHANNEL,
  createPreviewGuestGate,
  createUserInputTracker,
} = require("../apps/shell/shared/user-input-gate.cjs")

function contents(id, extra = {}) {
  const emitter = new EventEmitter()
  emitter.id = id
  return Object.assign(emitter, extra)
}

test("only real key, click and touch input counts, and it expires", () => {
  let clock = 1_000
  const tracker = createUserInputTracker({ now: () => clock })
  const win = contents(1)
  tracker.track(win)
  tracker.track(win)
  assert.equal(win.listenerCount("input-event"), 1)

  win.emit("input-event", {}, { type: "mouseMove" })
  win.emit("input-event", {}, { type: "mouseWheel" })
  assert.equal(tracker.hasRecentInput(win, 5_000), false)

  win.emit("input-event", {}, { type: "keyDown" })
  clock += 4_000
  assert.equal(tracker.hasRecentInput(win, 5_000), true)
  clock += 2_000
  assert.equal(tracker.hasRecentInput(win, 5_000), false)

  win.emit("input-event", {}, { type: "mouseDown" })
  win.emit("destroyed")
  assert.equal(tracker.hasRecentInput(win, 5_000), false)
  assert.equal(tracker.hasRecentInput(null, 5_000), false)
})

test("a guest may forward a selection only after input to it or its window, a few times at most", () => {
  let clock = 0
  const tracker = createUserInputTracker({ now: () => clock })
  const host = contents(1)
  const guest = contents(2, { hostWebContents: host })
  tracker.track(host)
  tracker.track(guest)
  const gate = createPreviewGuestGate({
    inputTracker: tracker,
    now: () => clock,
    inputWindowMs: 3_000,
    maxPerWindow: 2,
    rateWindowMs: 10_000,
  })

  // The page calls the bridge on its own: refused.
  assert.equal(gate.allow(guest, "element-selected"), false)

  // A click in the app's inspector tree (the host window) allows it.
  host.emit("input-event", {}, { type: "mouseDown" })
  assert.equal(gate.allow(guest, "element-selected"), true)
  assert.equal(gate.allow(guest, "element-selected"), true)
  // ...but not a third time inside the rate window.
  assert.equal(gate.allow(guest, "element-selected"), false)
  // Ungated channels never pass through the gate.
  assert.equal(gate.allow(guest, "console-batch"), false)

  clock = 11_000
  assert.equal(gate.allow(guest, "element-selected"), false, "input expired")
  guest.emit("input-event", {}, { type: "pointerDown" })
  assert.equal(gate.allow(guest, "element-selected"), true, "picking in the page itself")
  assert.equal(PREVIEW_GUEST_GATE_CHANNEL, "preview-guest:gate")
})

test("the gate matches the channel the preview preload invokes", async () => {
  const { readFileSync } = await import("node:fs")
  const preload = readFileSync(new URL("../apps/shell/browser-preview-preload.cjs", import.meta.url), "utf8")
  assert.match(preload, new RegExp(`GATE_CHANNEL = "${PREVIEW_GUEST_GATE_CHANNEL}"`))
})
