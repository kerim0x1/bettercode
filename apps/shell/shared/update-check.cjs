/**
 * Release-feed checks and the update mode surfaced through `app:info`.
 *
 * The mode comes from shared/update-policy.cjs: signed Windows/macOS builds
 * and AppImages download and install on quit ("auto"); unsigned builds and
 * deb/rpm/pacman installs only check the feed and link to the download
 * ("notify"); development runs never check ("disabled").
 *
 * main.cjs decides the mode before the first window asks for app info
 * (`initUpdatePolicy`), starts the checks after first paint
 * (`scheduleUpdateCheck`) and stops them at shutdown (`stopUpdateChecks`).
 */

const path = require("path")
const appConfig = require("./appConfig.cjs")
const { projectLinks } = require("./startup-failure.cjs")

/**
 * Lazily-loaded electron-updater.  Isolated in a try/catch so the app keeps
 * booting on setups where the dep hasn't been installed yet (e.g. a checkout
 * that skipped `npm install`).  The release pipeline configures the GitHub
 * provider through `build.publish` in package.json, so no runtime URL is
 * hardcoded here — the generated `app-update.yml` ships inside the asar.
 */
// Loaded lazily: electron-updater pulls in js-yaml and builder-util-runtime,
// which is a pointless parse cost at boot given the update check is deferred
// until after first paint — and is skipped entirely on unsigned builds.
function createAutoUpdaterLoader({ load = () => require("electron-updater").autoUpdater, log = console } = {}) {
  let autoUpdater = null
  let autoUpdaterLoaded = false
  return function loadAutoUpdater() {
    if (autoUpdaterLoaded) return autoUpdater
    autoUpdaterLoaded = true
    try {
      autoUpdater = load()
    } catch (err) {
      log.warn(
        "[electron] electron-updater not installed — auto-update disabled:",
        err && err.message ? err.message : err,
      )
    }
    return autoUpdater
  }
}

function updateNoticeDetail(reason) {
  switch (reason) {
    case "unsigned-build":
      return "This build is not code-signed, so it cannot install updates by itself. Download the new version from the release page and install it over this one. Your chats and settings are kept."
    case "package-manager":
      return "BetterC0de was installed as a system package. Install the new package from the release page or with your package manager."
    default:
      return "Download the new version from the release page."
  }
}

/**
 * @param {object} options
 * @param {{ isPackaged: boolean, getVersion(): string, getAppPath(): string }} options.app
 * @param {{ showMessageBox: Function }} options.dialog
 * @param {{ openExternal(url: string): Promise<void> }} options.shell
 * @param {() => unknown} options.getParentWindow The main window, if open.
 * @param {() => boolean} options.isQuitting
 * @param {() => any} [options.loadAutoUpdater] electron-updater's autoUpdater, or null.
 */
function createUpdateChecker({
  app,
  dialog,
  shell,
  getParentWindow = () => null,
  isQuitting = () => false,
  loadAutoUpdater = createAutoUpdaterLoader(),
  resolveUpdatePolicy = (input) => require("./update-policy.cjs").resolveUpdatePolicy(input),
  releasePageUrl = (releasesUrl, version) => require("./update-policy.cjs").releasePageUrl(releasesUrl, version),
  intervalMs = appConfig.UPDATE_CHECK_INTERVAL_MS,
  log = console,
  timers = { setInterval, clearInterval },
  now = Date.now,
}) {
  let autoUpdater = null
  /**
   * Surfaced through `app:info`: why this build cannot install updates by
   * itself ("unsigned-build", "package-manager", "unsupported-package",
   * "updater-unavailable", "development-build"), or null when it can.
   */
  let updatesDisabledReason = null
  /** Update mode and the result of the latest release-feed check. */
  const updateState = {
    mode: "disabled",
    reason: null,
    status: "idle",
    availableVersion: null,
    downloadUrl: null,
    releasesUrl: null,
    checkedAt: null,
  }
  let updateCheckTimer = null
  let updateListenersAttached = false
  const notifiedUpdateVersions = new Set()

  function getUpdateStatus() {
    return { ...updateState, currentVersion: app.getVersion() }
  }

  /**
   * Signing posture baked into the packaged `package.json` at build time by
   * `scripts/pack-electron.cjs` (`extraMetadata.betterc0deCodeSigned`).
   * Unpackaged dev runs report false and never reach the update path anyway.
   */
  function isCodeSignedBuild() {
    try {
      const meta = require(path.join(app.getAppPath(), "package.json"))
      return meta?.betterc0deCodeSigned === true
    } catch {
      return false
    }
  }

  /**
   * Decide the update mode (shared/update-policy.cjs) before the first window
   * asks for app info. Unsigned Windows and macOS builds, and deb/rpm/pacman
   * installs, are notify-only: they check the release feed and link to the
   * download, but never download or install anything themselves.
   */
  function initUpdatePolicy() {
    const policy = resolveUpdatePolicy({
      isPackaged: app.isPackaged,
      platform: process.platform,
      codeSigned: isCodeSignedBuild(),
    })
    updateState.mode = policy.mode
    updateState.reason = policy.reason
    try {
      updateState.releasesUrl = projectLinks(require(path.join(app.getAppPath(), "package.json"))).releases
    } catch {
      updateState.releasesUrl = projectLinks(undefined).releases
    }
    updatesDisabledReason = policy.mode === "auto" ? null : policy.reason
  }

  /** Notify-only builds: tell the user once per version and session. */
  function notifyUpdateAvailable(version) {
    const url = updateState.downloadUrl
    if (!url || isQuitting() || notifiedUpdateVersions.has(version)) return
    notifiedUpdateVersions.add(version)
    const mainWindow = getParentWindow()
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    const options = {
      type: "info",
      title: "BetterC0de update",
      message: `BetterC0de ${version} is available.`,
      detail: updateNoticeDetail(updateState.reason),
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }
    void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
      .then(({ response }) => (response === 0 ? shell.openExternal(url) : undefined))
      .catch((err) => {
        log.warn("[electron] Could not open the release page:", err?.message || err)
      })
  }

  function attachUpdateListeners() {
    if (updateListenersAttached) return
    updateListenersAttached = true
    const versionOf = (info) => (info && typeof info.version === "string" ? info.version : null)
    autoUpdater.on("checking-for-update", () => {
      updateState.status = "checking"
    })
    autoUpdater.on("update-available", (info) => {
      const version = versionOf(info)
      log.log("[electron] update available:", version ?? "(unknown version)")
      updateState.status = "available"
      updateState.availableVersion = version
      updateState.downloadUrl = releasePageUrl(updateState.releasesUrl, version)
      updateState.checkedAt = now()
      if (updateState.mode === "notify" && version) notifyUpdateAvailable(version)
    })
    autoUpdater.on("update-not-available", () => {
      log.log("[electron] up to date")
      updateState.status = "up-to-date"
      updateState.availableVersion = null
      updateState.downloadUrl = null
      updateState.checkedAt = now()
    })
    autoUpdater.on("update-downloaded", (info) => {
      // Auto mode only; electron-updater has verified the download against the
      // sha512 from the release metadata before this event.
      log.log(
        "[electron] update downloaded:",
        versionOf(info) ?? "(unknown version)",
        "— will install on next quit",
      )
      updateState.status = "downloaded"
    })
    autoUpdater.on("error", (err) => {
      // Network failures, a missing release feed and refused installs land
      // here. Never let an update error crash the app.
      log.warn("[electron] update check failed:", err && err.message ? err.message : err)
      updateState.status = "error"
      updateState.checkedAt = now()
    })
  }

  function runUpdateCheck({ notify = false } = {}) {
    if (isQuitting() || !autoUpdater) return
    const check = notify && updateState.mode === "auto"
      ? autoUpdater.checkForUpdatesAndNotify()
      : autoUpdater.checkForUpdates()
    // A failure is already reported through the "error" listener; this catch
    // only covers a rejection before the listener runs.
    Promise.resolve(check).catch((err) => {
      log.warn("[electron] update check rejected:", err && err.message ? err.message : err)
    })
  }

  function scheduleUpdateCheck() {
    if (updateState.mode === "disabled") {
      log.log(`[electron] update checks are off (${updateState.reason})`)
      return
    }
    autoUpdater = loadAutoUpdater()
    if (!autoUpdater) {
      updateState.mode = "disabled"
      updateState.reason = "updater-unavailable"
      updatesDisabledReason = "updater-unavailable"
      return
    }
    const notifyOnly = updateState.mode === "notify"
    if (notifyOnly) {
      log.log(`[electron] update checks are notify-only (${updateState.reason})`)
    }
    autoUpdater.autoDownload = !notifyOnly
    autoUpdater.autoInstallOnAppQuit = !notifyOnly
    attachUpdateListeners()
    runUpdateCheck({ notify: true })
    if (!updateCheckTimer) {
      updateCheckTimer = timers.setInterval(() => runUpdateCheck(), intervalMs)
      updateCheckTimer.unref?.()
    }
  }

  function stopUpdateChecks() {
    if (updateCheckTimer) timers.clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }

  return {
    initUpdatePolicy,
    scheduleUpdateCheck,
    stopUpdateChecks,
    getUpdateStatus,
    getUpdatesDisabledReason: () => updatesDisabledReason,
  }
}

module.exports = {
  createAutoUpdaterLoader,
  createUpdateChecker,
  updateNoticeDetail,
}
