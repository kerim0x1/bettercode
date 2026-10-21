import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { EventEmitter } from "node:events"
import vm from "node:vm"
import test from "node:test"

test("disposing a backend status observer leaves other windows' consumers subscribed", () => {
  const ipc = new EventEmitter()
  // The preload reports its page-load client id over invoke when it loads.
  ipc.invoke = async () => undefined
  let api
  vm.runInNewContext(readFileSync(new URL("../apps/shell/preload.cjs", import.meta.url), "utf8"), {
    process: { platform: process.platform },
    require: () => ({
      ipcRenderer: ipc,
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value } },
    }),
  })
  const first = []
  const second = []
  const disposeFirst = api.onBackendStatus(event => first.push(event.status))
  const disposeSecond = api.onBackendStatus(event => second.push(event.status))
  ipc.emit("backend:status", {}, { status: "restarting" })
  disposeFirst()
  ipc.emit("backend:status", {}, { status: "ready" })
  assert.deepEqual(first, ["restarting"])
  assert.deepEqual(second, ["restarting", "ready"])
  disposeSecond()
  assert.equal(ipc.listenerCount("backend:status"), 0)
})
