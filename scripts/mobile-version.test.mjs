import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, "..")
const {
  MAX_VERSION_CODE,
  androidVersionCode,
  iosMarketingVersion,
  parseReleaseVersion,
} = require("../apps/mobile/config/version.cjs")

test("the Android versionCode follows the documented formula", () => {
  assert.equal(androidVersionCode("0.1.0-alpha.1"), 100101)
  assert.equal(androidVersionCode("0.1.0-beta.2"), 100302)
  assert.equal(androidVersionCode("0.1.0-rc.1"), 100501)
  assert.equal(androidVersionCode("0.1.0"), 100900)
  assert.equal(androidVersionCode("1.2.3"), 10203900)
})

test("every later release gets a larger versionCode, so Android accepts it as an update", () => {
  const ordered = [
    "0.0.1-alpha.0",
    "0.0.1",
    "0.1.0-alpha.1",
    "0.1.0-alpha.99",
    "0.1.0-beta.0",
    "0.1.0-beta.2",
    "0.1.0-beta.99",
    "0.1.0-rc.0",
    "0.1.0-rc.99",
    "0.1.0",
    "0.1.1-alpha.0",
    "0.1.1",
    "0.2.0-beta.1",
    "0.99.99",
    "1.0.0-alpha.0",
    "1.0.0",
    "209.99.99",
  ]
  for (let index = 1; index < ordered.length; index += 1) {
    const [previous, next] = [ordered[index - 1], ordered[index]]
    assert.ok(
      androidVersionCode(next) > androidVersionCode(previous),
      `${next} (${androidVersionCode(next)}) must sort after ${previous} (${androidVersionCode(previous)})`
    )
  }
  assert.ok(androidVersionCode("209.99.99") < MAX_VERSION_CODE)
})

test("iOS gets the numeric core, because the App Store refuses prerelease suffixes", () => {
  assert.equal(iosMarketingVersion("0.1.0-beta.2"), "0.1.0")
  assert.equal(iosMarketingVersion("1.10.3"), "1.10.3")
})

test("versions the formula cannot order are rejected instead of mapped", () => {
  for (const version of [
    "",
    "1.2",
    "v1.2.3",
    "01.2.3",
    "1.2.3-beta",
    "1.2.3-beta.01",
    "1.2.3-preview.1",
    "1.2.3-beta.1.2",
    "1.2.3+build.5",
    "1.100.0",
    "1.0.100",
    "1.0.0-rc.100",
    "210.0.0",
  ]) {
    assert.throws(() => parseReleaseVersion(version), /release version/i, version)
  }
})

test("the current desktop version maps cleanly", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  assert.doesNotThrow(() => androidVersionCode(version))
})
