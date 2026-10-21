import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import test from "node:test"

const { createRotatingLogFile } = createRequire(import.meta.url)("../apps/shell/shared/rotating-log-file.cjs")

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-log-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, "logs")
}

const manualTimers = () => {
  const pending = []
  return {
    pending,
    api: {
      setTimeout: (callback, delay) => {
        const handle = { callback, delay, unref() {} }
        pending.push(handle)
        return handle
      },
      clearTimeout: (handle) => {
        const index = pending.indexOf(handle)
        if (index >= 0) pending.splice(index, 1)
      },
    },
  }
}

test("buffers lines and appends them in one batch", async (t) => {
  const dir = directory(t)
  const timers = manualTimers()
  const log = createRotatingLogFile({ directory: dir, timers: timers.api })
  log.write("first")
  log.write("second")
  assert.equal(fs.existsSync(log.path), false)
  assert.equal(timers.pending.length, 1)
  await log.flush()
  assert.equal(fs.readFileSync(log.path, "utf8"), "first\nsecond\n")
})

test("rotates at the size cap and keeps a bounded number of generations", async (t) => {
  const dir = directory(t)
  const log = createRotatingLogFile({ directory: dir, maxBytes: 4096, maxFiles: 3, timers: manualTimers().api })
  const line = "x".repeat(1500)
  for (let batch = 0; batch < 8; batch += 1) {
    log.write(`${batch}:${line}`)
    log.write(`${batch}:${line}`)
    await log.flush()
  }
  const files = fs.readdirSync(dir).sort()
  assert.deepEqual(files, ["app.log", "app.log.1", "app.log.2"])
  for (const file of files) {
    assert.ok(fs.statSync(path.join(dir, file)).size <= 4096, file)
  }
  assert.match(fs.readFileSync(path.join(dir, "app.log"), "utf8"), /^7:/)
})

test("synchronous flush writes everything still buffered", (t) => {
  const dir = directory(t)
  const log = createRotatingLogFile({ directory: dir, timers: manualTimers().api })
  log.write("before crash")
  log.flushSync()
  assert.equal(fs.readFileSync(log.path, "utf8"), "before crash\n")
  log.close()
  log.write("after close")
  log.flushSync()
  assert.equal(fs.readFileSync(log.path, "utf8"), "before crash\n")
})

test("truncates an oversized line and drops the oldest lines when the disk lags", async (t) => {
  const dir = directory(t)
  const log = createRotatingLogFile({
    directory: dir, maxBytes: 8192, maxPendingBytes: 3000, timers: manualTimers().api,
  })
  log.write("y".repeat(10_000))
  for (let i = 0; i < 20; i += 1) log.write(`line ${i} ${"z".repeat(200)}`)
  await log.flush()
  const content = fs.readFileSync(log.path, "utf8")
  assert.match(content, /line\(s\) dropped/)
  assert.match(content, /line 19/)
  assert.doesNotMatch(content, /y{3000}/)
})

test("stops writing after repeated failures instead of throwing", async (t) => {
  const dir = directory(t)
  const failures = []
  const failingFs = {
    ...fs,
    promises: { appendFile: async () => { throw new Error("disk full") } },
  }
  const log = createRotatingLogFile({
    directory: dir, fsImpl: failingFs, timers: manualTimers().api,
    reportFailure: (message) => failures.push(message),
  })
  for (let i = 0; i < 4; i += 1) {
    log.write(`line ${i}`)
    await log.flush()
  }
  assert.equal(failures.length, 1)
  assert.match(failures[0], /disk full/)
  assert.doesNotThrow(() => log.write("ignored"))
})

test("requires an absolute directory", () => {
  assert.throws(() => createRotatingLogFile({ directory: "relative/logs" }), /absolute/)
})
