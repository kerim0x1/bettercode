/**
 * The plugin host's side of the plugin RPC: loads third-party plugin modules
 * and runs their code, outside the Electron main process.
 *
 * shared/plugin-host-entry.cjs runs this inside a `utilityProcess` and
 * connects it to `process.parentPort`; shared/plugin-host-client.cjs is the
 * main-process side. Messages are plain structured-cloneable objects:
 *
 *   main → host  { type: "request", id, op, ...params }
 *   host → main  { type: "response", id, ok: true, value }
 *                { type: "response", id, ok: false, error: SerializedError }
 *                { type: "event", subscriptionId, event }
 *                { type: "fault", pluginId, error }   uncaught error from a plugin
 *                { type: "fatal", error }             uncaught error from elsewhere
 *
 * Operations: init, load, invoke, subscribe, unsubscribe, dispose, evict,
 * ping. The plugin API is the same as in-process: exported functions are
 * called with one argument object, `onEvent(listener)` returns a disposer
 * (or the module has `offEvent` / `removeListener`), and `deactivate()` /
 * `dispose()` release the module. Deadlines, queuing and quarantine stay in
 * PluginManager (main); the host only executes.
 */

const Module = require("module")
const path = require("path")
const { pathToFileURL } = require("url")

/** Exported functions the host calls itself rather than as plugin methods. */
const LIFECYCLE_EXPORTS = new Set(["onEvent", "offEvent", "removeListener", "deactivate", "dispose"])

/**
 * @typedef {object} SerializedError
 * @property {string} message
 * @property {string} [name]
 * @property {string} [code]
 * @property {string} [stack]
 */

/** @returns {SerializedError} */
function serializeError(error) {
  if (error instanceof Error) {
    const serialized = { message: error.message, name: error.name }
    if (typeof error.stack === "string") serialized.stack = error.stack
    if (typeof error.code === "string") serialized.code = error.code
    return serialized
  }
  return { message: String(error) }
}

function normalizeDisposer(candidate) {
  if (typeof candidate === "function") return candidate
  if (!candidate || typeof candidate !== "object") return null
  if (typeof candidate.dispose === "function") {
    return () => candidate.dispose.call(candidate)
  }
  if (typeof candidate.unsubscribe === "function") {
    return () => candidate.unsubscribe.call(candidate)
  }
  return null
}

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}

/**
 * @param {object} options
 * @param {(message: object) => void} options.post Sends one message to main.
 * @param {NodeJS.Require} [options.requireModule] Loads plugin entries (tests may inject).
 * @param {(code: number) => void} [options.exit] Ends the host after an unattributed fatal error.
 * @param {Pick<Console, "warn" | "error">} [options.log]
 */
function createPluginHostRuntime({
  post,
  requireModule = require,
  exit = (code) => process.exit(code),
  log = console,
}) {
  if (typeof post !== "function") throw new TypeError("post must be a function")
  /** instanceId -> { pluginId, pluginDir, entryPath, module } */
  const instances = new Map()
  /** subscriptionId -> { instanceId, dispose } */
  const subscriptions = new Map()

  function send(message) {
    try {
      post(message)
      return true
    } catch (error) {
      log.error("[plugin-host] Could not send a message to the main process:", error)
      return false
    }
  }

  function reply(id, value) {
    if (send({ type: "response", id, ok: true, value })) return
    // Typically a DataCloneError: the plugin returned functions, class
    // instances with private state, or similar.
    send({
      type: "response",
      id,
      ok: false,
      error: { message: "The plugin returned a value that cannot be sent to the app (it must be structured-cloneable)." },
    })
  }

  function fail(id, error) {
    send({ type: "response", id, ok: false, error: serializeError(error) })
  }

  function instanceFor(instanceId) {
    const instance = instances.get(instanceId)
    if (!instance) throw new Error(`Plugin instance ${instanceId} is not loaded in the plugin host`)
    return instance
  }

  function evictRequireCache(pluginDir, entryPath) {
    const cache = requireModule.cache || {}
    for (const cachePath of Object.keys(cache)) {
      if (cachePath === entryPath || (pluginDir && isInsideDirectory(pluginDir, cachePath))) {
        delete cache[cachePath]
      }
    }
  }

  const operations = {
    /** Make the app's own node_modules resolvable for plugin code. */
    init({ modulePaths = [] }) {
      for (const candidate of modulePaths) {
        if (typeof candidate === "string" && candidate && !Module.globalPaths.includes(candidate)) {
          Module.globalPaths.push(candidate)
        }
      }
      return true
    },

    load({ instanceId, pluginId, pluginDir, entryPath }) {
      if (typeof instanceId !== "string" || typeof entryPath !== "string" || !path.isAbsolute(entryPath)) {
        throw new TypeError("load needs an instance id and an absolute entry path")
      }
      try {
        // Clear require cache to allow reloading
        delete requireModule.cache[requireModule.resolve(entryPath)]
        const mod = requireModule(entryPath)
        instances.set(instanceId, { pluginId, pluginDir, entryPath, module: mod })
        // Own data properties holding functions, read through descriptors so
        // listing them runs no plugin getter.
        const exportsObject = mod && (typeof mod === "object" || typeof mod === "function") ? mod : {}
        const functions = Object.getOwnPropertyNames(exportsObject).filter((name) => {
          const descriptor = Object.getOwnPropertyDescriptor(exportsObject, name)
          return typeof descriptor?.value === "function"
        })
        return { functions }
      } catch (error) {
        evictRequireCache(pluginDir, entryPath)
        throw error
      }
    },

    async invoke({ instanceId, method, input }) {
      const instance = instanceFor(instanceId)
      const mod = instance.module
      const fn =
        typeof method === "string" && !LIFECYCLE_EXPORTS.has(method) && mod && Object.hasOwn(mod, method)
          ? mod[method]
          : undefined
      if (typeof fn !== "function") {
        throw new Error(`Plugin ${instance.pluginId} has no method: ${method}`)
      }
      return await fn.call(mod, input)
    },

    async subscribe({ instanceId, subscriptionId }) {
      const instance = instanceFor(instanceId)
      const mod = instance.module
      if (typeof mod?.onEvent !== "function") {
        throw new Error(`Plugin ${instance.pluginId} has no onEvent`)
      }
      const listener = (event) => {
        if (!subscriptions.has(subscriptionId)) return
        if (!send({ type: "event", subscriptionId, event })) {
          log.warn(`[plugin-host] Dropped an event from ${instance.pluginId} that cannot be sent to the app`)
        }
      }
      const fallbackDisposer =
        typeof mod.offEvent === "function"
          ? () => mod.offEvent(listener)
          : typeof mod.removeListener === "function"
            ? () => mod.removeListener("event", listener)
            : null
      // Retained before the plugin runs: a plugin may register the listener
      // and then throw before returning its disposer.
      subscriptions.set(subscriptionId, { instanceId, dispose: fallbackDisposer })
      try {
        const returned = await mod.onEvent(listener)
        const dispose = normalizeDisposer(returned) || fallbackDisposer
        if (!dispose) {
          throw new Error(
            `Plugin ${instance.pluginId} onEvent must return a disposer or expose offEvent/removeListener`,
          )
        }
        subscriptions.set(subscriptionId, { instanceId, dispose })
        return true
      } catch (error) {
        const retained = subscriptions.get(subscriptionId)
        subscriptions.delete(subscriptionId)
        if (retained?.dispose) {
          try {
            await retained.dispose()
          } catch (cleanupError) {
            log.warn(`[plugin-host] Partial event setup of ${instance.pluginId} could not be undone:`, cleanupError)
          }
        }
        throw error
      }
    },

    async unsubscribe({ subscriptionId }) {
      const subscription = subscriptions.get(subscriptionId)
      if (!subscription) return false
      subscriptions.delete(subscriptionId)
      if (subscription.dispose) await subscription.dispose()
      return true
    },

    /** The module's own cleanup (`deactivate`, else `dispose`). */
    async dispose({ instanceId }) {
      const mod = instanceFor(instanceId).module
      const dispose =
        typeof mod?.deactivate === "function"
          ? mod.deactivate
          : typeof mod?.dispose === "function"
            ? mod.dispose
            : null
      if (dispose) await dispose.call(mod)
      return true
    },

    /** Forget every instance of a plugin and drop its modules from require.cache. */
    evict({ pluginId }) {
      for (const [instanceId, instance] of instances) {
        if (instance.pluginId !== pluginId) continue
        instances.delete(instanceId)
        for (const [subscriptionId, subscription] of subscriptions) {
          if (subscription.instanceId === instanceId) subscriptions.delete(subscriptionId)
        }
        evictRequireCache(instance.pluginDir, instance.entryPath)
      }
      return true
    },

    ping() {
      return "pong"
    },
  }

  /** Handle one message from the main process. Never throws. */
  function handle(message) {
    if (!message || typeof message !== "object" || message.type !== "request") return
    const { id, op } = message
    const operation = typeof op === "string" && Object.hasOwn(operations, op) ? operations[op] : null
    if (!operation) {
      fail(id, new Error(`Unknown plugin host operation: ${String(op)}`))
      return
    }
    let result
    try {
      result = operation(message)
    } catch (error) {
      fail(id, error)
      return
    }
    Promise.resolve(result).then(
      (value) => reply(id, value),
      (error) => fail(id, error),
    )
  }

  /** The plugin whose files appear in `error`'s stack, or null. */
  function findPluginForError(error) {
    const stack = typeof error?.stack === "string" ? error.stack : ""
    if (!stack) return null
    const haystack = process.platform === "win32" ? stack.toLowerCase() : stack
    for (const instance of instances.values()) {
      if (typeof instance.pluginDir !== "string" || !instance.pluginDir) continue
      const needles = [instance.pluginDir + path.sep, pathToFileURL(instance.pluginDir).href + "/"]
      for (const needle of needles) {
        const candidate = process.platform === "win32" ? needle.toLowerCase() : needle
        if (haystack.includes(candidate)) return instance.pluginId
      }
    }
    return null
  }

  /**
   * An exception nothing caught. A plugin's own (timer, listener) is reported
   * to main, which disables that plugin, and the host keeps running; anything
   * else ends the host, and main restarts it.
   */
  function handleUncaughtException(error) {
    const pluginId = findPluginForError(error)
    if (pluginId) {
      send({ type: "fault", pluginId, error: serializeError(error) })
      return true
    }
    send({ type: "fatal", error: serializeError(error) })
    log.error("[plugin-host] Uncaught error outside plugin code; exiting:", error)
    exit(1)
    return false
  }

  return { handle, handleUncaughtException, findPluginForError }
}

module.exports = {
  LIFECYCLE_EXPORTS,
  createPluginHostRuntime,
  normalizeDisposer,
  serializeError,
}
