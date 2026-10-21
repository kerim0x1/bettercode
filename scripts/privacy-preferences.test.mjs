import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import test from "node:test"

const { createPrivacyPreferences } = createRequire(import.meta.url)("../apps/shell/shared/privacy-preferences.cjs")

function settingsFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-privacy-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, "settings.json")
}

let writes = 0
function write(file, settings) {
  fs.writeFileSync(file, JSON.stringify(settings))
  // Distinct timestamps even on file systems with coarse resolution.
  writes += 1
  const later = new Date(Date.now() + writes * 5_000)
  fs.utimesSync(file, later, later)
}

test("nothing is consented without a settings file or with defaults", (t) => {
  const file = settingsFile(t)
  const preferences = createPrivacyPreferences({ getSettingsPath: () => file, env: {} })
  assert.equal(preferences.crashReportsEnabled(), false)
  assert.equal(preferences.usagePingEnabled(), false)
  write(file, { theme: "dark" })
  assert.equal(preferences.crashReportsEnabled(), false)
  assert.equal(preferences.usagePingEnabled(), false)
})

test("reads each opt-in independently and follows later changes", (t) => {
  const file = settingsFile(t)
  const preferences = createPrivacyPreferences({ getSettingsPath: () => file, env: {} })
  write(file, { crash_reports_enabled: true, usage_ping_enabled: false })
  assert.equal(preferences.crashReportsEnabled(), true)
  assert.equal(preferences.usagePingEnabled(), false)
  write(file, { crash_reports_enabled: false, usage_ping_enabled: true })
  assert.equal(preferences.crashReportsEnabled(), false)
  assert.equal(preferences.usagePingEnabled(), true)
})

test("only a literal true counts as consent", (t) => {
  const file = settingsFile(t)
  const preferences = createPrivacyPreferences({ getSettingsPath: () => file, env: {} })
  write(file, { crash_reports_enabled: "true", usage_ping_enabled: 1 })
  assert.equal(preferences.crashReportsEnabled(), false)
  assert.equal(preferences.usagePingEnabled(), false)
})

test("environment opt-outs override the settings", (t) => {
  const file = settingsFile(t)
  write(file, { crash_reports_enabled: true, usage_ping_enabled: true })
  const preferences = createPrivacyPreferences({
    getSettingsPath: () => file,
    env: { BETTERC0DE_DISABLE_CRASH_REPORTS: "1", BETTERC0DE_DISABLE_PING: "1" },
  })
  assert.equal(preferences.crashReportsEnabled(), false)
  assert.equal(preferences.usagePingEnabled(), false)
})

test("unreadable, invalid or oversized files mean no consent", (t) => {
  const file = settingsFile(t)
  fs.writeFileSync(file, "{not json")
  const preferences = createPrivacyPreferences({ getSettingsPath: () => file, env: {} })
  assert.equal(preferences.crashReportsEnabled(), false)
  write(file, { crash_reports_enabled: true, padding: "x".repeat(2048) })
  const small = createPrivacyPreferences({ getSettingsPath: () => file, env: {}, maxBytes: 1024 })
  assert.equal(small.crashReportsEnabled(), false)
  const failing = createPrivacyPreferences({ getSettingsPath: () => { throw new Error("no data dir") }, env: {} })
  assert.equal(failing.usagePingEnabled(), false)
})

test("the file is parsed again only after it changes", (t) => {
  const file = settingsFile(t)
  write(file, { crash_reports_enabled: true })
  let reads = 0
  const countingFs = { ...fs, readFileSync: (...args) => { reads += 1; return fs.readFileSync(...args) } }
  const preferences = createPrivacyPreferences({ getSettingsPath: () => file, env: {}, fsImpl: countingFs })
  preferences.crashReportsEnabled()
  preferences.crashReportsEnabled()
  preferences.usagePingEnabled()
  assert.equal(reads, 1)
})
