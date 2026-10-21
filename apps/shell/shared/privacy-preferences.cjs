/**
 * Telemetry consent as seen by the Electron main process.
 *
 * The choices live in the backend's `settings.json` (`crash_reports_enabled`,
 * `usage_ping_enabled`; both default to off) and are changed from
 * Settings → General → Privacy. The main process must answer "may I upload?"
 * even when the backend is down — that is exactly when crash reports fire —
 * so it reads the file directly. The backend replaces the file atomically,
 * and the parsed values are cached until its size or modification time
 * changes, so asking is cheap.
 *
 * Anything unexpected (missing, unreadable, oversized or invalid file) reads
 * as "not consented". The environment switches remain hard opt-outs for CI
 * and managed machines.
 */

const fs = require("node:fs")

const MAX_SETTINGS_BYTES = 16 * 1024 * 1024
const NOT_CONSENTED = Object.freeze({ crashReports: false, usagePing: false })

function createPrivacyPreferences({
  getSettingsPath,
  env = process.env,
  fsImpl = fs,
  maxBytes = MAX_SETTINGS_BYTES,
} = {}) {
  if (typeof getSettingsPath !== "function") {
    throw new TypeError("getSettingsPath must be a function")
  }
  let cachedStamp = null
  let cachedValues = NOT_CONSENTED

  function read() {
    let settingsPath
    let stat
    try {
      settingsPath = getSettingsPath()
      stat = fsImpl.statSync(settingsPath)
    } catch {
      return NOT_CONSENTED
    }
    if (!stat.isFile() || stat.size > maxBytes) return NOT_CONSENTED
    const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`
    if (stamp === cachedStamp) return cachedValues
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(settingsPath, "utf8"))
      cachedValues = Object.freeze({
        crashReports: parsed?.crash_reports_enabled === true,
        usagePing: parsed?.usage_ping_enabled === true,
      })
    } catch {
      cachedValues = NOT_CONSENTED
    }
    cachedStamp = stamp
    return cachedValues
  }

  return {
    /** Automatic crash and error reports. Manual reports never consult this. */
    crashReportsEnabled() {
      if (env.BETTERC0DE_DISABLE_CRASH_REPORTS === "1") return false
      return read().crashReports
    },
    /** One anonymous ping per app start, with a random installation ID. */
    usagePingEnabled() {
      if (env.BETTERC0DE_DISABLE_PING === "1") return false
      return read().usagePing
    },
  }
}

module.exports = { createPrivacyPreferences }
