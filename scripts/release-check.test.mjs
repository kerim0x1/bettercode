import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  STEP_IDS,
  assessNodeVersion,
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
  const missing = [...called].filter(
    (script) => script !== "export:web" && !(script in manifest.scripts)
  )
  assert.deepEqual(missing, [])
  assert.ok(called.has("format:check") && called.has("typecheck:shell") && called.has("test:mobile"))
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

  const full = planSteps(parseOptions([], { CI: "true" }))
  assert.equal(full.every((step) => step.run), true)
})
