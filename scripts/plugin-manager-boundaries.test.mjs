import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

const file = new URL("../apps/shell/plugin-manager.cjs", import.meta.url)
const require = createRequire(file)
const source = readFileSync(file, "utf8")
const runtimeSource = readFileSync(new URL("../apps/shell/shared/runtime-paths.cjs", import.meta.url), "utf8")

function load(isPackaged, env) {
  const app = { isPackaged, getPath: () => os.homedir() }
  const runtime = { exports: {} }
  const runtimeRequire = createRequire(new URL("../apps/shell/shared/runtime-paths.cjs", import.meta.url))
  runInNewContext(runtimeSource, {
    module: runtime, process: { env },
    require: name => name === "electron" ? { app } : runtimeRequire(name),
  })
  const module = { exports: {} }
  runInNewContext(source, {
    module, process: { env, platform: process.platform }, __dirname: path.dirname(fileURLToPath(file)),
    setTimeout, clearTimeout,
    require: name => name === "electron" ? { app }
      : name === "./shared/runtime-paths.cjs" ? runtime.exports : require(name),
  })
  return new module.exports.PluginManager()
}

test("provider plugins follow the selected profile home", () => {
  const profile = path.join(os.tmpdir(), "bc0de-isolated-profile")
  for (const packaged of [true, false]) {
    assert.equal(load(packaged, { BETTERC0DE_HOME: profile }).pluginsDir, path.join(profile, "plugins"))
  }
})

test("plugin method dispatch refuses inherited object methods", async () => {
  const manager = load(false, {})
  manager._readConfig = () => ({ enabled: true, values: {} })
  manager.plugins.set("demo", { module: { ping: () => "pong" }, config: { apiKey: "private-value" } })
  await assert.rejects(manager.sendToPlugin("demo", "constructor", {}), /no method/)
  await assert.rejects(manager.sendToPlugin("demo", "toString", {}), /no method/)
  assert.equal(await manager.sendToPlugin("demo", "ping", {}), "pong")
})

test("constructing a manager leaves module resolution alone until init()", () => {
  const Module = require("module")
  const before = [...Module.globalPaths]
  const manager = load(false, {})
  assert.deepEqual(Module.globalPaths, before)
  manager.init()
  manager.init()
  const added = Module.globalPaths.filter((entry) => !before.includes(entry))
  assert.ok(added.length <= 3)
  assert.equal(new Set(Module.globalPaths).size, Module.globalPaths.length)
  Module.globalPaths.splice(0, Module.globalPaths.length, ...before)
})

test("a plugin call that never settles times out, quarantines the plugin, and is released when it settles", async () => {
  const manager = load(false, {})
  manager._readConfig = () => ({ enabled: true, values: {} })
  manager._callTimeoutMs = 20
  let release
  manager.plugins.set("demo", {
    module: {
      hang: () => new Promise((resolve) => { release = resolve }),
      ping: () => "pong",
    },
    config: {},
  })
  await assert.rejects(manager.sendToPlugin("demo", "hang", {}), /timed out/)
  await assert.rejects(manager.sendToPlugin("demo", "ping", {}), /quarantined/)
  release("late")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await manager.sendToPlugin("demo", "ping", {}), "pong")
})

test("an uncaught error is attributed to the plugin whose code is on its stack", async () => {
  const home = path.join(os.tmpdir(), "bc0de-fault-profile")
  const manager = load(false, { BETTERC0DE_HOME: home })
  const pluginDir = path.join(manager.pluginsDir, "demo")
  manager.plugins.set("demo", { module: {}, config: {}, entryPath: path.join(pluginDir, "index.cjs") })
  const fromPlugin = new Error("boom")
  fromPlugin.stack = [
    "Error: boom",
    `    at Timeout._onTimeout (${path.join(pluginDir, "index.cjs")}:3:9)`,
  ].join("\n")
  const fromApp = new Error("app bug")
  fromApp.stack = ["Error: app bug", "    at main (/app/apps/shell/main.cjs:10:1)"].join("\n")
  assert.equal(manager.findPluginForError(fromPlugin), "demo")
  assert.equal(manager.findPluginForError(fromApp), null)
  assert.equal(manager.findPluginForError({}), null)

  let unloaded = false
  let disabled = null
  manager.unloadPlugin = async () => { unloaded = true }
  manager.togglePlugin = async (_id, enabled) => { disabled = enabled }
  assert.equal(manager.containPluginFault(fromPlugin), "demo")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(unloaded, true)
  assert.equal(disabled, false)
  assert.equal(manager.containPluginFault(fromApp), null)
})
