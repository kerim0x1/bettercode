// The out-of-process plugin host (PROC-07): the host runtime on its own, the
// main-process client over an in-memory transport (timeouts, crashes,
// backoff, faults, dispose), PluginManager on top of the client, and one run
// across a real process boundary (`child_process.fork` of the host entry).
import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const { createPluginHostRuntime } = require("../apps/shell/shared/plugin-host-runtime.cjs")
const {
  createPluginHostClient,
  spawnNodePluginHost,
  terminateHostTree,
} = require("../apps/shell/shared/plugin-host-client.cjs")
const { PluginManager } = require("../apps/shell/plugin-manager.cjs")
const { usePluginHost } = require("../apps/shell/plugin-ipc.cjs")

const quiet = { log() {}, warn() {}, error() {} }

const PLUGIN_SOURCE = `
let listener = null
module.exports = {
  ping: (input) => "pong:" + input.value,
  echo: (input) => input,
  pid: () => process.pid,
  fail: () => { throw Object.assign(new Error("boom"), { code: "E_PLUGIN" }) },
  unsendable: () => () => "a function cannot cross processes",
  hang: () => new Promise(() => {}),
  emit: (input) => { listener?.({ type: input.type, payload: { n: 1 } }); return listener !== null },
  lateThrow: () => { setTimeout(() => { throw new Error("late plugin error") }, 5); return true },
  exitNow: (input) => { process.exit(input.code) },
  onEvent(next) { listener = next; return { dispose() { listener = null } } },
  deactivate() { globalThis.__pluginHostTestDeactivations = (globalThis.__pluginHostTestDeactivations || 0) + 1 },
}
`

/** A plugins directory with one plugin, "demo". Canonical: stacks and require.cache use real paths. */
function pluginsFixture(t, source = PLUGIN_SOURCE) {
  const pluginsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-plugin-host-")))
  t.after(() => fs.rmSync(pluginsDir, { recursive: true, force: true }))
  const pluginDir = path.join(pluginsDir, "demo")
  fs.mkdirSync(pluginDir)
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({ id: "demo", name: "Demo", entry: "index.cjs" }))
  fs.writeFileSync(path.join(pluginDir, "index.cjs"), source)
  return { pluginsDir, pluginDir, entryPath: path.join(pluginDir, "index.cjs") }
}

function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      let value
      try { value = predicate() } catch (error) { reject(error); return }
      if (value) { resolve(value); return }
      if (Date.now() - started > timeoutMs) { reject(new Error("timed out waiting for condition")); return }
      setTimeout(check, 10)
    }
    check()
  })
}

// ── Host runtime ─────────────────────────────────────────────────────────

function runtimeHarness() {
  const waiters = new Map()
  const events = []
  const notices = []
  const exits = []
  const runtime = createPluginHostRuntime({
    // Structured clone, as the real channel does (it throws for functions).
    post: (message) => {
      const copy = structuredClone(message)
      if (copy.type === "response") {
        const resolve = waiters.get(copy.id)
        waiters.delete(copy.id)
        resolve?.(copy)
      } else if (copy.type === "event") {
        events.push(copy)
      } else {
        notices.push(copy)
      }
    },
    exit: (code) => exits.push(code),
    log: quiet,
  })
  let nextId = 1
  const call = (op, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++
      waiters.set(id, resolve)
      runtime.handle({ ...params, type: "request", id, op })
    })
  return { runtime, call, events, notices, exits }
}

test("the host runtime loads a plugin and runs its methods with the in-process API", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const { call } = runtimeHarness()
  const loaded = await call("load", { instanceId: "demo#1", pluginId: "demo", pluginDir, entryPath })
  assert.equal(loaded.ok, true)
  for (const name of ["ping", "fail", "onEvent", "deactivate", "emit"]) {
    assert.ok(loaded.value.functions.includes(name), name)
  }

  assert.deepEqual(await call("invoke", { instanceId: "demo#1", method: "ping", input: { value: "a" } }), {
    type: "response", id: 2, ok: true, value: "pong:a",
  })
  const failed = await call("invoke", { instanceId: "demo#1", method: "fail", input: {} })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.message, "boom")
  assert.equal(failed.error.code, "E_PLUGIN")
  for (const method of ["constructor", "toString", "onEvent", "deactivate", "missing"]) {
    const refused = await call("invoke", { instanceId: "demo#1", method, input: {} })
    assert.equal(refused.ok, false, method)
    assert.match(refused.error.message, /has no method/, method)
  }
  const unsendable = await call("invoke", { instanceId: "demo#1", method: "unsendable", input: {} })
  assert.equal(unsendable.ok, false)
  assert.match(unsendable.error.message, /cannot be sent/)
  const unknown = await call("nonsense")
  assert.match(unknown.error.message, /Unknown plugin host operation/)
})

test("host event subscriptions forward events until the plugin's disposer runs", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const { call, events } = runtimeHarness()
  await call("load", { instanceId: "demo#1", pluginId: "demo", pluginDir, entryPath })
  assert.equal((await call("subscribe", { instanceId: "demo#1", subscriptionId: "s1" })).ok, true)
  await call("invoke", { instanceId: "demo#1", method: "emit", input: { type: "tick" } })
  assert.deepEqual(events, [{ type: "event", subscriptionId: "s1", event: { type: "tick", payload: { n: 1 } } }])
  assert.equal((await call("unsubscribe", { subscriptionId: "s1" })).value, true)
  const emitted = await call("invoke", { instanceId: "demo#1", method: "emit", input: { type: "tock" } })
  assert.equal(emitted.value, false, "the plugin's own disposer removed its listener")
  assert.equal(events.length, 1)
})

test("dispose runs the module's deactivate and evict forgets the instance and its require cache", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const { call } = runtimeHarness()
  await call("load", { instanceId: "demo#1", pluginId: "demo", pluginDir, entryPath })
  assert.ok(require.cache[entryPath], "loaded through the shared require cache")
  const before = globalThis.__pluginHostTestDeactivations || 0
  assert.equal((await call("dispose", { instanceId: "demo#1" })).ok, true)
  assert.equal(globalThis.__pluginHostTestDeactivations, before + 1)
  assert.equal((await call("evict", { pluginId: "demo" })).ok, true)
  assert.equal(require.cache[entryPath], undefined)
  const gone = await call("invoke", { instanceId: "demo#1", method: "ping", input: { value: "x" } })
  assert.match(gone.error.message, /not loaded in the plugin host/)
})

test("a missing entry fails to load with MODULE_NOT_FOUND", async (t) => {
  const { pluginDir } = pluginsFixture(t)
  const { call } = runtimeHarness()
  const result = await call("load", {
    instanceId: "demo#1", pluginId: "demo", pluginDir, entryPath: path.join(pluginDir, "missing.cjs"),
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, "MODULE_NOT_FOUND")
})

test("uncaught errors from plugin code are reported as faults; others end the host", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const { runtime, call, notices, exits } = runtimeHarness()
  await call("load", { instanceId: "demo#1", pluginId: "demo", pluginDir, entryPath })
  const fromPlugin = new Error("plugin timer failed")
  fromPlugin.stack = `Error: plugin timer failed\n    at Timeout._onTimeout (${entryPath}:3:9)`
  assert.equal(runtime.handleUncaughtException(fromPlugin), true)
  assert.equal(notices.at(-1).type, "fault")
  assert.equal(notices.at(-1).pluginId, "demo")
  assert.deepEqual(exits, [])

  const fromHost = new Error("host bug")
  fromHost.stack = "Error: host bug\n    at somewhere (/app/apps/shell/shared/plugin-host-runtime.cjs:1:1)"
  assert.equal(runtime.handleUncaughtException(fromHost), false)
  assert.equal(notices.at(-1).type, "fatal")
  assert.deepEqual(exits, [1])
})

// ── Client over an in-memory transport ───────────────────────────────────

/** Hosts that run the real runtime in this process, behind structured clone. */
function loopbackHosts({ frozenAfterInit = false } = {}) {
  const spawned = []
  const spawnHost = () => {
    let onMessage = null
    let onExit = null
    let alive = true
    let initialized = false
    const host = {
      killed: 0,
      pid: () => undefined,
      postMessage: (message) => {
        const copy = structuredClone(message)
        if (frozenAfterInit && initialized) return
        if (copy.op === "init") initialized = true
        setImmediate(() => { if (alive) runtime.handle(copy) })
      },
      onMessage: (listener) => { onMessage = listener },
      onExit: (listener) => { onExit = listener },
      kill: () => {
        host.killed += 1
        host.exit(null, "SIGKILL")
      },
      exit: (code = 1, signal = null) => {
        if (!alive) return
        alive = false
        setImmediate(() => onExit?.({ code, signal }))
      },
      get alive() { return alive },
    }
    const runtime = createPluginHostRuntime({
      post: (message) => {
        const copy = structuredClone(message)
        setImmediate(() => { if (alive) onMessage?.(copy) })
      },
      exit: (code) => host.exit(code),
      log: quiet,
    })
    host.runtime = runtime
    spawned.push(host)
    return host
  }
  return { spawnHost, spawned }
}

function client(t, hosts, overrides = {}) {
  const crashes = []
  const faults = []
  const instance = createPluginHostClient({
    spawnHost: hosts.spawnHost,
    onCrash: (crash) => crashes.push(crash),
    onFault: (pluginId, error) => faults.push({ pluginId, error }),
    terminate: async (host) => host.kill(),
    log: quiet,
    baseDelayMs: 5,
    maxDelayMs: 20,
    shutdownTimeoutMs: 200,
    ...overrides,
  })
  t.after(() => instance.dispose())
  return { client: instance, crashes, faults }
}

test("the client's proxy module keeps the plugin API: methods, events and cleanup", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const hosts = loopbackHosts()
  const { client: host } = client(t, hosts)
  const proxy = await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  assert.equal(hosts.spawned.length, 1)
  assert.equal(typeof proxy.ping, "function")
  assert.equal(typeof proxy.onEvent, "function")
  assert.equal(typeof proxy.deactivate, "function")
  assert.equal(Object.hasOwn(proxy, "offEvent"), false)
  assert.equal(Object.hasOwn(proxy, "toString"), false)

  assert.equal(await proxy.ping({ value: "b", config: { key: "v" } }), "pong:b")
  assert.deepEqual(await proxy.echo({ nested: { list: [1, 2] } }), { nested: { list: [1, 2] } })
  await assert.rejects(proxy.fail({}), (error) => error.message === "boom" && error.code === "E_PLUGIN")
  await assert.rejects(proxy.echo({ fn: () => {} }), /could not be cloned|DataCloneError/i)

  const received = []
  const dispose = await proxy.onEvent((event) => received.push(event))
  assert.equal(typeof dispose, "function")
  assert.equal(await proxy.emit({ type: "tick" }), true)
  await waitFor(() => received.length === 1)
  assert.deepEqual(received, [{ type: "tick", payload: { n: 1 } }])
  await dispose()
  assert.equal(await proxy.emit({ type: "tock" }), false)
  await assert.rejects(proxy.onEvent("not a function"), /must be a function/)

  await proxy.deactivate()
  assert.equal(await host.evictPlugin("demo"), true)
  assert.equal(hosts.spawned.length, 1, "one host serves every call")
})

test("a call past its deadline fails; a host that still answers pings is kept", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const hosts = loopbackHosts()
  const { client: host } = client(t, hosts, { invokeTimeoutMs: 30, pingTimeoutMs: 500 })
  const proxy = await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  await assert.rejects(proxy.hang({}), (error) => error.code === "PLUGIN_HOST_TIMEOUT")
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(hosts.spawned[0].killed, 0)
  assert.equal(await proxy.ping({ value: "still here" }), "pong:still here")
})

test("a host that stops answering is killed, reported as a crash and replaced after a backoff", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const hosts = loopbackHosts({ frozenAfterInit: true })
  const { client: host, crashes } = client(t, hosts, { loadTimeoutMs: 30, pingTimeoutMs: 30 })
  await assert.rejects(
    host.loadPlugin({ pluginId: "demo", pluginDir, entryPath }),
    (error) => error.code === "PLUGIN_HOST_TIMEOUT",
  )
  await waitFor(() => crashes.length === 1)
  assert.equal(hosts.spawned[0].killed, 1)
  assert.equal(crashes[0].gaveUp, false)
  assert.match(crashes[0].reason, /SIGKILL/)
  assert.equal(host.state().running, false)
})

test("a crash fails pending calls, reports the lost plugins and the next use starts a new host", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const hosts = loopbackHosts()
  const { client: host, crashes } = client(t, hosts)
  const proxy = await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  const pending = proxy.hang({})
  hosts.spawned[0].exit(3)
  await assert.rejects(pending, (error) => error.code === "PLUGIN_HOST_EXITED")
  await waitFor(() => crashes.length === 1)
  assert.deepEqual(crashes[0].pluginIds, ["demo"])
  assert.equal(crashes[0].crashCount, 1)
  assert.match(crashes[0].reason, /exit code 3/)

  // The old proxy belongs to the dead host; using it starts nothing.
  await assert.rejects(proxy.ping({ value: "x" }), (error) => error.code === "PLUGIN_HOST_EXITED")
  assert.equal(hosts.spawned.length, 1)

  const reloaded = await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  assert.equal(hosts.spawned.length, 2)
  assert.equal(await reloaded.ping({ value: "again" }), "pong:again")
})

test("repeated crashes stop automatic restarts until the crash window has passed", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const hosts = loopbackHosts()
  let clock = 1_000
  const { client: host, crashes } = client(t, hosts, { maxCrashes: 2, crashWindowMs: 60_000, now: () => clock })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
    hosts.spawned.at(-1).exit(1)
    await waitFor(() => crashes.length === attempt + 1)
    clock += 25 // past the (fake-clock) backoff
  }
  assert.equal(crashes[1].gaveUp, true)
  await assert.rejects(
    host.loadPlugin({ pluginId: "demo", pluginDir, entryPath }),
    (error) => error.code === "PLUGIN_HOST_CRASH_LOOP",
  )
  clock += 60_000
  await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  assert.equal(hosts.spawned.length, 3)
})

test("a plugin's uncaught error reaches onFault and the host keeps serving", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const hosts = loopbackHosts()
  const { client: host, faults } = client(t, hosts)
  const proxy = await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  const error = new Error("late plugin error")
  error.stack = `Error: late plugin error\n    at Timeout._onTimeout (${entryPath}:9:3)`
  hosts.spawned[0].runtime.handleUncaughtException(error)
  await waitFor(() => faults.length === 1)
  assert.equal(faults[0].pluginId, "demo")
  assert.equal(faults[0].error.message, "late plugin error")
  assert.equal(await proxy.ping({ value: "ok" }), "pong:ok")
})

test("dispose ends the host, and nothing starts one afterwards", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const hosts = loopbackHosts()
  const { client: host, crashes } = client(t, hosts)
  await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  await host.dispose()
  assert.equal(hosts.spawned[0].alive, false)
  assert.equal(crashes.length, 0, "a requested stop is not a crash")
  await assert.rejects(
    host.loadPlugin({ pluginId: "demo", pluginDir, entryPath }),
    (error) => error.code === "PLUGIN_HOST_DISPOSED",
  )
  assert.equal(hosts.spawned.length, 1)
})

test("POSIX host teardown kills the snapshotted descendants by PID, never by process group", async () => {
  const signalled = []
  let hostKilled = false
  await terminateHostTree(
    { pid: () => 4242, kill: () => { hostKilled = true } },
    {
      platform: "linux",
      listDescendants: async (pid) => {
        assert.equal(pid, 4242)
        return [{ pid: 5001, ppid: 4242, pgid: 1234 }, { pid: 5002, ppid: 5001, pgid: 1234 }, { pid: process.pid, ppid: 1, pgid: 1 }]
      },
      kill: (pid, signal) => signalled.push([pid, signal]),
    },
  )
  assert.equal(hostKilled, true)
  assert.deepEqual(signalled, [[5001, "SIGKILL"], [5002, "SIGKILL"]])
})

// ── PluginManager on the host ────────────────────────────────────────────

test("PluginManager runs a plugin through the host with the same API and lifecycle", async (t) => {
  const { pluginsDir } = pluginsFixture(t)
  const hosts = loopbackHosts()
  const { client: host } = client(t, hosts)
  const manager = new PluginManager({ host })
  manager._pluginsDir = pluginsDir

  await manager.loadPlugin("demo")
  assert.equal(hosts.spawned.length, 1)
  assert.equal(await manager.sendToPlugin("demo", "ping", { value: "m" }), "pong:m")
  assert.deepEqual(await manager.sendToPlugin("demo", "echo", { a: 1 }), { a: 1, config: {} })
  await assert.rejects(manager.sendToPlugin("demo", "constructor", {}), /no method/)

  const events = []
  assert.equal(await manager.setupPluginEvents("demo", (event) => events.push(event)), true)
  await manager.sendToPlugin("demo", "emit", { type: "tick" })
  await waitFor(() => events.length === 1)
  assert.deepEqual(events, [{ pluginId: "demo", type: "tick", payload: { n: 1 } }])

  const before = globalThis.__pluginHostTestDeactivations || 0
  assert.equal(await manager.unloadPlugin("demo"), true)
  assert.equal(globalThis.__pluginHostTestDeactivations, before + 1)
  assert.equal(manager.plugins.has("demo"), false)
  // The method call loads the plugin again on demand.
  assert.equal(await manager.sendToPlugin("demo", "ping", { value: "n" }), "pong:n")
  await manager.disposeAll()
})

test("a host crash leaves the manager ready to load its plugins again", async (t) => {
  const { pluginsDir } = pluginsFixture(t)
  const hosts = loopbackHosts()
  let manager = null
  const { client: host } = client(t, hosts, {
    onCrash: ({ reason }) => manager.handleHostExit(reason),
  })
  manager = new PluginManager({ host })
  manager._pluginsDir = pluginsDir
  await manager.loadPlugin("demo")
  hosts.spawned[0].exit(9)
  await waitFor(() => !manager.plugins.has("demo"))
  const [listed] = manager.listPlugins()
  assert.equal(listed.status, "error")
  assert.match(listed.error, /plugin host exited/)
  assert.equal(await manager.sendToPlugin("demo", "ping", { value: "back" }), "pong:back")
  assert.equal(hosts.spawned.length, 2)
  assert.equal(manager.listPlugins()[0].status, "active")
  await manager.disposeAll()
})

test("the plugin host is opt-in", () => {
  assert.equal(usePluginHost({}), false)
  assert.equal(usePluginHost({ BETTERC0DE_PLUGIN_HOST: "1" }), false)
  assert.equal(usePluginHost({ BETTERC0DE_PLUGIN_HOST: "utility" }), true)
})

// ── Across a real process boundary ───────────────────────────────────────

test("plugins run in a separate process; a crash there leaves this process running", async (t) => {
  const { pluginDir, entryPath } = pluginsFixture(t)
  const crashes = []
  const faults = []
  const host = createPluginHostClient({
    spawnHost: () => spawnNodePluginHost(),
    onCrash: (crash) => crashes.push(crash),
    onFault: (pluginId, error) => faults.push({ pluginId, error }),
    terminate: async (child) => child.kill(),
    log: quiet,
    baseDelayMs: 10,
    maxDelayMs: 50,
  })
  t.after(() => host.dispose())

  const proxy = await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  assert.equal(await proxy.ping({ value: "ipc" }), "pong:ipc")
  const hostPid = await proxy.pid({})
  assert.equal(typeof hostPid, "number")
  assert.notEqual(hostPid, process.pid)

  // A plugin's own timer throwing is attributed to it; the host survives.
  assert.equal(await proxy.lateThrow({}), true)
  await waitFor(() => faults.length === 1)
  assert.equal(faults[0].pluginId, "demo")
  assert.equal(await proxy.ping({ value: "alive" }), "pong:alive")

  // A plugin ending its process takes only the host down.
  await assert.rejects(proxy.exitNow({ code: 7 }), (error) => error.code === "PLUGIN_HOST_EXITED")
  await waitFor(() => crashes.length === 1)
  assert.match(crashes[0].reason, /exit code 7/)
  assert.deepEqual(crashes[0].pluginIds, ["demo"])

  const reloaded = await host.loadPlugin({ pluginId: "demo", pluginDir, entryPath })
  const newPid = await reloaded.pid({})
  assert.notEqual(newPid, hostPid)
  assert.equal(await reloaded.ping({ value: "restarted" }), "pong:restarted")
})
