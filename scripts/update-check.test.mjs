// Release-feed checks (shared/update-check.cjs), extracted from main.cjs.
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  createAutoUpdaterLoader,
  createUpdateChecker,
  updateNoticeDetail,
} = require("../apps/shell/shared/update-check.cjs")

const quiet = { log() {}, warn() {}, error() {} }

/** A packaged app whose package.json links to a fork's releases. */
function packagedApp(t, manifest = {}) {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-update-"))
  t.after(() => fs.rmSync(appPath, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(appPath, "package.json"),
    JSON.stringify({ repository: "git+https://github.com/fork/app.git", ...manifest }),
  )
  return { isPackaged: true, getVersion: () => "1.0.0", getAppPath: () => appPath }
}

function fakeUpdater() {
  const updater = new EventEmitter()
  updater.calls = []
  updater.checkForUpdates = () => { updater.calls.push("check"); return Promise.resolve() }
  updater.checkForUpdatesAndNotify = () => { updater.calls.push("checkAndNotify"); return Promise.resolve() }
  return updater
}

function fakeTimers() {
  const intervals = new Set()
  return {
    intervals,
    api: {
      setInterval: (fn, ms) => { const handle = { fn, ms, unref() {} }; intervals.add(handle); return handle },
      clearInterval: (handle) => intervals.delete(handle),
    },
  }
}

function checker(t, { mode, reason = null, manifest, updater = fakeUpdater(), dialogResponse = 1 } = {}) {
  const dialogs = []
  const opened = []
  const timers = fakeTimers()
  const policies = []
  const instance = createUpdateChecker({
    app: packagedApp(t, manifest),
    dialog: {
      showMessageBox: async (...args) => {
        dialogs.push(args.at(-1))
        return { response: dialogResponse }
      },
    },
    shell: { openExternal: async (url) => { opened.push(url) } },
    getParentWindow: () => null,
    loadAutoUpdater: () => updater,
    resolveUpdatePolicy: (input) => {
      policies.push(input)
      return { mode, reason }
    },
    log: quiet,
    timers: timers.api,
    intervalMs: 1234,
  })
  return { instance, updater, dialogs, opened, timers, policies }
}

test("the update mode is decided from the policy and the build's signing metadata", (t) => {
  const { instance, policies } = checker(t, { mode: "notify", reason: "unsigned-build", manifest: { betterc0deCodeSigned: false } })
  assert.equal(instance.getUpdatesDisabledReason(), null, "nothing is decided before init")
  instance.initUpdatePolicy()
  assert.deepEqual(policies, [{ isPackaged: true, platform: process.platform, codeSigned: false }])
  assert.equal(instance.getUpdatesDisabledReason(), "unsigned-build")
  const status = instance.getUpdateStatus()
  assert.equal(status.mode, "notify")
  assert.equal(status.status, "idle")
  assert.equal(status.currentVersion, "1.0.0")
  assert.equal(status.releasesUrl, "https://github.com/fork/app/releases")
})

test("signed builds check, download and install on quit", (t) => {
  const { instance, updater, timers, policies } = checker(t, { mode: "auto", manifest: { betterc0deCodeSigned: true } })
  instance.initUpdatePolicy()
  assert.equal(policies[0].codeSigned, true)
  assert.equal(instance.getUpdatesDisabledReason(), null)
  instance.scheduleUpdateCheck()
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.deepEqual(updater.calls, ["checkAndNotify"])
  assert.equal(timers.intervals.size, 1)
  const [interval] = timers.intervals
  assert.equal(interval.ms, 1234)
  interval.fn()
  assert.deepEqual(updater.calls, ["checkAndNotify", "check"])
  updater.emit("update-downloaded", { version: "2.0.0" })
  assert.equal(instance.getUpdateStatus().status, "downloaded")
  instance.stopUpdateChecks()
  assert.equal(timers.intervals.size, 0)
})

test("notify-only builds never download and tell the user once per version", async (t) => {
  const { instance, updater, dialogs, opened } = checker(t, { mode: "notify", reason: "unsigned-build", dialogResponse: 0 })
  instance.initUpdatePolicy()
  instance.scheduleUpdateCheck()
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.deepEqual(updater.calls, ["check"])

  updater.emit("update-available", { version: "2.0.0" })
  updater.emit("update-available", { version: "2.0.0" })
  await new Promise((resolve) => setImmediate(resolve))
  const status = instance.getUpdateStatus()
  assert.equal(status.status, "available")
  assert.equal(status.availableVersion, "2.0.0")
  assert.equal(status.downloadUrl, "https://github.com/fork/app/releases/tag/v2.0.0")
  assert.equal(dialogs.length, 1)
  assert.match(dialogs[0].message, /2\.0\.0 is available/)
  assert.equal(dialogs[0].detail, updateNoticeDetail("unsigned-build"))
  assert.deepEqual(opened, ["https://github.com/fork/app/releases/tag/v2.0.0"])

  updater.emit("update-not-available")
  assert.equal(instance.getUpdateStatus().status, "up-to-date")
  updater.emit("error", new Error("offline"))
  assert.equal(instance.getUpdateStatus().status, "error")
  instance.stopUpdateChecks()
})

test("disabled builds never load the updater; a missing updater disables updates", (t) => {
  let loads = 0
  const disabled = createUpdateChecker({
    app: packagedApp(t),
    dialog: {},
    shell: {},
    loadAutoUpdater: () => { loads += 1; return fakeUpdater() },
    resolveUpdatePolicy: () => ({ mode: "disabled", reason: "development-build" }),
    log: quiet,
  })
  disabled.initUpdatePolicy()
  disabled.scheduleUpdateCheck()
  assert.equal(loads, 0)
  assert.equal(disabled.getUpdatesDisabledReason(), "development-build")

  const missing = createUpdateChecker({
    app: packagedApp(t),
    dialog: {},
    shell: {},
    loadAutoUpdater: () => null,
    resolveUpdatePolicy: () => ({ mode: "auto", reason: null }),
    log: quiet,
  })
  missing.initUpdatePolicy()
  missing.scheduleUpdateCheck()
  assert.equal(missing.getUpdatesDisabledReason(), "updater-unavailable")
  assert.equal(missing.getUpdateStatus().mode, "disabled")
})

test("no checks run once the app is quitting", (t) => {
  const updater = fakeUpdater()
  const quitting = createUpdateChecker({
    app: packagedApp(t),
    dialog: {},
    shell: {},
    isQuitting: () => true,
    loadAutoUpdater: () => updater,
    resolveUpdatePolicy: () => ({ mode: "auto", reason: null }),
    log: quiet,
    timers: fakeTimers().api,
  })
  quitting.initUpdatePolicy()
  quitting.scheduleUpdateCheck()
  assert.deepEqual(updater.calls, [])
})

test("the updater is loaded at most once, and a load failure is not retried", () => {
  let attempts = 0
  const warnings = []
  const load = createAutoUpdaterLoader({
    load: () => { attempts += 1; throw new Error("Cannot find module 'electron-updater'") },
    log: { warn: (...args) => warnings.push(args) },
  })
  assert.equal(load(), null)
  assert.equal(load(), null)
  assert.equal(attempts, 1)
  assert.equal(warnings.length, 1)
})
