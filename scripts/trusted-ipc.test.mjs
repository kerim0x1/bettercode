import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const source = readFileSync(new URL("../apps/shell/shared/trusted-ipc.cjs", import.meta.url), "utf8")
const mainSource = readFileSync(new URL("../apps/shell/main.cjs", import.meta.url), "utf8")
const factorySource = readFileSync(
  new URL("../apps/shell/shared/ipc-handlers-factory.cjs", import.meta.url),
  "utf8",
)

/** A stand-in for Electron's ipcMain: invoke handlers plus an EventEmitter. */
function fakeIpcMain() {
  const emitter = new EventEmitter()
  const handlers = new Map()
  emitter.handle = (channel, handler) => {
    if (handlers.has(channel)) throw new Error(`duplicate handler ${channel}`)
    handlers.set(channel, handler)
  }
  emitter.handleOnce = (channel, handler) => emitter.handle(channel, handler)
  emitter.invoke = (channel, event, ...args) => handlers.get(channel)(event, ...args)
  return emitter
}

function load(ipcMain) {
  const module = { exports: {} }
  const warnings = []
  runInNewContext(source, {
    module,
    console: { warn: (...args) => warnings.push(args.join(" ")) },
    require: (name) => {
      if (name === "electron") return { ipcMain }
      throw new Error(`unexpected ${name}`)
    },
  })
  return { ipc: module.exports, warnings }
}

const trusted = { sender: { id: 1 } }
const untrusted = { sender: { id: 2 } }
const trustOnlyOne = (event, channel) => {
  if (event?.sender?.id !== 1) throw new Error(`Rejected IPC from untrusted sender for ${channel}`)
}

test("handlers are refused until a sender policy is configured, then checked on every call", async () => {
  const ipcMain = fakeIpcMain()
  const { ipc } = load(ipcMain)
  let calls = 0
  ipc.registerHandler("app:thing", (_event, value) => {
    calls += 1
    return value * 2
  })
  await assert.rejects(ipcMain.invoke("app:thing", trusted, 2), /sender policy "trusted-renderer" is not configured/)
  ipc.configureIpcSenderPolicy("trusted-renderer", trustOnlyOne)
  assert.equal(await ipcMain.invoke("app:thing", trusted, 2), 4)
  await assert.rejects(ipcMain.invoke("app:thing", untrusted, 2), /untrusted sender/)
  assert.equal(calls, 1)
})

test("argument validators can reject or replace the arguments", async () => {
  const ipcMain = fakeIpcMain()
  const { ipc } = load(ipcMain)
  ipc.configureIpcSenderPolicy("trusted-renderer", trustOnlyOne)
  ipc.registerHandler("app:echo", (_event, ...args) => args, {
    validate: (args) => {
      if (typeof args[0] !== "string") throw new TypeError("text expected")
      return [args[0].trim()]
    },
  })
  assert.deepEqual(await ipcMain.invoke("app:echo", trusted, "  hi  ", "extra"), ["hi"])
  await assert.rejects(ipcMain.invoke("app:echo", trusted, 3), /text expected/)
})

test("a handler can opt into a different sender policy, which is not the default one", async () => {
  const ipcMain = fakeIpcMain()
  const { ipc } = load(ipcMain)
  ipc.configureIpcSenderPolicy("trusted-renderer", trustOnlyOne)
  ipc.configureIpcSenderPolicy(ipc.PREVIEW_GUEST_SENDER_POLICY, (event) => {
    if (event.sender.id !== 9) throw new Error("not a guest")
  })
  ipc.registerHandler("guest:gate", () => true, { sender: ipc.PREVIEW_GUEST_SENDER_POLICY })
  assert.equal(await ipcMain.invoke("guest:gate", { sender: { id: 9 } }), true)
  await assert.rejects(ipcMain.invoke("guest:gate", trusted), /not a guest/)
})

test("the guard checks direct ipcMain registrations, including on/once listeners", async () => {
  const ipcMain = fakeIpcMain()
  const { ipc, warnings } = load(ipcMain)
  ipc.configureIpcSenderPolicy("trusted-renderer", trustOnlyOne)
  ipc.installIpcMainGuard()
  ipc.installIpcMainGuard()
  assert.equal(ipc.isIpcMainGuardInstalled(), true)

  ipcMain.handle("legacy:handle", () => "ok")
  await assert.rejects(ipcMain.invoke("legacy:handle", untrusted), /untrusted sender/)
  assert.equal(await ipcMain.invoke("legacy:handle", trusted), "ok")

  // Explicit registrations are not wrapped twice.
  let checks = 0
  ipc.configureIpcSenderPolicy("trusted-renderer", (event, channel) => {
    checks += 1
    trustOnlyOne(event, channel)
  })
  ipc.registerHandler("explicit:handle", () => "fine")
  assert.equal(await ipcMain.invoke("explicit:handle", trusted), "fine")
  assert.equal(checks, 1)

  const received = []
  const listener = (_event, value) => received.push(value)
  ipcMain.on("legacy:send", listener)
  ipcMain.emit("legacy:send", untrusted, "dropped")
  ipcMain.emit("legacy:send", trusted, "kept")
  assert.deepEqual(received, ["kept"])
  assert.match(warnings.join("\n"), /dropped legacy:send/)
  ipcMain.removeListener("legacy:send", listener)
  assert.equal(ipcMain.listenerCount("legacy:send"), 0)

  const once = []
  ipcMain.once("legacy:once", (_event, value) => once.push(value))
  ipcMain.emit("legacy:once", trusted, "first")
  ipcMain.emit("legacy:once", trusted, "second")
  assert.deepEqual(once, ["first"])

  const unsubscribe = ipc.registerListener("explicit:send", (_event, value) => received.push(value))
  ipcMain.emit("explicit:send", untrusted, "no")
  ipcMain.emit("explicit:send", trusted, "yes")
  unsubscribe()
  ipcMain.emit("explicit:send", trusted, "after")
  assert.deepEqual(received, ["kept", "yes"])
})

test("a target without on/handleOnce is guarded without errors", () => {
  const handles = []
  const ipcMain = { handle: (channel) => handles.push(channel) }
  const { ipc } = load(ipcMain)
  ipc.installIpcMainGuard()
  ipcMain.handle("only:handle", () => {})
  ipc.registerHandler("only:explicit", () => {})
  assert.deepEqual(handles, ["only:handle", "only:explicit"])
})

test("main.cjs installs the guard before any IPC module is required and drops the monkey-patch", () => {
  const guard = mainSource.indexOf("installIpcMainGuard()")
  const firstIpcModule = mainSource.indexOf('require("./plugin-ipc.cjs")')
  assert.ok(guard > 0 && guard < firstIpcModule)
  assert.doesNotMatch(mainSource, /ipcMain\.handle\s*=/)
  assert.match(mainSource, /configureIpcSenderPolicy\("trusted-renderer"/)
  assert.match(mainSource, /app\.on\("web-contents-created"/)
  // The factory registers through the checked path, not ipcMain directly.
  assert.match(factorySource, /registerHandler\(channel, makeSafeWrapper\(handler\)/)
  assert.doesNotMatch(factorySource, /ipcMain\.handle\(/)
})

test("the shell's own IPC modules register explicitly, never through ipcMain directly", async () => {
  const { readdirSync } = await import("node:fs")
  const shellDir = new URL("../apps/shell/", import.meta.url)
  const files = [
    ...readdirSync(shellDir).filter((name) => name.endsWith(".cjs")),
    ...readdirSync(new URL("shared/", shellDir))
      .filter((name) => name.endsWith(".cjs") && name !== "trusted-ipc.cjs")
      .map((name) => `shared/${name}`),
  ]
  const direct = /\bipcMain\s*\.\s*(handle|handleOnce|on|once)\s*\(/
  for (const file of files) {
    const text = readFileSync(new URL(file, shellDir), "utf8")
    assert.doesNotMatch(text, direct, `${file} registers an IPC handler directly`)
  }
})
