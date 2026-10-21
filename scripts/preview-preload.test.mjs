import assert from "node:assert/strict"
import fs from "node:fs"
import { runInNewContext } from "node:vm"
import { test } from "node:test"

function preload({ gate = async () => true, now = () => 0 } = {}) {
  const sent = []
  const scripts = []
  const listeners = new Map()
  const gateRequests = []
  let bridge
  runInNewContext(fs.readFileSync(new URL("../apps/shell/browser-preview-preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "win32", argv: [] },
    window: { addEventListener() {} },
    document: { addEventListener: (name, listener) => listeners.set(name, listener) },
    console,
    Date: { now },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value } },
      ipcRenderer: {
        sendToHost: (...args) => sent.push(args),
        invoke: (channel, ...args) => {
          gateRequests.push([channel, ...args])
          return gate(channel, ...args)
        },
      },
      webFrame: { executeJavaScript: async (script) => { scripts.push(script) } },
    }),
  })
  return { sent, scripts, listeners, bridge, gateRequests }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("page bridge cannot forge trusted keyboard notifications", () => {
  const { bridge, sent, listeners } = preload()
  bridge.send("keyboard-shortcut", { shortcut: "open-devtools" })
  bridge.send("did-keydown", { key: "F12" })
  assert.equal(sent.length, 0)
  listeners.get("keydown")({ isTrusted: true, key: "F12", preventDefault() {} })
  assert.equal(sent[0][0], "keyboard-shortcut")
  assert.equal(sent[0][1].shortcut, "open-devtools")
  // Only modifier presses reach the host; typed keys stay in the page.
  assert.equal(sent.some(([channel]) => channel === "did-keydown"), false)
})

test("only modifier keydowns are forwarded to the host", () => {
  const { sent, listeners } = preload()
  const keydown = listeners.get("keydown")
  for (const key of ["a", "Enter", "p", "Backspace"]) {
    keydown({ isTrusted: true, key, preventDefault() {} })
  }
  assert.equal(sent.length, 0)
  keydown({ isTrusted: true, key: "Control", ctrlKey: true, preventDefault() {} })
  keydown({ isTrusted: true, key: "Alt", altKey: true, preventDefault() {} })
  assert.deepEqual(sent.map(([channel, data]) => [channel, data.key]), [
    ["did-keydown", "Control"],
    ["did-keydown", "Alt"],
  ])
  assert.equal("code" in sent[0][1], false)
  assert.equal("keyCode" in sent[0][1], false)
})

test("element selections reach the host only when the main process allows them", async () => {
  let allow = false
  const { bridge, sent, gateRequests } = preload({ gate: async () => allow })
  bridge.send("element-selected", { selector: "#denied" })
  await settle()
  assert.equal(sent.length, 0)
  assert.deepEqual(gateRequests[0], ["preview-guest:gate", "element-selected"])

  allow = true
  bridge.send("element-selected", { selector: "#demo" })
  await settle()
  assert.deepEqual(sent, [["element-selected", { selector: "#demo" }]])

  // A refused or failed gate drops the message rather than throwing into the page.
  const failing = preload({ gate: async () => { throw new Error("gone") } })
  failing.bridge.send("element-selected", { selector: "#x" })
  await settle()
  assert.equal(failing.sent.length, 0)
})

test("page-driven channels are rate-limited per second", () => {
  let clock = 0
  const { bridge, sent } = preload({ now: () => clock })
  for (let index = 0; index < 30; index += 1) bridge.send("dom-tree", { tree: null })
  assert.equal(sent.length, 10)
  clock = 1000
  bridge.send("dom-tree", { tree: null })
  assert.equal(sent.length, 11)
  for (let index = 0; index < 100; index += 1) bridge.send("console-batch", { entries: [] })
  assert.equal(sent.length, 11 + 50)
})

test("dialog instrumentation bounds retained history while preserving prompt results", () => {
  const { scripts } = preload()
  const page = { console: { log() {} } }
  page.window = page
  runInNewContext(scripts.find(script => script.includes("__bcDialogOverridesApplied")), page)
  const large = "x".repeat(20_000)
  for (let index = 0; index < 1200; index += 1) page.alert(large)
  assert.ok(page.__bcGetDialogHistory().length <= 1000)
  assert.ok(page.__bcGetDialogHistory()[0].message.length <= 4096)
  assert.equal(page.prompt("question", large), large)
  const prompt = page.__bcGetDialogHistory().at(-1)
  assert.ok(prompt.defaultValue.length <= 4096)
  assert.ok(prompt.result.length <= 4096)
  assert.equal(page.confirm("confirm"), true)
  assert.equal(page.__bcGetDialogHistory().at(-1).result, true)
})
