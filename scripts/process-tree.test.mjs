import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

const { collectDescendants, killProcesses, listDescendantProcesses, parseProcessTable } =
  createRequire(import.meta.url)("../apps/shell/shared/process-tree.cjs")

const table = `
    1     0     1
  100     1   100
  200   100   200
  201   200   200
  300   200   300
  400   300   400
  500     1   500
  garbage line
`

test("parses ps output and walks the whole tree below the backend", () => {
  const rows = parseProcessTable(table)
  assert.equal(rows.length, 7)
  const descendants = collectDescendants(rows, 200)
  assert.deepEqual(descendants.map((row) => row.pid).sort(), [201, 300, 400])
  assert.deepEqual(collectDescendants(rows, 999), [])
})

test("kills each process and each separate group, never itself or init", () => {
  const signals = []
  const groups = killProcesses(
    [{ pid: 201, pgid: 200 }, { pid: 300, pgid: 300 }, { pid: 400, pgid: 400 }, { pid: 1, pgid: 1 }, { pid: 77, pgid: 77 }],
    { ownPid: 77, kill: (pid, signal) => signals.push([pid, signal]) },
  )
  assert.equal(groups, 3)
  assert.deepEqual(signals.map(([pid]) => pid).sort((a, b) => a - b), [-400, -300, -200, 201, 300, 400])
  assert.ok(signals.every(([, signal]) => signal === "SIGKILL"))
})

test("a failed or unavailable ps yields no processes", async () => {
  assert.deepEqual(await listDescendantProcesses(200, {
    platform: "linux",
    execFileImpl: (_file, _args, _options, callback) => callback(new Error("ps missing")),
  }), [])
  assert.deepEqual(await listDescendantProcesses(200, { platform: "win32" }), [])
  assert.deepEqual(await listDescendantProcesses(1, { platform: "linux" }), [])
})

test("uses ps from a fixed location", async () => {
  let call
  const result = await listDescendantProcesses(200, {
    platform: "darwin",
    execFileImpl: (file, args, options, callback) => {
      call = { file, args, options }
      callback(null, table)
    },
  })
  assert.equal(call.file, "/bin/ps")
  assert.deepEqual(call.args, ["-A", "-o", "pid=,ppid=,pgid="])
  assert.deepEqual(result.map((row) => row.pid).sort(), [201, 300, 400])
})
