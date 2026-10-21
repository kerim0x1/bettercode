import assert from "node:assert/strict"
import http from "node:http"
import { createRequire } from "node:module"
import test from "node:test"

const { createBackendSupervisor, probeBackendHealth, restartDelayMs } =
  createRequire(import.meta.url)("../apps/shell/shared/backend-supervisor.cjs")

function harness(overrides = {}) {
  let now = 0
  const timers = []
  const statuses = []
  const restarts = []
  const terminated = []
  let probeResult = true
  let quitting = false
  const supervisor = createBackendSupervisor({
    restart: async (reason) => {
      restarts.push(reason)
      if (overrides.restartFails) throw new Error("spawn failed")
    },
    emitStatus: (status, payload) => statuses.push({ status, ...payload }),
    probe: async () => probeResult,
    terminate: async (reason) => { terminated.push(reason) },
    isQuitting: () => quitting,
    log: { warn() {}, error() {} },
    now: () => now,
    timers: {
      setTimeout: (callback, delay) => {
        const handle = { callback, due: now + delay, cleared: false }
        timers.push(handle)
        return handle
      },
      clearTimeout: (handle) => { if (handle) handle.cleared = true },
    },
    livenessIntervalMs: 20_000,
    livenessMaxMisses: 3,
    ...overrides,
  })
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  return {
    supervisor, statuses, restarts, terminated,
    setProbe: (value) => { probeResult = value },
    quit: () => { quitting = true },
    pending: () => timers.filter((handle) => !handle.cleared),
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const next = timers
          .filter((handle) => !handle.cleared && handle.due <= target)
          .sort((a, b) => a.due - b.due)[0]
        if (!next) break
        now = next.due
        next.cleared = true
        next.callback()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

test("backoff doubles per attempt and is capped", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((attempt) => restartDelayMs(attempt)), [1000, 2000, 4000, 8000, 16000, 30000, 30000])
})

test("an unexpected exit is announced and restarted after the backoff delay", async () => {
  const h = harness()
  h.supervisor.onBackendReady()
  h.supervisor.onUnexpectedExit("Node backend exited (code=1 signal=none)")
  assert.deepEqual(h.statuses, [{
    status: "restarting", reason: "Node backend exited (code=1 signal=none)", automatic: true, attempt: 1, delayMs: 1000,
  }])
  await h.advance(999)
  assert.equal(h.restarts.length, 0)
  await h.advance(1)
  assert.deepEqual(h.restarts, ["automatic restart after a crash (attempt 1)"])
})

test("five crashes within two minutes stop automatic restarts and offer a manual one", async () => {
  const h = harness()
  for (let crash = 1; crash <= 4; crash += 1) {
    h.supervisor.onBackendReady()
    h.supervisor.onUnexpectedExit(`crash ${crash}`)
    await h.advance(20_000)
  }
  assert.equal(h.restarts.length, 4)
  h.supervisor.onBackendReady()
  h.supervisor.onUnexpectedExit("crash 5")
  const last = h.statuses.at(-1)
  assert.equal(last.status, "failed")
  assert.equal(last.restartAvailable, true)
  assert.equal(last.crashLoop, true)
  await h.advance(60_000)
  assert.equal(h.restarts.length, 4)
  assert.equal(h.supervisor.state().gaveUp, true)

  // A manual restart clears the history; the next crash restarts again.
  h.supervisor.onManualRestart()
  h.supervisor.onBackendReady()
  h.supervisor.onUnexpectedExit("crash after manual restart")
  assert.equal(h.statuses.at(-1).status, "restarting")
})

test("crashes spread out over time never count as a loop", async () => {
  const h = harness()
  for (let crash = 1; crash <= 8; crash += 1) {
    h.supervisor.onBackendReady()
    h.supervisor.onUnexpectedExit(`crash ${crash}`)
    await h.advance(61_000)
  }
  assert.equal(h.statuses.filter((entry) => entry.status === "failed").length, 0)
  assert.equal(h.restarts.length, 8)
})

test("a failed restart counts as another crash", async () => {
  const h = harness({ restartFails: true })
  h.supervisor.onBackendReady()
  h.supervisor.onUnexpectedExit("first crash")
  await h.advance(1000)
  assert.equal(h.restarts.length, 1)
  const last = h.statuses.at(-1)
  assert.equal(last.status, "restarting")
  assert.equal(last.attempt, 2)
  assert.match(last.reason, /restart failed: spawn failed/)
})

test("three missed health checks terminate a wedged backend", async () => {
  const h = harness()
  h.supervisor.onBackendReady()
  h.setProbe(false)
  await h.advance(40_000)
  assert.equal(h.terminated.length, 0)
  await h.advance(20_000)
  assert.equal(h.terminated.length, 1)
  // The exit that follows takes the normal restart path.
  h.supervisor.onUnexpectedExit("killed after health checks")
  assert.equal(h.statuses.at(-1).status, "restarting")
})

test("a backend that survives termination is still recovered", async () => {
  const h = harness({ terminateGraceMs: 15_000 })
  h.supervisor.onBackendReady()
  h.setProbe(false)
  await h.advance(60_000)
  assert.equal(h.terminated.length, 1)
  await h.advance(15_000)
  assert.equal(h.statuses.at(-1).status, "restarting")
  assert.match(h.statuses.at(-1).reason, /did not exit/)
})

test("a healthy answer resets the miss count", async () => {
  const h = harness()
  h.supervisor.onBackendReady()
  h.setProbe(false)
  await h.advance(40_000)
  h.setProbe(true)
  await h.advance(20_000)
  h.setProbe(false)
  await h.advance(40_000)
  assert.equal(h.terminated.length, 0)
})

test("sleep pauses health checks and wake-up checks soon", async () => {
  const h = harness({ resumeGraceMs: 5_000 })
  h.supervisor.onBackendReady()
  h.supervisor.pause()
  h.setProbe(false)
  await h.advance(10 * 60_000)
  assert.equal(h.terminated.length, 0)
  h.supervisor.resume()
  assert.ok(h.pending().some((handle) => handle.due === 10 * 60_000 + 5_000))
})

test("nothing restarts while the app quits", async () => {
  const h = harness()
  h.supervisor.onBackendReady()
  h.quit()
  h.supervisor.onUnexpectedExit("exited during shutdown")
  await h.advance(60_000)
  assert.deepEqual(h.statuses, [])
  assert.deepEqual(h.restarts, [])
})

test("the health probe accepts only a 200 with status ok", async (t) => {
  let reply = { status: 200, body: '{"status":"ok"}' }
  const server = http.createServer((_request, response) => {
    response.writeHead(reply.status, { "Content-Type": "application/json" })
    response.end(reply.body)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  const { port } = server.address()
  assert.equal(await probeBackendHealth(port, { timeoutMs: 2000 }), true)
  reply = { status: 503, body: '{"status":"ok"}' }
  assert.equal(await probeBackendHealth(port, { timeoutMs: 2000 }), false)
  reply = { status: 200, body: "not json" }
  assert.equal(await probeBackendHealth(port, { timeoutMs: 2000 }), false)
  assert.equal(await probeBackendHealth(0), false)
})

test("the health probe gives up on a backend that never answers", async (t) => {
  const server = http.createServer(() => { /* never respond */ })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections?.(); server.close() })
  const { port } = server.address()
  assert.equal(await probeBackendHealth(port, { timeoutMs: 50 }), false)
})
