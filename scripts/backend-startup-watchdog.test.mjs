import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const {
  createBackendStartupWatchdog,
} = require("../apps/shell/shared/backend-startup-watchdog.cjs")
const { buildBackendEnvironment } = require("../apps/shell/shared/backend-environment.cjs")
const {
  createBackendProcess,
  parseBackendStartupMessage,
} = require("../apps/shell/shared/backend-process.cjs")

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

/**
 * The backend process (shared/backend-process.cjs) with a fake child: every
 * Electron object, binary lookup and timer it uses is injected. The child
 * answers a `shutdown` message by exiting, as the real backend does.
 */
function createShellFixture(timers, {
  platform = "win32",
  codexBinaryPath = null,
  env = {},
  settingsEncryptionKey = "",
  loginShellPath = null,
  runtimeHome = "/fixture/home",
} = {}) {
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.connected = true
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const sentMessages = []
  child.send = (message, callback) => {
    sentMessages.push(message)
    callback?.(null)
    if (message?.type === "shutdown") {
      queueMicrotask(() => {
        child.exitCode = 0
        child.connected = false
        child.emit("exit", 0, null)
        child.emit("close", 0, null)
      })
    }
    return true
  }
  let healthChecks = 0
  let forkOptions = null
  const statuses = []
  const interceptors = []
  const backend = createBackendProcess({
    app: { isPackaged: false, getAppPath: () => "/fixture" },
    session: {
      defaultSession: {
        webRequest: {
          onBeforeSendHeaders: (filter, listener) => interceptors.push({ filter, listener }),
        },
      },
    },
    process: { env, platform },
    console: { log() {}, warn() {}, error() {} },
    fs: { accessSync() {} },
    shellDir: "/fixture/apps/shell",
    readline: { createInterface: ({ input }) => input },
    fork: (_entry, _args, options) => {
      forkOptions = options
      return child
    },
    emitBackendStatus: (status, payload = {}) => statuses.push({ status, ...payload }),
    isQuitting: () => false,
    getSettingsEncryptionKey: () => settingsEncryptionKey,
    resolveUserDataDir: () => "/fixture/data",
    resolveRuntimeHome: () => runtimeHome,
    resolveDevNodeExecPath: () => null,
    resolveClaudeCodeBinaryPath: () => null,
    resolveCliBinary: () => codexBinaryPath,
    resolveDarwinChildPath: async () => ({ path: loginShellPath, fromLoginShell: true }),
    getRendererSecurityPolicy: () => ({ trustedWebContentsIds: new Set() }),
    isTrustedRendererRequest: () => false,
    buildBackendEnvironment: (parentEnv, options) =>
      buildBackendEnvironment(parentEnv, { ...options, platform }),
    createBackendStartupWatchdog: (options) => createBackendStartupWatchdog({
      ...options, timerApi: timers.api,
    }),
    verifyBackendHealth: async () => { healthChecks++ },
  })
  return {
    backend,
    result: null,
    // Forks the child and attaches every listener before it returns, like
    // the first synchronous part of the real launch.
    start() {
      this.result = backend.startSpawnedBackend()
      return this.result
    },
    // The child was asked to shut down (the startup failed or timed out).
    get stopped() { return sentMessages.some((message) => message?.type === "shutdown") },
    get healthChecks() { return healthChecks },
    get forkOptions() { return forkOptions },
    statuses,
    interceptors,
    sentMessages,
    ready() {
      child.emit("message", {
        type: "betterc0de/backend-startup",
        protocol: 1,
        status: "ready",
        port: 3773,
        token: "x".repeat(32),
      })
    },
    heartbeat() {
      child.emit("message", {
        type: "betterc0de/backend-startup",
        protocol: 1,
        status: "starting",
      })
    },
    failure(message) {
      child.emit("message", {
        type: "betterc0de/backend-startup",
        protocol: 1,
        status: "error",
        message,
      })
    },
    stderrLine(line) {
      child.stderr.emit("line", line)
    },
    exit(code) {
      child.exitCode = code
      child.connected = false
      child.emit("exit", code, null)
    },
  }
}

function startShellFixture(timers, options) {
  const shell = createShellFixture(timers, options)
  shell.start()
  return shell
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

test("the settings key reaches the backend over IPC, never through its environment", async () => {
  const timers = fakeTimers()
  const key = Buffer.alloc(32, 7).toString("base64")
  const shell = startShellFixture(timers, {
    settingsEncryptionKey: key,
    env: { BETTERC0DE_SETTINGS_KEY: "stale-user-value", PATH: "C:\\Windows" },
  })
  shell.ready()
  await shell.result
  assert.deepEqual(shell.sentMessages, [{ type: "settings-key", key }])
  assert.equal(shell.forkOptions.env.BETTERC0DE_SETTINGS_KEY_VIA_IPC, "1")
  assert.equal("BETTERC0DE_SETTINGS_KEY" in shell.forkOptions.env, false)
  assert.equal(JSON.stringify(shell.forkOptions.env).includes(key), false)
})

test("the backend environment drops runtime injection and keeps user configuration", async () => {
  const timers = fakeTimers()
  const shell = startShellFixture(timers, {
    platform: "linux",
    env: {
      PATH: "/usr/bin",
      HOME: "/home/user",
      ANTHROPIC_API_KEY: "kept-for-provider-detection",
      NODE_OPTIONS: "--require /tmp/inject.js",
      LD_PRELOAD: "/tmp/inject.so",
      ELECTRON_ENABLE_LOGGING: "1",
      npm_lifecycle_event: "dev",
    },
  })
  shell.ready()
  await shell.result
  const env = shell.forkOptions.env
  assert.equal(env.PATH, "/usr/bin")
  assert.equal(env.HOME, "/home/user")
  assert.equal(env.ANTHROPIC_API_KEY, "kept-for-provider-detection")
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1")
  for (const removed of ["NODE_OPTIONS", "LD_PRELOAD", "ELECTRON_ENABLE_LOGGING", "npm_lifecycle_event"]) {
    assert.equal(removed in env, false, removed)
  }
  assert.equal(env.BETTERC0DE_DATA_DIR, "/fixture/data")
  // The runtime home is passed explicitly; the backend never derives it
  // from the data directory.
  assert.equal(env.BETTERC0DE_RUNTIME_HOME, "/fixture/home")
})

test("macOS launches pass the login shell PATH to the backend", async () => {
  const timers = fakeTimers()
  const loginPath = "/opt/homebrew/bin:/Users/me/.volta/bin:/usr/bin:/bin"
  const shell = createShellFixture(timers, {
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    loginShellPath: loginPath,
  })
  // startBackend resolves the login shell PATH before every launch.
  assert.equal(await shell.backend.prepareBackendLaunchPath(), loginPath)
  shell.start()
  shell.ready()
  await shell.result
  assert.equal(shell.forkOptions.env.PATH, loginPath)
  assert.equal(shell.forkOptions.env.BETTERC0DE_LOGIN_SHELL_PATH, loginPath)
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

test("readiness counts only from the IPC channel, never from a stderr line", async () => {
  const timers = fakeTimers()
  const shell = startShellFixture(timers)
  // A log line shaped like the old stderr ready frame is just a log line.
  shell.stderrLine(JSON.stringify({ status: "ready", port: 4444, token: "y".repeat(32) }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(shell.healthChecks, 0)
  shell.ready()
  const started = await shell.result
  assert.equal(started.port, 3773)
  assert.equal(shell.healthChecks, 1)
  // The backend is told to use the channel (an older shell gets stderr).
  assert.equal(shell.forkOptions.env.BETTERC0DE_STARTUP_CONTROL, "ipc")
})

test("a startup error frame from the backend rejects with its message", async () => {
  const timers = fakeTimers()
  const shell = startShellFixture(timers)
  const rejected = assert.rejects(shell.result, /data directory is locked/)
  shell.failure("data directory is locked")
  await rejected
  assert.equal(shell.stopped, true)
})

test("readiness installs the bearer for the announced port and broadcasts it", async () => {
  const timers = fakeTimers()
  const shell = startShellFixture(timers)
  assert.equal(shell.backend.getConnection(), null)
  shell.ready()
  await shell.result
  assert.deepEqual(shell.backend.getConnection(), { port: 3773, token: "x".repeat(32) })
  assert.equal(shell.backend.getServerPort(), 3773)
  assert.equal(shell.interceptors.length, 1)
  assert.ok(shell.interceptors[0].filter.urls.includes("http://127.0.0.1:3773/*"))
  assert.deepEqual(shell.statuses, [{ status: "ready", port: 3773 }])
})

test("an exit during startup rejects with the backend stderr attached for the dialog", async () => {
  const timers = fakeTimers()
  const shell = startShellFixture(timers)
  shell.stderrLine("Error: Cannot find module 'better-sqlite3'")
  shell.exit(1)
  await assert.rejects(shell.result, (error) => {
    assert.match(error.message, /Node backend exited \(code=1 /)
    assert.deepEqual(error.backendStderr, ["Error: Cannot find module 'better-sqlite3'"])
    return true
  })
  assert.equal(shell.backend.getConnection(), null)
})

test("only well-formed startup frames from the IPC channel are accepted", () => {
  const frame = { type: "betterc0de/backend-startup", protocol: 1 }
  assert.deepEqual(parseBackendStartupMessage({ ...frame, status: "starting" }), { status: "starting" })
  assert.equal(parseBackendStartupMessage({ ...frame, status: "ready", port: 3773, token: "short" }), null)
  assert.equal(parseBackendStartupMessage({ ...frame, status: "ready", port: 70_000, token: "x".repeat(32) }), null)
  assert.equal(parseBackendStartupMessage({ ...frame, protocol: 2, status: "starting" }), null)
  assert.deepEqual(parseBackendStartupMessage({ ...frame, status: "error" }), {
    status: "error",
    message: "Node backend failed to start",
  })
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
