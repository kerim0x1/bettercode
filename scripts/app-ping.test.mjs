import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import test from "node:test"

const { forgetInstallId, getOrCreateInstallId, readInstallId, startAppPing } =
  createRequire(import.meta.url)("../apps/shell/shared/app-ping.cjs")

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-ping-test-"))
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith("betterc0de-ping-test-"))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function setup(t, overrides = {}) {
  const dataDir = profile(t)
  let fire
  let delay
  let cleared = false
  const calls = []
  const stop = startAppPing({
    dataDir, appVersion: "0.1.0-beta.1", os: "win32", arch: "x64",
    setTimeoutImpl: (callback, ms) => { fire = callback; delay = ms; return { unref() {} } },
    clearTimeoutImpl: () => { cleared = true },
    fetchImpl: async (...args) => { calls.push(args); return new Response(null, { status: 204 }) },
    ...overrides,
  })
  t.after(stop)
  return { dataDir, fire: () => fire(), delay, calls, stop, cleared: () => cleared }
}

test("creates a persistent random installation ID and reuses it across startups", (t) => {
  const dir = profile(t)
  const id = getOrCreateInstallId(dir)
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(getOrCreateInstallId(dir), id)
  assert.equal(readInstallId(dir), id)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "installation.json"), "utf8")), { id })
  assert.notEqual(getOrCreateInstallId(profile(t)), id)
})

test("reading never creates an identity", (t) => {
  const dir = profile(t)
  assert.equal(readInstallId(dir), null)
  assert.equal(fs.existsSync(path.join(dir, "installation.json")), false)
})

test("forgetting removes a previously created identity", (t) => {
  const dir = profile(t)
  getOrCreateInstallId(dir)
  assert.equal(forgetInstallId(dir), true)
  assert.equal(readInstallId(dir), null)
  assert.equal(forgetInstallId(dir), true)
})

test("repairs invalid saved identity once and then keeps the replacement", (t) => {
  const dir = profile(t)
  fs.writeFileSync(path.join(dir, "installation.json"), '{"id":"invalid"}')
  const id = getOrCreateInstallId(dir)
  assert.notEqual(id, "invalid")
  assert.equal(getOrCreateInstallId(dir), id)
})

test("sends exactly one ping per start, after a delay, with the requested payload", async (t) => {
  const ping = setup(t)
  assert.equal(ping.delay, 30_000)
  assert.equal(ping.calls.length, 0)
  // Nothing is written before the ping is actually due.
  assert.equal(fs.existsSync(path.join(ping.dataDir, "installation.json")), false)
  await ping.fire()
  assert.equal(ping.calls.length, 1)
  const [url, options] = ping.calls[0]
  assert.equal(url, "https://betterc0de.com/api/ping")
  assert.equal(options.method, "POST")
  assert.deepEqual(options.headers, { "Content-Type": "application/json" })
  assert.deepEqual(JSON.parse(options.body), {
    id: readInstallId(ping.dataDir), appVersion: "0.1.0-beta.1", os: "win32", arch: "x64",
  })
  assert.equal(options.redirect, "error")
})

test("offline failures are swallowed and not retried", async (t) => {
  let calls = 0
  const ping = setup(t, { fetchImpl: async () => { calls += 1; throw new Error("offline") } })
  await assert.doesNotReject(ping.fire())
  assert.equal(calls, 1)
})

test("stopping cancels a pending ping and aborts an in-flight one", async (t) => {
  let signal
  const ping = setup(t, { fetchImpl: (_url, options) => {
    signal = options.signal
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  } })
  const inFlight = ping.fire()
  ping.stop()
  await inFlight
  assert.equal(signal.aborted, true)
  assert.equal(ping.cleared(), true)

  const cancelled = setup(t)
  cancelled.stop()
  await cancelled.fire()
  assert.equal(cancelled.calls.length, 0)
})

test("times out a stalled request", async (t) => {
  let aborted = false
  const ping = setup(t, { timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason) }, { once: true })
  }) })
  await ping.fire()
  assert.equal(aborted, true)
})

test("an unwritable identity location sends nothing", async (t) => {
  const dir = profile(t)
  const file = path.join(dir, "file-not-directory")
  fs.writeFileSync(file, "test")
  let calls = 0
  const ping = setup(t, { dataDir: file, fetchImpl: async () => { calls += 1; return new Response(null) } })
  await ping.fire()
  assert.equal(calls, 0)
})
