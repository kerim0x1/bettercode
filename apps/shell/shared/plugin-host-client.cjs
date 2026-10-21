/**
 * Main-process side of the out-of-process plugin host.
 *
 * Third-party plugins used to be `require()`d into the Electron main process,
 * where a plugin's CPU loop froze every window, an uncaught error could quit
 * the app, and the processes a plugin started outlived it. With the host,
 * plugin code runs in a separate process (an Electron `utilityProcess`
 * running shared/plugin-host-entry.cjs) and PluginManager talks to it through
 * proxy modules this client returns:
 *
 *  - every request has a deadline (`PLUGIN_HOST_TIMEOUT`); a deadline that
 *    passes while the host does not answer a ping either gets the host killed;
 *  - when the host exits unexpectedly, pending calls fail
 *    (`PLUGIN_HOST_EXITED`), `onCrash` reports which plugins were lost, and
 *    the next request starts a new host after an exponential backoff; after
 *    `maxCrashes` exits within `crashWindowMs` no new host is started until
 *    the window has passed;
 *  - an uncaught error the host attributes to one plugin arrives as
 *    `onFault(pluginId, error)`; the host keeps running;
 *  - `dispose()` ends the host, and on POSIX the processes it started.
 *
 * The proxies keep PluginManager's plugin API unchanged: exported functions
 * are called with one argument object, `onEvent(listener)` resolves to a
 * disposer, `deactivate()` / `dispose()` release the module. Arguments,
 * results and events must be structured-cloneable (they already crossed the
 * renderer IPC boundary as such).
 *
 * The host is used only when BETTERC0DE_PLUGIN_HOST=utility (plugin-ipc.cjs);
 * by default plugins still load in-process.
 */

const path = require("path")
const { restartDelayMs } = require("./backend-supervisor.cjs")

const HOST_ENTRY_PATH = path.join(__dirname, "plugin-host-entry.cjs")

const DEFAULT_OPTIONS = Object.freeze({
  /** Loading (require) one plugin entry. */
  loadTimeoutMs: 30_000,
  /**
   * One plugin method call. Longer than PluginManager's own 120 s call
   * deadline, which reports the timeout first and quarantines the plugin;
   * this one releases the call when the host never answers.
   */
  invokeTimeoutMs: 150_000,
  /** init, event subscribe/unsubscribe, module dispose, evict. */
  lifecycleTimeoutMs: 15_000,
  /** Liveness check after a request deadline passed. */
  pingTimeoutMs: 5_000,
  /** How long dispose() waits for the killed host to exit. */
  shutdownTimeoutMs: 3_000,
  maxCrashes: 5,
  crashWindowMs: 2 * 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
})

function hostError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Rebuild an error the host serialized (message, name, code, stack). */
function deserializeError(serialized) {
  const error = new Error(
    typeof serialized?.message === "string" ? serialized.message : "Plugin host error",
  )
  if (typeof serialized?.name === "string" && serialized.name) error.name = serialized.name
  if (typeof serialized?.code === "string") error.code = serialized.code
  if (typeof serialized?.stack === "string") error.stack = serialized.stack
  return error
}

function forwardLines(stream, write) {
  if (!stream) return
  const reader = require("readline").createInterface({ input: stream })
  reader.on("line", (line) => {
    if (line) write(`[plugin-host] ${line}`)
  })
}

/**
 * The host as an Electron utility process. Only callable after app ready.
 * Its output goes through this process's console (and so into app.log).
 */
function spawnUtilityPluginHost({
  utilityProcess = require("electron").utilityProcess,
  entryPath = HOST_ENTRY_PATH,
  log = console,
} = {}) {
  const child = utilityProcess.fork(entryPath, [], {
    serviceName: "BetterC0de Plugin Host",
    stdio: "pipe",
  })
  forwardLines(child.stdout, (line) => log.log(line))
  forwardLines(child.stderr, (line) => log.error(line))
  // An "error" event nobody listens to would be thrown in the main process.
  // The process ends after it; its "exit" drives the restart.
  child.on("error", (type, location) => {
    log.error(`[plugin-host] The plugin host failed (${type}) at ${location}`)
  })
  return {
    pid: () => child.pid,
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on("message", listener),
    onExit: (listener) => child.once("exit", (code) => listener({ code })),
    kill: () => child.kill(),
  }
}

/** The host as a plain Node child process (tests, and non-Electron tooling). */
function spawnNodePluginHost({
  fork = require("child_process").fork,
  entryPath = HOST_ENTRY_PATH,
  execArgv = [],
} = {}) {
  const child = fork(entryPath, [], {
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    execArgv,
  })
  // `send` on a closed channel reports through "error"; the exit (or the
  // request deadline) already covers it.
  child.on("error", () => {})
  return {
    pid: () => child.pid,
    postMessage: (message) => {
      child.send(message)
    },
    onMessage: (listener) => child.on("message", listener),
    onExit: (listener) => child.once("exit", (code, signal) => listener({ code, signal })),
    kill: () => child.kill("SIGKILL"),
  }
}

/**
 * Kill the host and, on POSIX, the processes it started (snapshotted while
 * the host is still alive; afterwards they are re-parented and unreachable).
 * Windows: `taskkill /T /F` walks the tree itself.
 *
 * Only the snapshotted PIDs are signalled, never process groups: a utility
 * process shares the app's process group, and so do the children a plugin
 * starts without `detached`, so a group kill would end the app itself.
 */
async function terminateHostTree(host, {
  platform = process.platform,
  listDescendants = (pid) => require("./process-tree.cjs").listDescendantProcesses(pid, { timeoutMs: 2_000 }),
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
  const pid = host.pid?.()
  if (platform === "win32") {
    if (Number.isInteger(pid)) await taskkillTree(pid)
    try { host.kill() } catch { /* already gone */ }
    return
  }
  const descendants = Number.isInteger(pid) ? await listDescendants(pid) : []
  try { host.kill() } catch { /* already gone */ }
  for (const { pid: descendant } of descendants) {
    if (!Number.isInteger(descendant) || descendant <= 1 || descendant === process.pid) continue
    try { kill(descendant, "SIGKILL") } catch { /* already gone */ }
  }
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    let killer
    let timer = null
    const done = () => {
      if (timer) clearTimeout(timer)
      timer = null
      resolve()
    }
    try {
      const windowsRoot = process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows"
      killer = require("child_process").spawn(
        path.join(windowsRoot, "System32", "taskkill.exe"),
        ["/pid", String(pid), "/T", "/F"],
        { cwd: windowsRoot, stdio: "ignore", windowsHide: true },
      )
    } catch {
      resolve()
      return
    }
    timer = setTimeout(() => {
      try { killer.kill("SIGKILL") } catch { /* ignore */ }
      done()
    }, 2_000)
    killer.once("error", done)
    killer.once("close", done)
  })
}

/**
 * @param {object} options
 * @param {() => {
 *   pid?: () => number | undefined,
 *   postMessage: (message: object) => void,
 *   onMessage: (listener: (message: any) => void) => void,
 *   onExit: (listener: (info: { code?: number | null, signal?: string | null }) => void) => void,
 *   kill: () => void,
 * }} options.spawnHost Starts one host process.
 * @param {() => string[]} [options.getModulePaths] node_modules directories plugin code may resolve from.
 * @param {(crash: { reason: string, pluginIds: string[], crashCount: number, gaveUp: boolean, restartDelayMs: number }) => void} [options.onCrash]
 * @param {(pluginId: string, error: Error) => void} [options.onFault]
 * @param {(host: object) => Promise<void>} [options.terminate] Ends a host at dispose (default: the host and its process tree).
 */
function createPluginHostClient({
  spawnHost,
  getModulePaths = () => [],
  onCrash = () => {},
  onFault = () => {},
  terminate = (host) => terminateHostTree(host),
  log = console,
  timers = { setTimeout, clearTimeout },
  now = Date.now,
  ...overrides
}) {
  if (typeof spawnHost !== "function") throw new TypeError("spawnHost must be a function")
  const options = { ...DEFAULT_OPTIONS, ...overrides }

  let transport = null
  let generation = 0
  let startPromise = null
  let disposed = false
  let disposePromise = null
  let livenessCheckRunning = false
  let nextRequestId = 1
  let instanceCounter = 0
  let subscriptionCounter = 0
  let crashTimes = []
  let notBefore = 0
  const exitWaiters = []
  /** request id -> { resolve, reject, timer } */
  const pending = new Map()
  /** subscription id -> main-side listener */
  const subscriptions = new Map()
  /** plugin ids with a module loaded in the current host */
  const loadedPlugins = new Set()

  const delay = (ms) =>
    new Promise((resolve) => {
      const handle = timers.setTimeout(resolve, ms)
      handle?.unref?.()
    })

  function recentCrashes() {
    const cutoff = now() - options.crashWindowMs
    crashTimes = crashTimes.filter((time) => time > cutoff)
    return crashTimes.length
  }

  function ensureHost() {
    if (disposed) {
      return Promise.reject(hostError("The plugin host is shutting down", "PLUGIN_HOST_DISPOSED"))
    }
    if (transport) return Promise.resolve(transport)
    startPromise ??= (async () => {
      if (recentCrashes() >= options.maxCrashes) {
        throw hostError(
          `The plugin host stopped ${crashTimes.length} times within ${Math.round(options.crashWindowMs / 1000)}s; plugins stay stopped for now`,
          "PLUGIN_HOST_CRASH_LOOP",
        )
      }
      const wait = notBefore - now()
      if (wait > 0) await delay(wait)
      if (disposed) throw hostError("The plugin host is shutting down", "PLUGIN_HOST_DISPOSED")
      const host = spawnHost()
      generation += 1
      const hostGeneration = generation
      transport = host
      host.onMessage((message) => handleMessage(hostGeneration, message))
      host.onExit((info) => handleExit(hostGeneration, info || {}))
      try {
        await requestOn(host, "init", { modulePaths: getModulePaths() }, options.lifecycleTimeoutMs)
      } catch (error) {
        // A host that cannot even initialize is no use; its exit is reported
        // like any other.
        try { host.kill() } catch { /* already gone */ }
        throw error
      }
      return host
    })().finally(() => {
      startPromise = null
    })
    return startPromise
  }

  function settle(id, outcome) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    timers.clearTimeout(entry.timer)
    outcome(entry)
  }

  function handleMessage(hostGeneration, message) {
    if (hostGeneration !== generation || !message || typeof message !== "object") return
    switch (message.type) {
      case "response":
        settle(message.id, (entry) =>
          message.ok ? entry.resolve(message.value) : entry.reject(deserializeError(message.error)),
        )
        return
      case "event": {
        const listener = subscriptions.get(message.subscriptionId)
        if (!listener) return
        try {
          listener(message.event)
        } catch (error) {
          log.warn("[plugin-host] A plugin event listener failed:", error)
        }
        return
      }
      case "fault":
        if (typeof message.pluginId === "string") {
          onFault(message.pluginId, deserializeError(message.error))
        }
        return
      case "fatal":
        log.error(
          "[plugin-host] Uncaught error in the plugin host:",
          message.error?.stack || message.error?.message || message.error,
        )
        return
      default:
    }
  }

  function handleExit(hostGeneration, { code = null, signal = null }) {
    if (hostGeneration !== generation) return
    transport = null
    const reason = `exit code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}`
    const error = hostError(`The plugin host stopped (${reason})`, "PLUGIN_HOST_EXITED")
    for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(error))
    subscriptions.clear()
    const pluginIds = [...loadedPlugins]
    loadedPlugins.clear()
    for (const resolve of exitWaiters.splice(0)) resolve()
    if (disposed) return

    recentCrashes()
    crashTimes.push(now())
    const crashCount = crashTimes.length
    const gaveUp = crashCount >= options.maxCrashes
    const waitMs = restartDelayMs(crashCount, options)
    notBefore = now() + waitMs
    log.error(
      gaveUp
        ? `[plugin-host] The plugin host stopped unexpectedly (${reason}) ${crashCount} times within ${Math.round(options.crashWindowMs / 1000)}s; not restarting it for now`
        : `[plugin-host] The plugin host stopped unexpectedly (${reason}); a new one starts in ${waitMs}ms when plugins are next used`,
    )
    try {
      onCrash({ reason, pluginIds, crashCount, gaveUp, restartDelayMs: waitMs })
    } catch (crashError) {
      log.error("[plugin-host] Crash handler failed:", crashError)
    }
  }

  /** Ping the host after a missed deadline; kill it when it does not answer. */
  async function checkResponsive(host, hostGeneration) {
    if (livenessCheckRunning || hostGeneration !== generation || transport !== host) return
    livenessCheckRunning = true
    try {
      await requestOn(host, "ping", {}, options.pingTimeoutMs, { checkOnTimeout: false })
    } catch (error) {
      if (error?.code === "PLUGIN_HOST_TIMEOUT" && hostGeneration === generation && transport === host) {
        log.error("[plugin-host] The plugin host is not responding; stopping it")
        try { host.kill() } catch { /* already gone */ }
      }
    } finally {
      livenessCheckRunning = false
    }
  }

  function requestOn(host, op, params, timeoutMs, { checkOnTimeout = true } = {}) {
    const hostGeneration = generation
    return new Promise((resolve, reject) => {
      const id = nextRequestId++
      const timer = timers.setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(hostError(`Plugin host ${op} timed out after ${timeoutMs}ms`, "PLUGIN_HOST_TIMEOUT"))
        if (checkOnTimeout) void checkResponsive(host, hostGeneration)
      }, timeoutMs)
      timer?.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        host.postMessage({ ...params, type: "request", id, op })
      } catch (error) {
        // For example a DataCloneError: an argument cannot cross processes.
        settle(id, (entry) => entry.reject(error))
      }
    })
  }

  async function request(op, params, timeoutMs) {
    const host = await ensureHost()
    if (host !== transport) {
      throw hostError("The plugin host stopped", "PLUGIN_HOST_EXITED")
    }
    return requestOn(host, op, params, timeoutMs)
  }

  function staleInstance(pluginId) {
    return Promise.reject(
      hostError(`Plugin ${pluginId} was loaded by a plugin host that has stopped`, "PLUGIN_HOST_EXITED"),
    )
  }

  function createProxy({ pluginId, instanceId, functions, hostGeneration }) {
    const isCurrent = () => transport !== null && hostGeneration === generation
    const proxy = {}
    for (const name of functions) {
      if (name === "onEvent") {
        proxy.onEvent = (listener) => {
          if (typeof listener !== "function") {
            return Promise.reject(new TypeError("Plugin event listener must be a function"))
          }
          if (!isCurrent()) return staleInstance(pluginId)
          subscriptionCounter += 1
          const subscriptionId = `${instanceId}/${subscriptionCounter}`
          subscriptions.set(subscriptionId, listener)
          return request("subscribe", { instanceId, subscriptionId }, options.lifecycleTimeoutMs).then(
            () => () => {
              subscriptions.delete(subscriptionId)
              // A host that stopped took the subscription with it.
              if (!isCurrent()) return Promise.resolve(false)
              return request("unsubscribe", { subscriptionId }, options.lifecycleTimeoutMs)
            },
            (error) => {
              subscriptions.delete(subscriptionId)
              throw error
            },
          )
        }
      } else if (name === "deactivate" || name === "dispose") {
        // The module's own cleanup; nothing left to clean once its host is gone.
        proxy[name] = () =>
          isCurrent()
            ? request("dispose", { instanceId }, options.lifecycleTimeoutMs)
            : Promise.resolve(false)
      } else if (name === "offEvent" || name === "removeListener") {
        // Used by the host itself when onEvent returns no disposer.
        continue
      } else {
        proxy[name] = (input) =>
          isCurrent()
            ? request("invoke", { instanceId, method: name, input }, options.invokeTimeoutMs)
            : staleInstance(pluginId)
      }
    }
    return proxy
  }

  /**
   * Load a plugin entry in the host. Resolves to a proxy module for
   * PluginManager; rejects with the host's error (its `code`, such as
   * MODULE_NOT_FOUND, is kept).
   */
  async function loadPlugin({ pluginId, pluginDir, entryPath }) {
    instanceCounter += 1
    const instanceId = `${pluginId}#${instanceCounter}`
    const result = await request("load", { instanceId, pluginId, pluginDir, entryPath }, options.loadTimeoutMs)
    const hostGeneration = generation
    loadedPlugins.add(pluginId)
    const functions = Array.isArray(result?.functions)
      ? result.functions.filter((name) => typeof name === "string")
      : []
    return createProxy({ pluginId, instanceId, functions, hostGeneration })
  }

  /** Drop a plugin's modules from the host (after its cleanup ran). */
  function evictPlugin(pluginId) {
    loadedPlugins.delete(pluginId)
    if (!transport) return Promise.resolve(false)
    return requestOn(transport, "evict", { pluginId }, options.lifecycleTimeoutMs).catch(() => false)
  }

  /** End the host (and the processes it started). Idempotent. */
  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    disposePromise = (async () => {
      // A start still waiting out its restart backoff sees `disposed` and
      // never spawns; one that already spawned has set `transport`.
      const host = transport
      if (!host) return
      const exited = new Promise((resolve) => exitWaiters.push(resolve))
      try {
        await terminate(host)
      } catch (error) {
        log.warn("[plugin-host] Could not stop the plugin host's processes:", error)
        try { host.kill() } catch { /* already gone */ }
      }
      await Promise.race([exited, delay(options.shutdownTimeoutMs)])
    })()
    return disposePromise
  }

  return {
    loadPlugin,
    evictPlugin,
    dispose,
    /** For diagnostics and tests. */
    state: () => ({
      running: transport !== null,
      generation,
      pending: pending.size,
      subscriptions: subscriptions.size,
      recentCrashes: recentCrashes(),
      disposed,
    }),
  }
}

module.exports = {
  DEFAULT_PLUGIN_HOST_OPTIONS: DEFAULT_OPTIONS,
  HOST_ENTRY_PATH,
  createPluginHostClient,
  deserializeError,
  spawnNodePluginHost,
  spawnUtilityPluginHost,
  terminateHostTree,
}
