import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"

const { releasePageUrl, resolveUpdatePolicy } = createRequire(import.meta.url)("../apps/shell/shared/update-policy.cjs")

const noPackageType = { readFileSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) } }
const packageType = (type) => ({
  readFileSync: (file) => {
    assert.equal(path.basename(file), "package-type")
    return `${type}\n`
  },
})

test("development builds never check for updates", () => {
  assert.deepEqual(resolveUpdatePolicy({ isPackaged: false, platform: "win32" }), { mode: "disabled", reason: "development-build" })
})

test("unsigned Windows and macOS builds are notify-only; signed ones auto-update", () => {
  for (const platform of ["win32", "darwin"]) {
    assert.deepEqual(
      resolveUpdatePolicy({ isPackaged: true, platform, codeSigned: false }),
      { mode: "notify", reason: "unsigned-build" },
      platform,
    )
    assert.deepEqual(
      resolveUpdatePolicy({ isPackaged: true, platform, codeSigned: true }),
      { mode: "auto", reason: null },
      platform,
    )
  }
})

test("Linux system packages are notify-only; AppImage auto-updates with checksum verification", () => {
  for (const type of ["deb", "rpm", "pacman"]) {
    assert.deepEqual(
      resolveUpdatePolicy({ isPackaged: true, platform: "linux", env: { APPIMAGE: "/home/u/BetterC0de.AppImage" }, resourcesPath: "/opt/BetterC0de/resources", fsImpl: packageType(type) }),
      { mode: "notify", reason: "package-manager" },
      type,
    )
  }
  assert.deepEqual(
    resolveUpdatePolicy({ isPackaged: true, platform: "linux", env: { APPIMAGE: "/home/u/BetterC0de.AppImage" }, resourcesPath: "/tmp/.mount/resources", fsImpl: noPackageType }),
    { mode: "auto", reason: null },
  )
  assert.deepEqual(
    resolveUpdatePolicy({ isPackaged: true, platform: "linux", env: {}, resourcesPath: "/opt/x/resources", fsImpl: noPackageType }),
    { mode: "notify", reason: "unsupported-package" },
  )
})

test("release links point at the version's tag only for a valid version", () => {
  const releases = "https://github.com/kerim0x1/bettercode/releases"
  assert.equal(releasePageUrl(releases, "0.2.0-beta.1"), `${releases}/tag/v0.2.0-beta.1`)
  assert.equal(releasePageUrl(`${releases}/`, "1.0.0"), `${releases}/tag/v1.0.0`)
  assert.equal(releasePageUrl(releases, "../../evil"), releases)
  assert.equal(releasePageUrl(releases, null), releases)
  assert.equal(releasePageUrl("http://insecure.example/releases", "1.0.0"), null)
})
