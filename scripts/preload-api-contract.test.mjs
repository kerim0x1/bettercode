// The preload's `window.electronAPI` against its one source of truth,
// `PreloadApi` in apps/shell/shared/ipc-contract.cjs, and the renderer's
// hand-written view of it (apps/ui/src/types/electron-api.d.ts).
//
// The sandboxed preload cannot require the registry, so it repeats every
// member and channel; this runs the real preload and fails as soon as the
// two drift apart, or the renderer's type names a different set of members.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const { IpcChannel, IpcEvent, PreloadApi } = require("../apps/shell/shared/ipc-contract.cjs")

const preloadSource = readFileSync(new URL("../apps/shell/preload.cjs", import.meta.url), "utf8")
const electronApiTypes = readFileSync(new URL("../apps/ui/src/types/electron-api.d.ts", import.meta.url), "utf8")

/** Run the preload against a recording ipcRenderer; returns what it exposed. */
function loadPreload() {
  const calls = []
  let exposed = null
  let exposedName = null
  runInNewContext(preloadSource, {
    process: { platform: "linux" },
    console: { warn() {} },
    require: (name) => {
      assert.equal(name, "electron", `the sandboxed preload may only require electron, not ${name}`)
      return {
        contextBridge: {
          exposeInMainWorld: (key, value) => {
            exposedName = key
            exposed = value
          },
        },
        ipcRenderer: {
          invoke: async (channel) => {
            calls.push({ kind: "invoke", channel })
          },
          on: (channel) => {
            calls.push({ kind: "on", channel })
          },
          removeListener: (channel) => {
            calls.push({ kind: "removeListener", channel })
          },
        },
      }
    },
  })
  return { exposed, exposedName, calls }
}

/** Member names of `interface ElectronAPI` in electron-api.d.ts. */
function electronApiMembers() {
  const source = ts.createSourceFile("electron-api.d.ts", electronApiTypes, ts.ScriptTarget.Latest, true)
  const members = []
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "ElectronAPI") {
      for (const member of node.members) {
        if (member.name) members.push(member.name.getText(source))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return members
}

const registryMembers = [
  ...Object.keys(PreloadApi.invoke),
  ...Object.keys(PreloadApi.events),
  ...PreloadApi.values,
].sort()

test("the registry is internally consistent", () => {
  assert.equal(new Set(registryMembers).size, registryMembers.length, "a member is listed twice")
  const channels = new Set(Object.values(IpcChannel))
  for (const [member, channel] of Object.entries(PreloadApi.invoke)) {
    assert.ok(channels.has(channel), `${member} invokes unknown channel ${channel}`)
  }
  for (const channel of Object.values(PreloadApi.internal)) {
    assert.ok(channels.has(channel), `internal channel ${channel} is not in IpcChannel`)
  }
  const events = new Set(Object.values(IpcEvent))
  for (const [member, event] of Object.entries(PreloadApi.events)) {
    assert.ok(events.has(event), `${member} subscribes to unknown event ${event}`)
  }
  // Every channel the main process serves is reachable from the preload.
  const reachable = new Set([...Object.values(PreloadApi.invoke), ...Object.values(PreloadApi.internal)])
  assert.deepEqual(Object.values(IpcChannel).filter((channel) => !reachable.has(channel)), [])
  assert.deepEqual(Object.values(IpcEvent).filter((event) => !Object.values(PreloadApi.events).includes(event)), [])
})

test("the preload exposes exactly the registry's members as window.electronAPI", () => {
  const { exposed, exposedName } = loadPreload()
  assert.equal(exposedName, "electronAPI")
  assert.deepEqual(Object.keys(exposed).sort(), registryMembers)
  assert.equal(exposed.platform, "linux")
  assert.equal(typeof exposed.clientInstanceId, "string")
  assert.ok(exposed.clientInstanceId.length >= 32)
})

test("the preload invokes only its client-instance channel when it loads", () => {
  const { calls } = loadPreload()
  assert.deepEqual(calls, [{ kind: "invoke", channel: PreloadApi.internal.clientInstance }])
})

test("each invoke member calls exactly the channel the registry names", async () => {
  const { exposed, calls } = loadPreload()
  for (const [member, channel] of Object.entries(PreloadApi.invoke)) {
    calls.length = 0
    await exposed[member]("a", "b", "c", "d")
    assert.deepEqual(calls, [{ kind: "invoke", channel }], member)
  }
})

test("each event member subscribes to the registry's event and unsubscribes from it", () => {
  const { exposed, calls } = loadPreload()
  for (const [member, event] of Object.entries(PreloadApi.events)) {
    calls.length = 0
    const unsubscribe = exposed[member](() => {})
    assert.equal(typeof unsubscribe, "function", member)
    assert.deepEqual(calls.filter((call) => call.kind === "on"), [{ kind: "on", channel: event }], member)
    unsubscribe()
    assert.deepEqual(
      calls.filter((call) => call.kind === "removeListener"),
      [{ kind: "removeListener", channel: event }],
      member,
    )
    // The only other traffic is the preview feed's own subscription switch.
    for (const call of calls.filter((entry) => entry.kind === "invoke")) {
      assert.equal(call.channel, PreloadApi.internal.previewRequestSubscription, member)
    }
  }
})

test("electron-api.d.ts names exactly the members the preload exposes", () => {
  const declared = electronApiMembers()
  assert.ok(declared.length > 0, "interface ElectronAPI not found in electron-api.d.ts")
  assert.equal(new Set(declared).size, declared.length, "electron-api.d.ts declares a member twice")
  const { exposed } = loadPreload()
  const actual = Object.keys(exposed)
  assert.deepEqual(
    declared.filter((name) => !actual.includes(name)).sort(),
    [],
    "declared in electron-api.d.ts but not exposed by the preload",
  )
  assert.deepEqual(
    actual.filter((name) => !declared.includes(name)).sort(),
    [],
    "exposed by the preload but missing from electron-api.d.ts",
  )
})

test("the preload's object is typed from the registry", () => {
  assert.match(
    preloadSource,
    /\/\*\* @type \{import\("\.\/shared\/ipc-contract\.cjs"\)\.PreloadElectronApi\} \*\/\s*const electronAPI = \{/,
  )
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\("electronAPI", electronAPI\)/)
})
