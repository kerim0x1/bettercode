import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  MOBILE_MODES,
  STEP_IDS,
  assessNodeVersion,
  detectMobileToolchains,
  parseOptions,
  parseVersion,
  planSteps,
  satisfiesRange,
} from "./release-check.mjs"

const root = path.resolve(import.meta.dirname, "..")
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const pinnedNode = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim()

test("the release check runs its gates in the documented order", () => {
  assert.deepEqual(STEP_IDS, [
    "preflight",
    "install",
    "versions",
    "format",
    "lint",
    "typecheck",
    "test",
    "build",
    "mobile-android",
    "mobile-ios",
    "package",
    "smoke",
    "installers",
    "installer-smoke",
  ])
})

test("every npm script the release check calls exists", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "release-check.mjs"), "utf8")
  const called = new Set()
  for (const match of source.matchAll(/npm\(\["run", "([^"]+)"/g)) called.add(match[1])
  for (const match of source.matchAll(/for \(const script of \[([^\]]+)\]\)/g)) {
    for (const name of match[1].matchAll(/"([^"]+)"/g)) called.add(name[1])
  }
  const missing = [...called].filter((script) => !(script in manifest.scripts))
  assert.deepEqual(missing, [])
  assert.ok(called.has("format:check") && called.has("typecheck:shell") && called.has("test:mobile"))
  assert.ok(called.has("mobile:check"), "the build step checks the mobile app's config and bundles")
  assert.ok(called.has("test:e2e:remote"), "the test step runs the phone app's client against a real backend")
})

test(".nvmrc pins an exact Node version inside the engines range", () => {
  assert.match(pinnedNode, /^\d+\.\d+\.\d+$/)
  assert.equal(satisfiesRange(pinnedNode, manifest.engines.node), true)
  assert.equal(
    fs.readFileSync(path.join(root, ".node-version"), "utf8").trim(),
    pinnedNode,
    ".node-version and .nvmrc must name the same version"
  )
})

test("version ranges follow the engines semantics", () => {
  assert.deepEqual(parseVersion("v22.23.2"), [22, 23, 2])
  assert.equal(parseVersion("latest"), null)

  const range = "^22.15.0 || ^24.0.0"
  assert.equal(satisfiesRange("v22.15.0", range), true)
  assert.equal(satisfiesRange("22.14.9", range), false)
  assert.equal(satisfiesRange("23.0.0", range), false)
  assert.equal(satisfiesRange("24.21.0", range), true)
  assert.equal(satisfiesRange("26.0.0", range), false)

  assert.equal(satisfiesRange("10.9.8", ">=10"), true)
  assert.equal(satisfiesRange("9.9.9", ">=10"), false)
  assert.equal(satisfiesRange("5.0.0", ">=4 <6"), true)
  assert.equal(satisfiesRange("6.0.0", ">=4 <6"), false)
  assert.throws(() => satisfiesRange("1.0.0", "~1.0.0"), /Unsupported version range/)
})

test("Node outside the range fails; off-pin fails only for strict release builds", () => {
  const base = { pinned: "22.23.2", engines: "^22.15.0 || ^24.0.0" }
  assert.equal(assessNodeVersion({ ...base, current: "v20.19.0", strict: false }).level, "error")
  assert.equal(assessNodeVersion({ ...base, current: "v22.23.2", strict: true }).level, "ok")
  assert.equal(assessNodeVersion({ ...base, current: "v22.15.0", strict: false }).level, "warn")
  assert.equal(assessNodeVersion({ ...base, current: "v22.15.0", strict: true }).level, "error")
  assert.equal(assessNodeVersion({ ...base, current: "v24.21.0", strict: false }).level, "warn")
})

test("the installer smoke defaults on in CI and off on a workstation", () => {
  assert.equal(parseOptions([], { CI: "true" }).installerSmoke, true)
  assert.equal(parseOptions([], {}).installerSmoke, false)
  assert.equal(parseOptions(["--installer-smoke"], {}).installerSmoke, true)
  assert.equal(parseOptions(["--no-installer-smoke"], { CI: "true" }).installerSmoke, false)
})

test("options reject unknown steps, reversed ranges and unsupported architectures", () => {
  assert.throws(() => parseOptions(["--until", "deploy"], {}), /--until must be one of/)
  assert.throws(() => parseOptions(["--from", "smoke", "--until", "lint"], {}), /--from must not come after/)
  assert.throws(() => parseOptions(["--arch", "ia32"], {}), /x64 or arm64/)
  assert.throws(() => parseOptions(["--until"], {}), /needs a value/)
  assert.throws(() => parseOptions(["--frobnicate"], {}), /Unknown option/)
})

test("plans keep preflight and explain every skipped step", () => {
  const plan = planSteps(parseOptions(["--from", "lint", "--until", "build", "--skip-install"], {}))
  assert.deepEqual(
    plan.filter((step) => step.run).map((step) => step.id),
    ["preflight", "lint", "typecheck", "test", "build"]
  )
  for (const step of plan.filter((candidate) => !candidate.run)) {
    assert.ok(step.reason, `${step.id} is skipped without a reason`)
  }

  const full = planSteps(parseOptions([], { CI: "true" }), { android: null, ios: null })
  assert.equal(full.every((step) => step.run), true)
})

test("the phone app steps run where their toolchain is, and say why they do not elsewhere", () => {
  const onWindows = { android: null, ios: "iOS builds need macOS with Xcode." }
  const plan = planSteps(parseOptions([], {}), onWindows)
  const step = (id) => plan.find((candidate) => candidate.id === id)
  assert.deepEqual(step("mobile-android"), { id: "mobile-android", run: true })
  assert.deepEqual(step("mobile-ios"), {
    id: "mobile-ios",
    run: false,
    reason: "no iOS toolchain: iOS builds need macOS with Xcode.",
  })

  const noSdk = planSteps(parseOptions([], {}), { android: "The Android SDK was not found.", ios: null })
  assert.equal(noSdk.find((candidate) => candidate.id === "mobile-android").reason, "no Android toolchain: The Android SDK was not found.")
})

test("--mobile names the platforms, and a named platform is not skipped for a missing toolchain", () => {
  const missing = { android: "JDK 17 was not found.", ios: "iOS builds need macOS with Xcode." }
  const runs = (mode) =>
    planSteps(parseOptions(["--mobile", mode], {}), missing)
      .filter((step) => step.id.startsWith("mobile-") && step.run)
      .map((step) => step.id)
  // Preflight reports the missing toolchain of a platform asked for by name.
  assert.deepEqual(runs("android"), ["mobile-android"])
  assert.deepEqual(runs("ios"), ["mobile-ios"])
  assert.deepEqual(runs("all"), ["mobile-android", "mobile-ios"])
  assert.deepEqual(runs("none"), [])
  assert.deepEqual(runs("auto"), [])
  const none = planSteps(parseOptions(["--mobile", "none"], {}), missing)
  assert.equal(none.find((step) => step.id === "mobile-android").reason, "--mobile none")
  assert.deepEqual(MOBILE_MODES, ["auto", "android", "ios", "all", "none"])
  assert.throws(() => parseOptions(["--mobile", "windows-phone"], {}), /--mobile must be one of/)
})

test("toolchains are only probed for the platforms asked for", () => {
  assert.deepEqual(detectMobileToolchains("none"), { android: "not requested", ios: "not requested" })
  assert.equal(detectMobileToolchains("ios", { platform: "linux" }).android, "not requested")
  assert.equal(detectMobileToolchains("ios", { platform: "linux" }).ios, "iOS builds need macOS with Xcode.")
})

test("the phone app steps call scripts that exist", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "release-check.mjs"), "utf8")
  const scripts = [...source.matchAll(/path\.join\(root, "scripts", "(mobile-[a-z]+\.mjs)"\)/g)].map((match) => match[1])
  assert.deepEqual(scripts.sort(), ["mobile-android.mjs", "mobile-ios.mjs"])
  for (const script of scripts) assert.equal(fs.existsSync(path.join(root, "scripts", script)), true, script)
})
