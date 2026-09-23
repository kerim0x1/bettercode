import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import YAML from "yaml"

import { assembleRelease, mergeUpdateInfo, requiredAssetGaps } from "./assemble-release.mjs"

const VERSION = "0.1.0-beta.3"

function sha512(content) {
  return createHash("sha512").update(content).digest("base64")
}

function writeJob(root, job, files) {
  const dir = path.join(root, job)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
}

function updateInfo(files) {
  const entries = Object.entries(files).map(([url, content]) => ({
    url,
    sha512: sha512(content),
    size: Buffer.byteLength(content),
  }))
  return YAML.stringify({
    version: VERSION,
    files: entries,
    path: entries[0].url,
    sha512: entries[0].sha512,
    releaseDate: "2026-09-23T10:00:00.000Z",
  })
}

function completeRelease(root) {
  const windows = { [`BetterC0de-Setup-${VERSION}.exe`]: "exe" }
  const macX64 = { [`BetterC0de-${VERSION}-mac.zip`]: "zip-x64", [`BetterC0de-${VERSION}.dmg`]: "dmg-x64" }
  const macArm = {
    [`BetterC0de-${VERSION}-arm64-mac.zip`]: "zip-arm64",
    [`BetterC0de-${VERSION}-arm64.dmg`]: "dmg-arm64",
  }
  const linux = { [`BetterC0de-${VERSION}.AppImage`]: "appimage" }
  writeJob(root, "installers-windows-x64", {
    ...windows,
    [`BetterC0de-Setup-${VERSION}.exe.blockmap`]: "bm",
    "latest.yml": updateInfo(windows),
    "SHA256SUMS-Windows-x64.txt": "per-job",
  })
  writeJob(root, "installers-macos-x64", { ...macX64, "latest-mac.yml": updateInfo(macX64) })
  writeJob(root, "installers-macos-arm64", { ...macArm, "latest-mac.yml": updateInfo(macArm) })
  writeJob(root, "installers-linux-x64", {
    ...linux,
    [`betterc0de_${VERSION}_amd64.deb`]: "deb",
    [`betterc0de-${VERSION}.x86_64.rpm`]: "rpm",
    [`betterc0de-${VERSION}.tar.gz`]: "tgz",
    "latest-linux.yml": updateInfo(linux),
  })
}

function withTempDirs(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "assemble-release-test-"))
  try {
    run(path.join(base, "artifacts"), path.join(base, "out"))
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

test("a complete release is assembled with merged Mac metadata and one checksum file", () => {
  withTempDirs((artifacts, out) => {
    completeRelease(artifacts)
    const files = assembleRelease(artifacts, out)

    assert.ok(files.includes("SHA256SUMS.txt"))
    assert.equal(files.some((file) => /^SHA256SUMS-/.test(file)), false)

    const mac = YAML.parse(fs.readFileSync(path.join(out, "latest-mac.yml"), "utf8"))
    assert.deepEqual(
      mac.files.map((file) => file.url),
      [
        `BetterC0de-${VERSION}-arm64-mac.zip`,
        `BetterC0de-${VERSION}-arm64.dmg`,
        `BetterC0de-${VERSION}-mac.zip`,
        `BetterC0de-${VERSION}.dmg`,
      ]
    )
    assert.equal(mac.path, `BetterC0de-${VERSION}-mac.zip`)

    const sums = fs.readFileSync(path.join(out, "SHA256SUMS.txt"), "utf8")
    assert.match(sums, new RegExp(`  BetterC0de-${VERSION}-arm64\\.dmg\\n`))
    assert.doesNotMatch(sums, /blockmap|\.yml/)
  })
})

test("two jobs producing the same installer name block the release", () => {
  withTempDirs((artifacts, out) => {
    completeRelease(artifacts)
    // The 0.1.0-beta.2 failure: the x64 runner also emitted an arm64 name.
    writeJob(artifacts, "installers-macos-x64", {
      [`BetterC0de-${VERSION}-arm64.dmg`]: "an x64 app under the arm64 name",
    })
    assert.throws(
      () => assembleRelease(artifacts, out),
      /same file name[\s\S]*BetterC0de-0\.1\.0-beta\.3-arm64\.dmg/
    )
  })
})

test("update metadata that does not match the published file blocks the release", () => {
  withTempDirs((artifacts, out) => {
    completeRelease(artifacts)
    fs.writeFileSync(
      path.join(artifacts, "installers-windows-x64", `BetterC0de-Setup-${VERSION}.exe`),
      "a different binary"
    )
    assert.throws(() => assembleRelease(artifacts, out), /latest\.yml: .*\.exe (size|sha512) does not match/)
  })
})

test("a missing platform blocks the release and names the gap", () => {
  withTempDirs((artifacts, out) => {
    completeRelease(artifacts)
    fs.rmSync(path.join(artifacts, "installers-linux-x64"), { recursive: true })
    assert.throws(
      () => assembleRelease(artifacts, out),
      /missing: Linux AppImage[\s\S]*missing: Linux update metadata/
    )
  })
})

test("Mac metadata merge rejects mismatched versions and conflicting duplicates", () => {
  const entry = (url, sha) => ({ url, sha512: sha, size: 1 })
  assert.throws(
    () =>
      mergeUpdateInfo([
        { version: "1.0.0", files: [entry("a-mac.zip", "x")] },
        { version: "1.0.1", files: [entry("a-arm64-mac.zip", "y")] },
      ]),
    /disagrees on the version/
  )
  assert.throws(
    () =>
      mergeUpdateInfo([
        { version: "1.0.0", files: [entry("a-mac.zip", "x")] },
        { version: "1.0.0", files: [entry("a-mac.zip", "y")] },
      ]),
    /different contents/
  )
})

test("required asset patterns keep x64 and arm64 Mac downloads apart", () => {
  const gaps = requiredAssetGaps([`BetterC0de-${VERSION}-arm64.dmg`])
  assert.ok(gaps.includes("macOS x64 disk image"))
  assert.equal(gaps.includes("macOS arm64 disk image"), false)
})
