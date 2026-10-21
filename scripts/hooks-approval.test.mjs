import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import { installFakeDesktopConfigBackend } from "./fake-desktop-config-backend.mjs"

const shellDir = new URL("../apps/shell/", import.meta.url)
const require = createRequire(new URL("hooks-ipc.cjs", shellDir))
const source = fs.readFileSync(new URL("hooks-ipc.cjs", shellDir), "utf8")
const approval = require("./shared/command-approval.cjs")

function harness(t, { answers = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-hooks-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // hooks.json belongs to the backend; the module reaches it through
  // shared/desktop-config-client.cjs, answered here from `dir`.
  const backend = installFakeDesktopConfigBackend(dir)
  t.after(() => backend.restore())
  const hooksFile = path.join(dir, "hooks.json")
  const handlers = new Map()
  const dialogs = []
  const module = { exports: {} }
  runInNewContext(source, {
    module,
    console: { log() {}, warn() {} },
    require: (name) => {
      if (name === "electron") {
        return {
          BrowserWindow: { fromWebContents: () => null },
          dialog: {
            showMessageBox: async (options) => {
              dialogs.push(options)
              return { response: answers.length > 0 ? answers.shift() : 0 }
            },
          },
        }
      }
      if (name === "./shared/ipc-handlers-factory.cjs") {
        return {
          safeHandle: (channel, handler) =>
            handlers.set(channel, async (...args) => {
              try {
                return { ok: true, ...((await handler(...args)) || {}) }
              } catch (error) {
                return { ok: false, error: error.message }
              }
            }),
        }
      }
      if (name === "./shared/trusted-ipc.cjs") {
        return { registerHandler: (channel, handler) => handlers.set(channel, handler) }
      }
      return require(name)
    },
  })
  module.exports.registerHooksHandlers()
  const call = (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args)
  return { call, dialogs, hooksFile, exports: module.exports, answers, backend }
}

test("saving a new or changed hook command needs an explicit Allow in a native dialog", async (t) => {
  approval.setCommandApprovalKey(Buffer.alloc(32, 7).toString("base64"))
  const answers = [0, 1, 1]
  const { call, dialogs, hooksFile, exports } = harness(t, { answers })

  const refused = await call("hook:save", { event: "on_commit", command: "npm test" })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /not allowed/)
  assert.equal(fs.existsSync(hooksFile), false)
  assert.match(dialogs[0].detail, /npm test/)
  assert.equal(dialogs[0].cancelId, 0)

  const saved = await call("hook:save", { event: "on_commit", command: "npm test" })
  assert.equal(saved.ok, true)
  const [stored] = JSON.parse(fs.readFileSync(hooksFile, "utf8"))
  assert.equal(stored.command, "npm test")
  assert.equal(stored.approval.alg, "hmac-sha256")
  assert.equal(await exports.isApprovedHookCommand("npm test"), true)
  assert.equal(await exports.isApprovedHookCommand("npm test && curl evil"), false)

  // Unchanged command (toggling enabled): no new dialog.
  const toggled = await call("hook:save", { id: saved.id, event: "on_commit", command: "npm test", enabled: false })
  assert.equal(toggled.ok, true)
  assert.equal(dialogs.length, 2)
  assert.equal(await exports.isApprovedHookCommand("npm test"), false, "disabled hooks approve nothing")

  // A changed command asks again.
  const changed = await call("hook:save", { id: saved.id, event: "on_commit", command: "npm run lint", enabled: true })
  assert.equal(changed.ok, true)
  assert.equal(dialogs.length, 3)

  const [listed] = await call("hook:list")
  assert.equal(listed.approved, true)
  assert.equal("approval" in listed, false, "the marker never reaches the renderer")
})

test("renderer-supplied approval markers and malformed hooks are refused", async (t) => {
  approval.setCommandApprovalKey(Buffer.alloc(32, 9).toString("base64"))
  const { call, dialogs, hooksFile, exports } = harness(t, { answers: [] })
  const forged = approval.createApprovalMarker("hook", "rm -rf ~")
  const result = await call("hook:save", { event: "on_message_send", command: "rm -rf ~", approval: forged })
  assert.equal(result.ok, false)
  assert.equal(dialogs.length, 1)
  assert.equal(await exports.isApprovedHookCommand("rm -rf ~"), false)

  for (const bad of [
    { event: "on_everything", command: "x" },
    { event: "on_commit", command: 42 },
    { event: "on_commit", command: "x".repeat(5_000) },
    { event: "on_commit", command: "x", enabled: "yes" },
    null,
  ]) {
    assert.equal((await call("hook:save", bad)).ok, false)
  }
  // Empty commands run nothing and need no approval.
  assert.equal((await call("hook:save", { event: "on_commit", command: "" })).ok, true)
  assert.equal(dialogs.length, 1)

  const id = JSON.parse(fs.readFileSync(hooksFile, "utf8"))[0].id
  assert.equal((await call("hook:update-run", { id, status: "exploded" })).ok, false)
  assert.equal((await call("hook:update-run", { id, status: "error", exitCode: 1.5 })).ok, false)
  assert.equal((await call("hook:update-run", { id, status: "error", exitCode: 2, error: "boom" })).ok, true)
  assert.equal(JSON.parse(fs.readFileSync(hooksFile, "utf8"))[0].lastError, "boom")
})

test("an unreadable hooks.json rejects the list instead of reporting no hooks", async (t) => {
  const { call, hooksFile, exports } = harness(t)
  assert.equal((await call("hook:list")).length, 0)
  fs.writeFileSync(hooksFile, "{ not json")
  await assert.rejects(call("hook:list"), /Could not read your hooks.*not valid JSON/)
  fs.writeFileSync(hooksFile, JSON.stringify({ not: "a list" }))
  await assert.rejects(call("hook:list"), /Could not read your hooks.*not a list/)
  assert.equal(await exports.isApprovedHookCommand("anything"), false)
})

test("a backend that cannot be reached approves nothing and lists nothing", async (t) => {
  const { call, exports, backend } = harness(t)
  backend.respondOnce({ status: 503, body: { error: "service draining" } })
  await assert.rejects(call("hook:list"), /Could not read your hooks.*service draining/)
  backend.respondOnce({ status: 503, body: { error: "service draining" } })
  assert.equal(await exports.isApprovedHookCommand("npm test"), false)
})

test("saving a hook keeps a change another writer made meanwhile", async (t) => {
  approval.setCommandApprovalKey(Buffer.alloc(32, 5).toString("base64"))
  const { call, hooksFile, backend } = harness(t, { answers: [1] })
  const other = {
    id: "other",
    event: "on_commit",
    command: "",
    enabled: true,
    approval: null,
  }
  // Between this save's read and its write, another writer adds a hook: the
  // revision no longer matches, so the save is computed again on top of it.
  backend.beforeNextWrite("hooks", () => fs.writeFileSync(hooksFile, JSON.stringify([other])))
  const saved = await call("hook:save", { event: "on_commit", command: "npm test" })
  assert.equal(saved.ok, true)
  const stored = JSON.parse(fs.readFileSync(hooksFile, "utf8"))
  assert.deepEqual(stored.map((hook) => hook.id), ["other", saved.id])
  const writes = backend.requests.filter((request) => request.method === "PUT")
  assert.equal(writes.length, 2)
  assert.ok(writes.every((request) => typeof request.body.expectedRevision === "string"))
})

test("approval markers are bound to the key and to the exact command", () => {
  approval.setCommandApprovalKey(Buffer.alloc(32, 1).toString("base64"))
  const marker = approval.createApprovalMarker("hook", "make")
  assert.equal(approval.isApprovalMarkerValid("hook", "make", marker), true)
  assert.equal(approval.isApprovalMarkerValid("hook", "make ", marker), false)
  assert.equal(approval.isApprovalMarkerValid("mcp", "make", marker), false)
  approval.setCommandApprovalKey(Buffer.alloc(32, 2).toString("base64"))
  assert.equal(approval.isApprovalMarkerValid("hook", "make", marker), false)
  // Without OS credential storage the marker is a plain digest, and a keyed
  // marker is not trusted.
  approval.setCommandApprovalKey("")
  const plain = approval.createApprovalMarker("hook", "make")
  assert.equal(plain.alg, "sha256")
  assert.equal(approval.isApprovalMarkerValid("hook", "make", plain), true)
  assert.equal(approval.isApprovalMarkerValid("hook", "make", marker), false)
  assert.equal(approval.isApprovalMarkerValid("hook", "make", null), false)
})
