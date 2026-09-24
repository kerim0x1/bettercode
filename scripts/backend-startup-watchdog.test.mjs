import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"

const require = createRequire(import.meta.url)
const {
  createBackendStartupWatchdog,
} = require("../apps/shell/shared/backend-startup-watchdog.cjs")
const appConfig = require("../apps/shell/shared/appConfig.cjs")
const shellSource = readFileSync(new URL("../apps/shell/main.cjs", import.meta.url), "utf8")
const spawnedStartupSource = shellSource.slice(
  shellSource.indexOf("async function startSpawnedBackend()"),
  shellSource.indexOf("async function startInProcessBackend()"),
)

function fakeTimers() {
  const handles = []
  let now = 0
  return {
    handles,
    api: {
      setTimeout(callback, delay) {
        const handle = {
          callback,
          delay,
          due: now + delay,
          cleared: false,
          unref() {},
        }
        handles.push(handle)
        return handle
      },
      clearTimeout(handle) {
        handle.cleared = true
      },
    },
    fire(handle) {
      if (!handle.cleared) handle.callback()
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const next = handles
          .filter((handle) => !handle.cleared && handle.due <= target)
          .sort((a, b) => a.due - b.due)[0]
        if (!next) break
        now = next.due
        next.cleared = true
        next.callback()
      }
      now = target
    },
  }
}

function startShellFixture(timers, { platform = "win32", codexBinaryPath = null } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let stopped = false
  let healthChecks = 0
  let forkOptions = null
  const context = {
    require: () => ({ accessSync() {} }),
    process: { env: {}, platform },
    path,
    app: { getAppPath: () => "/fixture" },
    appConfig,
    BACKEND_STARTUP_TIMEOUT_MS: appConfig.BACKEND_STARTUP_TIMEOUT_MS,
    BACKEND_STARTUP_HARD_TIMEOUT_MS: appConfig.BACKEND_STARTUP_HARD_TIMEOUT_MS,
    AbortController,
    console: { log() {}, error() {} },
    getBackendEntryPath: () => "/fixture/index.js",
    resolveDevNodeExecPath: () => null,
    resolveBetterC0deUserDataDir: () => "/fixture/data",
    resolveClaudeCodeBinaryPath: () => null,
    resolveCliBinary: () => codexBinaryPath,
    settingsEncryptionKey: "",
    fork: (_entry, _args, options) => {
      forkOptions = options
      return child
    },
    readline: { createInterface: ({ input }) => input },
    nodeBackendHandle: null,
    createBackendStartupWatchdog: (options) => createBackendStartupWatchdog({
      ...options, timerApi: timers.api,
    }),
    stopSpawnedBackend: async () => { stopped = true },
    tryParseBackendControlLine: JSON.parse,
    verifyBackendHealth: async () => { healthChecks++ },
    hasChildExited: () => false,
    installBackendAuthInterceptor() {},
    emitBackendStatus() {},
  }
  const result = runInNewContext(`${spawnedStartupSource}\nstartSpawnedBackend()`, context)
  return {
    result,
    get stopped() { return stopped },
    get healthChecks() { return healthChecks },
    get forkOptions() { return forkOptions },
    ready() {
      child.stderr.emit("line", JSON.stringify({ status: "ready", port: 3773, token: "x".repeat(32) }))
    },
    heartbeat() {
      child.stderr.emit("line", JSON.stringify({
        control: "betterc0de/backend-startup", status: "starting", protocol: 1,
      }))
    },
  }
}

test("Finder launch forwards the resolved Codex CLI to the backend", async () => {
  const timers = fakeTimers()
  const shell = startShellFixture(timers, {
    platform: "darwin",
    codexBinaryPath: "/opt/homebrew/bin/codex",
  })
  shell.ready()
  await shell.result
  assert.equal(
    shell.forkOptions.env.BETTERC0DE_CODEX_CLI_PATH,
    "/opt/homebrew/bin/codex",
  )
})

test("the shell accepts readiness after a 35-second cold module load", async () => {
  const timers = fakeTimers()
  const shell = startShellFixture(timers)
  timers.advance(35_000)
  assert.equal(shell.stopped, false)
  shell.heartbeat()
  shell.ready()
  assert.equal((await shell.result).port, 3773)
  assert.equal(shell.healthChecks, 1)
  timers.advance(300_000)
  assert.equal(shell.stopped, false)
})

test("the shell shuts down a silent child and never publishes late readiness", async () => {
  const timers = fakeTimers()
  const shell = startShellFixture(timers)
  const rejected = assert.rejects(shell.result, /first startup heartbeat within 120000ms/)
  timers.advance(120_000)
  await rejected
  assert.equal(shell.stopped, true)
  shell.heartbeat()
  shell.ready()
  assert.equal(shell.healthChecks, 0)
})

test("backend startup heartbeat extends only the idle deadline", () => {
  const timers = fakeTimers()
  const expirations = []
  const watchdog = createBackendStartupWatchdog({
    idleTimeoutMs: 30_000,
    hardTimeoutMs: 300_000,
    onTimeout: (expiration) => expirations.push(expiration),
    timerApi: timers.api,
  })

  const hardTimer = timers.handles[0]
  const firstIdleTimer = timers.handles[1]
  assert.equal(watchdog.pulse(), true)
  const secondIdleTimer = timers.handles[2]

  assert.equal(firstIdleTimer.cleared, true)
  assert.equal(hardTimer.cleared, false)
  timers.fire(firstIdleTimer)
  assert.deepEqual(expirations, [])

  timers.fire(secondIdleTimer)
  assert.deepEqual(expirations, [{ kind: "idle", timeoutMs: 30_000 }])
  assert.equal(hardTimer.cleared, true)
  assert.equal(watchdog.pulse(), false)
})

test("a cold backend can take 35 seconds to send its first heartbeat", () => {
  const timers = fakeTimers()
  const expirations = []
  const watchdog = createBackendStartupWatchdog({
    idleTimeoutMs: 30_000,
    initialTimeoutMs: 120_000,
    hardTimeoutMs: 300_000,
    onTimeout: (expiration) => expirations.push(expiration),
    timerApi: timers.api,
  })

  timers.advance(35_000)
  assert.deepEqual(expirations, [])
  assert.equal(watchdog.pulse(), true)
  timers.advance(29_999)
  assert.deepEqual(expirations, [])
  timers.advance(1)
  assert.deepEqual(expirations, [{ kind: "idle", timeoutMs: 30_000 }])
})

test("a child that never sends a heartbeat times out within the initial budget", () => {
  const timers = fakeTimers()
  const expirations = []
  const watchdog = createBackendStartupWatchdog({
    idleTimeoutMs: 30_000,
    initialTimeoutMs: 120_000,
    hardTimeoutMs: 300_000,
    onTimeout: (expiration) => expirations.push(expiration),
    timerApi: timers.api,
  })

  timers.advance(119_999)
  assert.deepEqual(expirations, [])
  timers.advance(1)
  assert.deepEqual(expirations, [{ kind: "initial", timeoutMs: 120_000 }])
  assert.equal(watchdog.pulse(), false)
  timers.advance(300_000)
  assert.equal(expirations.length, 1)
})

test("cold startup still has an absolute five-minute deadline", () => {
  const timers = fakeTimers()
  const expirations = []
  const watchdog = createBackendStartupWatchdog({
    idleTimeoutMs: 30_000,
    initialTimeoutMs: 120_000,
    hardTimeoutMs: 300_000,
    onTimeout: (expiration) => expirations.push(expiration),
    timerApi: timers.api,
  })

  timers.advance(100_000)
  watchdog.pulse()
  for (let i = 0; i < 9; i++) {
    timers.advance(20_000)
    watchdog.pulse()
  }
  assert.deepEqual(expirations, [])
  timers.advance(20_000)
  assert.deepEqual(expirations, [{ kind: "hard", timeoutMs: 300_000 }])
})

test("the initial heartbeat budget must fit between the idle and hard limits", () => {
  for (const initialTimeoutMs of [0, 29_999, 300_001, NaN, Infinity]) {
    assert.throws(() => createBackendStartupWatchdog({
      idleTimeoutMs: 30_000,
      initialTimeoutMs,
      hardTimeoutMs: 300_000,
      onTimeout() {},
    }), /initialTimeoutMs/)
  }
})

test("backend startup hard deadline remains absolute across heartbeats", () => {
  const timers = fakeTimers()
  const expirations = []
  const watchdog = createBackendStartupWatchdog({
    idleTimeoutMs: 30_000,
    hardTimeoutMs: 300_000,
    onTimeout: (expiration) => expirations.push(expiration),
    timerApi: timers.api,
  })

  const hardTimer = timers.handles[0]
  watchdog.pulse()
  watchdog.pulse()
  timers.fire(hardTimer)

  assert.deepEqual(expirations, [{ kind: "hard", timeoutMs: 300_000 }])
  assert.equal(
    timers.handles
      .filter((handle) => handle !== hardTimer)
      .every((handle) => handle.cleared),
    true,
  )
})

test("stopping the backend startup watchdog cancels every deadline", () => {
  const timers = fakeTimers()
  let expired = false
  const watchdog = createBackendStartupWatchdog({
    idleTimeoutMs: 30_000,
    hardTimeoutMs: 300_000,
    onTimeout: () => {
      expired = true
    },
    timerApi: timers.api,
  })

  watchdog.stop()
  for (const handle of timers.handles) timers.fire(handle)

  assert.equal(expired, false)
  assert.equal(watchdog.pulse(), false)
})
