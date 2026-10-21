import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const require = createRequire(import.meta.url)
const helperSource = fs.readFileSync(new URL("../apps/shell/shared/json-fs.cjs", import.meta.url), "utf8")
const { WINDOW_STATE_FILENAME, createWindowStateStore } = require("../apps/shell/shared/window-state.cjs")

function helper(overrides = {}) {
  const module = { exports: {} }
  runInNewContext(helperSource, { module, Buffer, process, console,
    require: name => overrides[name] ?? require(name),
  })
  return module.exports
}

const oneDisplay = () => ({ getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] })

function windowState(directory, helpers = helper(), options = {}) {
  return createWindowStateStore({
    resolveDataDir: () => directory,
    jsonFs: helpers,
    getScreen: oneDisplay,
    defaults: { width: 1400, height: 900 },
    log: { warn() {} },
    ...options,
  })
}

test("JSON staging collision never removes an unowned file", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-json-stage-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const destination = path.join(directory, "profile.json")
  const staged = path.join(directory, ".profile.json.reserved.tmp")
  fs.writeFileSync(staged, "unowned")
  const json = helper({ crypto: { randomUUID: () => "reserved" } })
  assert.throws(() => json.writeJson(destination, {}), /EEXIST/)
  assert.equal(fs.readFileSync(staged, "utf8"), "unowned")
})

test("window state refuses oversized files and invalid native bounds", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-window-state-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const state = windowState(directory)
  const file = path.join(directory, WINDOW_STATE_FILENAME)
  assert.equal(WINDOW_STATE_FILENAME, "window-state.json")
  for (const width of [2147483648, 800.5]) {
    fs.writeFileSync(file, JSON.stringify({ width, height: 600 }))
    assert.equal(state.loadWindowState().width, 1400)
  }
  fs.writeFileSync(file, JSON.stringify({ width: 800, height: 600 }) + " ".repeat(128 * 1024))
  assert.equal(state.loadWindowState().width, 1400)
  fs.writeFileSync(file, JSON.stringify({ width: 800, height: 600, x: 10, y: 20, isMaximized: "false" }))
  const valid = state.loadWindowState()
  assert.equal(valid.width, 800)
  assert.equal(valid.x, 10)
  assert.equal(valid.isMaximized, false)
})

test("a saved position off every connected display is dropped", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-window-state-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, WINDOW_STATE_FILENAME), JSON.stringify({ width: 800, height: 600, x: 5000, y: 5000, isMaximized: true }))
  const restored = windowState(directory).loadWindowState()
  assert.deepEqual(restored, { width: 800, height: 600, x: undefined, y: undefined, isMaximized: true })
})

test("failed window state replacement preserves the previous snapshot", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-window-state-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, WINDOW_STATE_FILENAME)
  fs.writeFileSync(file, JSON.stringify({ width: 800, height: 600 }))
  const state = windowState(directory, helper({ fs: { ...fs, renameSync: () => { throw new Error("fixture replacement denied") } } }))
  state.writeWindowState({ width: 900, height: 700 })
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).width, 800)
  assert.deepEqual(fs.readdirSync(directory), [WINDOW_STATE_FILENAME])
})

test("resize saves are debounced, and the close path cancels the pending one", () => {
  const writes = []
  const pending = new Set()
  const timers = {
    setTimeout: (fn) => { const handle = { fn }; pending.add(handle); return handle },
    clearTimeout: (handle) => pending.delete(handle),
  }
  const state = createWindowStateStore({
    resolveDataDir: () => "/unused",
    jsonFs: { readJson: () => null, writeJson: (_file, value) => writes.push(value) },
    getScreen: oneDisplay,
    timers,
    log: { warn() {} },
  })
  const win = {
    isDestroyed: () => false,
    isMaximized: () => false,
    getBounds: () => ({ x: 1, y: 2, width: 800, height: 600 }),
    getNormalBounds: () => ({ x: 0, y: 0, width: 640, height: 480 }),
  }
  state.saveWindowStateDebounced(win)
  state.saveWindowStateDebounced(win)
  assert.equal(pending.size, 1)
  state.cancelPendingSave()
  assert.equal(pending.size, 0)
  state.saveWindowStateDebounced(win)
  for (const handle of [...pending]) { pending.delete(handle); handle.fn() }
  assert.deepEqual(writes, [{ x: 1, y: 2, width: 800, height: 600, isMaximized: false }])
  assert.deepEqual(
    state.captureWindowState({ ...win, isMaximized: () => true }),
    { x: 0, y: 0, width: 640, height: 480, isMaximized: true },
  )
  assert.equal(state.captureWindowState({ isDestroyed: () => true }), null)
})
