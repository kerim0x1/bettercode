// @ts-check
/**
 * Supervision policy for the backend sidecar after it has started.
 *
 * - An unexpected exit schedules a restart with exponential backoff
 *   (1 s, 2 s, 4 s, … capped at `maxDelayMs`).
 * - `maxCrashes` exits inside `crashWindowMs` count as a crash loop: the
 *   supervisor stops restarting and reports `failed` with
 *   `restartAvailable: true`, so the window can offer a manual restart.
 * - While the backend is up, `/health` is probed every `livenessIntervalMs`.
 *   After `livenessMaxMisses` consecutive failures the backend is treated as
 *   wedged: it is terminated and its exit drives the normal restart path.
 * - Liveness pauses across system sleep and resumes with a short grace
 *   period, so a laptop waking up is not mistaken for a hung backend.
 *
 * The module holds no Electron or process references; main.cjs injects the
 * restart, probe, terminate and status functions.
 */

const http = require("node:http")

const DEFAULT_OPTIONS = Object.freeze({
  maxCrashes: 5,
  crashWindowMs: 2 * 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  livenessIntervalMs: 20_000,
  livenessMaxMisses: 3,
  resumeGraceMs: 5_000,
  terminateGraceMs: 15_000,
})

/**
 * Backoff before automatic restart number `attempt` (1-based).
 * @param {number} attempt
 * @param {{ baseDelayMs: number, maxDelayMs: number }} [options]
 * @returns {number}
 */
function restartDelayMs(attempt, { baseDelayMs, maxDelayMs } = DEFAULT_OPTIONS) {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What main.cjs injects; the numeric tunables (DEFAULT_SUPERVISOR_OPTIONS)
 * may be overridden alongside.
 * @typedef {object} BackendSupervisorDeps
 * @property {(reason: string) => unknown} restart Stop and start the backend again.
 * @property {(status: string, payload: Record<string, unknown>) => void} emitStatus
 *   Broadcast a `backend:status` event.
 * @property {() => Promise<boolean> | boolean} probe One liveness check.
 * @property {(reason: string) => Promise<void> | void} terminate Force-stop a wedged backend.
 * @property {() => boolean} [isQuitting]
 * @property {() => boolean} [isBusy] A restart or stop is already in progress.
 * @property {Pick<Console, "warn" | "error">} [log]
 * @property {() => number} [now]
 * @property {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [timers]
 */

/**
 * @typedef {object} BackendSupervisor
 * @property {() => void} onBackendReady A backend finished starting (initial start or any restart).
 * @property {(reason: unknown) => void} onUnexpectedExit The ready backend exited without being asked to.
 * @property {() => void} onManualRestart The user asked for a restart; forget the crash history.
 * @property {() => void} pause System sleep.
 * @property {() => void} resume System resume.
 * @property {() => void} dispose
 * @property {() => { running: boolean, paused: boolean, gaveUp: boolean, misses: number, recentCrashes: number, restartPending: boolean }} state
 */

/**
 * @param {BackendSupervisorDeps & Partial<typeof DEFAULT_OPTIONS>} deps
 * @returns {BackendSupervisor}
 */
function createBackendSupervisor({
  restart,
  emitStatus,
  probe,
  terminate,
  isQuitting = () => false,
  isBusy = () => false,
  log = console,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  ...overrides
}) {
  for (const [name, value] of Object.entries({ restart, emitStatus, probe, terminate })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`)
  }
  const options = { ...DEFAULT_OPTIONS, ...overrides }
  /** @type {number[]} */
  let crashTimes = []
  /** @type {NodeJS.Timeout | null} */
  let restartTimer = null
  /** @type {NodeJS.Timeout | null} */
  let livenessTimer = null
  /** @type {NodeJS.Timeout | null} */
  let terminateTimer = null
  let livenessInFlight = false
  let misses = 0
  let running = false
  let paused = false
  let disposed = false
  let gaveUp = false
  // Bumped whenever the supervised backend changes, so late probe results and
  // fallback timers from a previous backend are ignored.
  let generation = 0

  /**
   * @param {NodeJS.Timeout | null} handle
   * @returns {null}
   */
  const clear = (handle) => {
    if (handle) timers.clearTimeout(handle)
    return null
  }
  /**
   * @param {() => void} callback
   * @param {number} delayMs
   */
  const arm = (callback, delayMs) => {
    const handle = timers.setTimeout(callback, delayMs)
    handle?.unref?.()
    return handle
  }
  const inactive = () => disposed || isQuitting()

  /** @param {number} [delayMs] */
  function scheduleLiveness(delayMs = options.livenessIntervalMs) {
    livenessTimer = clear(livenessTimer)
    if (!running || paused || inactive()) return
    livenessTimer = arm(checkLiveness, delayMs)
  }

  async function checkLiveness() {
    livenessTimer = null
    if (!running || paused || inactive() || livenessInFlight) return
    if (isBusy()) {
      scheduleLiveness()
      return
    }
    const observed = generation
    livenessInFlight = true
    let healthy = false
    try {
      healthy = (await probe()) === true
    } catch {
      healthy = false
    } finally {
      livenessInFlight = false
    }
    if (observed !== generation || !running || paused || inactive()) return
    if (healthy) {
      misses = 0
      scheduleLiveness()
      return
    }
    misses += 1
    log.warn(
      `[electron] Backend health check failed (${misses}/${options.livenessMaxMisses})`,
    )
    if (misses < options.livenessMaxMisses) {
      scheduleLiveness()
      return
    }
    running = false
    misses = 0
    const reason = "backend stopped responding to health checks"
    log.error(`[electron] ${reason}; terminating it so it can be restarted`)
    try {
      await terminate(reason)
    } catch (error) {
      log.error("[electron] Could not terminate the unresponsive backend:", error)
    }
    // Normally the child's exit event arrives and calls onUnexpectedExit. If
    // the process survives, still recover instead of waiting forever.
    terminateTimer = clear(terminateTimer)
    terminateTimer = arm(() => {
      terminateTimer = null
      if (observed === generation && !inactive()) {
        handleCrash(`${reason}; it did not exit after being terminated`)
      }
    }, options.terminateGraceMs)
  }

  /** @param {string} reason */
  function handleCrash(reason) {
    generation += 1
    running = false
    misses = 0
    livenessTimer = clear(livenessTimer)
    terminateTimer = clear(terminateTimer)
    if (inactive()) return
    const cutoff = now() - options.crashWindowMs
    crashTimes = crashTimes.filter((time) => time > cutoff)
    crashTimes.push(now())
    restartTimer = clear(restartTimer)
    if (crashTimes.length >= options.maxCrashes) {
      gaveUp = true
      log.error(
        `[electron] Backend failed ${crashTimes.length} times within ${Math.round(options.crashWindowMs / 1000)}s; automatic restarts stopped`,
      )
      emitStatus("failed", {
        reason,
        restartAvailable: true,
        crashLoop: true,
        crashCount: crashTimes.length,
      })
      return
    }
    const attempt = crashTimes.length
    const delayMs = restartDelayMs(attempt, options)
    log.warn(
      `[electron] Restarting the backend in ${delayMs}ms (attempt ${attempt}/${options.maxCrashes - 1}): ${reason}`,
    )
    emitStatus("restarting", { reason, automatic: true, attempt, delayMs })
    const scheduledGeneration = generation
    restartTimer = arm(() => {
      restartTimer = null
      if (inactive() || scheduledGeneration !== generation) return
      Promise.resolve()
        .then(() => restart(`automatic restart after a crash (attempt ${attempt})`))
        .catch((error) => {
          if (inactive() || scheduledGeneration !== generation) return
          handleCrash(`restart failed: ${errorMessage(error)}`)
        })
    }, delayMs)
  }

  return {
    /** A backend finished starting (initial start or any restart). */
    onBackendReady() {
      if (disposed) return
      generation += 1
      running = true
      misses = 0
      gaveUp = false
      terminateTimer = clear(terminateTimer)
      scheduleLiveness()
    },
    /** The ready backend exited without being asked to. */
    onUnexpectedExit(reason) {
      handleCrash(String(reason || "backend exited unexpectedly"))
    },
    /** The user asked for a restart; forget the crash history. */
    onManualRestart() {
      generation += 1
      crashTimes = []
      gaveUp = false
      running = false
      restartTimer = clear(restartTimer)
      terminateTimer = clear(terminateTimer)
      livenessTimer = clear(livenessTimer)
    },
    /** System sleep: timers stop meaning anything until resume. */
    pause() {
      paused = true
      livenessTimer = clear(livenessTimer)
    },
    /** System resume: check the backend soon after wake-up. */
    resume() {
      paused = false
      misses = 0
      scheduleLiveness(options.resumeGraceMs)
    },
    dispose() {
      disposed = true
      running = false
      restartTimer = clear(restartTimer)
      livenessTimer = clear(livenessTimer)
      terminateTimer = clear(terminateTimer)
    },
    state() {
      return {
        running,
        paused,
        gaveUp,
        misses,
        recentCrashes: crashTimes.length,
        restartPending: restartTimer !== null,
      }
    },
  }
}

/**
 * One `/health` request with a hard deadline. Resolves true only for a 200
 * response whose JSON body says `{ "status": "ok" }`.
 * @param {number} port
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {Pick<typeof http, "get">} [options.httpImpl]
 * @returns {Promise<boolean>}
 */
function probeBackendHealth(port, { timeoutMs = 10_000, httpImpl = http } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      resolve(false)
      return
    }
    let settled = false
    /** @param {boolean} healthy */
    const finish = (healthy) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(healthy)
    }
    const deadline = setTimeout(() => {
      request.destroy(new Error("health check timed out"))
      finish(false)
    }, timeoutMs)
    deadline.unref?.()
    const request = httpImpl.get(
      { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          body += chunk
          if (body.length > 64 * 1024) response.destroy()
        })
        response.on("error", () => finish(false))
        response.on("end", () => {
          /** @type {{ status?: unknown } | null} */
          let parsed = null
          try { parsed = JSON.parse(body) } catch { /* unhealthy */ }
          finish(response.statusCode === 200 && parsed?.status === "ok")
        })
      },
    )
    request.on("error", () => finish(false))
    request.on("timeout", () => request.destroy(new Error("health check timed out")))
  })
}

module.exports = {
  DEFAULT_SUPERVISOR_OPTIONS: DEFAULT_OPTIONS,
  createBackendSupervisor,
  probeBackendHealth,
  restartDelayMs,
}
