const fs = require("node:fs")
const path = require("node:path")
const { randomUUID } = require("node:crypto")
const { readJson, writeJson } = require("./json-fs.cjs")

const PING_URL = "https://betterc0de.com/api/ping"
/** Delay before the single per-launch ping, so a launch that quits at once sends nothing. */
const PING_DELAY_MS = 30_000
const INSTALLATION_FILE = "installation.json"
const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The saved installation ID, or null. Never creates one. */
function readInstallId(dataDir) {
  try {
    const saved = readJson(path.join(dataDir, INSTALLATION_FILE), null, { maxBytes: 1024 })
    return typeof saved?.id === "string" && INSTALL_ID_PATTERN.test(saved.id) ? saved.id : null
  } catch {
    return null
  }
}

/** Only called once the user has opted in to the usage ping. */
function getOrCreateInstallId(dataDir) {
  const saved = readInstallId(dataDir)
  if (saved) return saved
  const id = randomUUID()
  writeJson(path.join(dataDir, INSTALLATION_FILE), { id }, { maxBytes: 1024 })
  return id
}

/**
 * Delete the installation ID. Earlier versions created it without asking;
 * without consent no persistent identifier is kept.
 */
function forgetInstallId(dataDir, { fsImpl = fs } = {}) {
  try {
    fsImpl.rmSync(path.join(dataDir, INSTALLATION_FILE), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Send one usage ping for this app start, after `delayMs`. Call only when the
 * user opted in. Returns a function that cancels a pending or in-flight ping.
 */
function startAppPing({
  dataDir, appVersion, os = process.platform, arch = process.arch,
  fetchImpl = fetch, timeoutMs = 10_000, delayMs = PING_DELAY_MS,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
}) {
  let stopped = false
  let controller
  const timer = setTimeoutImpl(async () => {
    if (stopped) return
    let id
    try {
      id = getOrCreateInstallId(dataDir)
    } catch {
      // A read-only profile must not create a new identity on every launch.
      return
    }
    controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(PING_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, appVersion, os, arch }),
        signal: controller.signal,
        redirect: "error",
      })
      await response.body?.cancel()
    } catch {
      // Offline or server errors are silent; there is no retry this launch.
    } finally {
      clearTimeout(timeout)
      controller = undefined
    }
  }, delayMs)
  timer?.unref?.()

  return () => {
    stopped = true
    clearTimeoutImpl(timer)
    controller?.abort()
  }
}

module.exports = { forgetInstallId, getOrCreateInstallId, readInstallId, startAppPing }
