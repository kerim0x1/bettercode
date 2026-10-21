/**
 * How a packaged build may update itself.
 *
 * - `auto`: electron-updater downloads the update and installs it on quit.
 *   Used where the platform verifies what it installs: code-signed Windows
 *   and macOS builds, and AppImage builds, whose download electron-updater
 *   checks against the sha512 published in latest-linux.yml (both for full
 *   and for differential downloads).
 * - `notify`: the release feed is checked and the user is told about a new
 *   version with a link to the release page, but nothing is downloaded or
 *   installed. Used for unsigned Windows builds (SmartScreen re-warns on the
 *   installer), unsigned macOS builds (Squirrel.Mac refuses to install into
 *   an unsigned app, so auto-update would fail silently), and deb/rpm/pacman
 *   packages, whose self-update would run a privileged package install of an
 *   artifact authenticated only by a checksum from the same release.
 * - `disabled`: development builds, or electron-updater is missing.
 */

const fs = require("node:fs")
const path = require("node:path")

const SYSTEM_PACKAGE_TYPES = new Set(["deb", "rpm", "pacman"])

function readLinuxPackageType({ resourcesPath, fsImpl = fs }) {
  if (typeof resourcesPath !== "string" || !resourcesPath) return null
  try {
    return fsImpl.readFileSync(path.join(resourcesPath, "package-type"), "utf8").trim() || null
  } catch {
    return null
  }
}

/**
 * @returns {{ mode: "auto" | "notify" | "disabled", reason: string | null }}
 */
function resolveUpdatePolicy({
  isPackaged,
  platform = process.platform,
  codeSigned = false,
  env = process.env,
  resourcesPath = process.resourcesPath,
  fsImpl = fs,
}) {
  if (!isPackaged) return { mode: "disabled", reason: "development-build" }
  if (platform === "win32" || platform === "darwin") {
    return codeSigned
      ? { mode: "auto", reason: null }
      : { mode: "notify", reason: "unsigned-build" }
  }
  const packageType = readLinuxPackageType({ resourcesPath, fsImpl })
  if (packageType && SYSTEM_PACKAGE_TYPES.has(packageType)) {
    return { mode: "notify", reason: "package-manager" }
  }
  if (typeof env.APPIMAGE === "string" && path.isAbsolute(env.APPIMAGE)) {
    return { mode: "auto", reason: null }
  }
  return { mode: "notify", reason: "unsupported-package" }
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Release page for `version`, or the releases index for an unusable version. */
function releasePageUrl(releasesUrl, version) {
  if (typeof releasesUrl !== "string" || !/^https:\/\//i.test(releasesUrl)) return null
  const base = releasesUrl.replace(/\/+$/, "")
  return typeof version === "string" && RELEASE_VERSION.test(version)
    ? `${base}/tag/v${encodeURIComponent(version)}`
    : base
}

module.exports = { readLinuxPackageType, releasePageUrl, resolveUpdatePolicy }
