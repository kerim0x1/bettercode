import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  createRendererClientInstances,
  isPageReplacingNavigation,
} = require("../apps/shell/shared/renderer-client-instances.cjs")

function fakeContents(id) {
  const contents = new EventEmitter()
  contents.id = id
  return contents
}

function registry() {
  const released = []
  const warnings = []
  const instances = createRendererClientInstances({
    release: async (id, reason) => {
      released.push([id, reason])
    },
    logger: { warn: (...args) => warnings.push(args.join(" ")) },
  })
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  return { instances, released, warnings, settle }
}

const PAGE_A = "0f8fad5b-d9cb-469f-a165-70867728950e"
const PAGE_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

test("a crashed renderer releases its page's terminals", async () => {
  const { instances, released, settle } = registry()
  const window = fakeContents(1)
  instances.register(window, PAGE_A)
  assert.equal(instances.currentFor(window), PAGE_A)
  window.emit("render-process-gone", {}, { reason: "crashed" })
  await settle()
  assert.deepEqual(released, [[PAGE_A, "renderer process gone"]])
  assert.equal(instances.currentFor(window), null)
  // Released once: the window closing afterwards has nothing left to end.
  window.emit("destroyed")
  await settle()
  assert.equal(released.length, 1)
})

test("a reload releases the old page, and the new page's id replaces it", async () => {
  const { instances, released, settle } = registry()
  const window = fakeContents(2)
  instances.register(window, PAGE_A)
  // Hash navigation inside the page keeps it.
  window.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
  // Subframes are not the page.
  window.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false })
  await settle()
  assert.deepEqual(released, [])
  window.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
  instances.register(window, PAGE_B)
  await settle()
  assert.deepEqual(released, [[PAGE_A, "page navigated or reloaded"]])
  assert.equal(instances.currentFor(window), PAGE_B)
})

test("a new page id releases the previous one even without a navigation event", async () => {
  const { instances, released, settle } = registry()
  const window = fakeContents(3)
  instances.register(window, PAGE_A)
  instances.register(window, PAGE_A)
  instances.register(window, PAGE_B)
  await settle()
  assert.deepEqual(released, [[PAGE_A, "page replaced"]])
})

test("closing a window releases its page; other windows keep theirs", async () => {
  const { instances, released, settle } = registry()
  const first = fakeContents(4)
  const second = fakeContents(5)
  instances.register(first, PAGE_A)
  instances.register(second, PAGE_B)
  first.emit("destroyed")
  await settle()
  assert.deepEqual(released, [[PAGE_A, "window closed"]])
  assert.equal(instances.currentFor(second), PAGE_B)
})

test("malformed ids are refused and release failures are only logged", async () => {
  const warnings = []
  const instances = createRendererClientInstances({
    release: async () => {
      throw new Error("backend down")
    },
    logger: { warn: (...args) => warnings.push(args.join(" ")) },
  })
  const window = fakeContents(6)
  for (const bad of ["", "short", "has space in it", "x".repeat(129), 42, null]) {
    assert.throws(() => instances.register(window, bad), /Invalid renderer client instance id/)
  }
  instances.register(window, PAGE_A)
  window.emit("destroyed")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /backend down/)
})

test("both did-start-navigation signatures are understood", () => {
  // Newer Electron: a details event.
  assert.equal(isPageReplacingNavigation({ isMainFrame: true, isSameDocument: false }), true)
  assert.equal(isPageReplacingNavigation({ isMainFrame: true, isSameDocument: true }), false)
  // Older Electron: (event, url, isInPlace, isMainFrame).
  assert.equal(isPageReplacingNavigation({}, "app://x", false, true), true)
  assert.equal(isPageReplacingNavigation({}, "app://x", true, true), false)
  assert.equal(isPageReplacingNavigation({}, "app://x", false, false), false)
})
