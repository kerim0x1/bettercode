import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import YAML from "yaml"

import { DEFAULT_AVD, MINIMUM_XCODE, androidRequirements } from "./mobile-toolchain.mjs"

const root = path.resolve(import.meta.dirname, "..")

function readWorkflow(name) {
  return YAML.parse(fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8"))
}

const runs = (job) => job.steps.map((step) => step.run ?? step.with?.script).filter(Boolean)

function workflowFiles() {
  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (/\.ya?ml$/.test(entry.name)) files.push(file)
    }
  }
  visit(path.join(root, ".github", "workflows"))
  visit(path.join(root, ".github", "actions"))
  return files
}

function collectUses(node, found = []) {
  if (Array.isArray(node)) node.forEach((item) => collectUses(item, found))
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses" && typeof value === "string") found.push(value)
      else collectUses(value, found)
    }
  }
  return found
}

test("third-party actions are pinned to a full commit SHA with a version comment", () => {
  for (const file of workflowFiles()) {
    const source = fs.readFileSync(file, "utf8")
    for (const uses of collectUses(YAML.parse(source))) {
      if (uses.startsWith("./")) continue
      assert.match(uses, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/, `${path.relative(root, file)}: ${uses}`)
      const line = source.split("\n").find((candidate) => candidate.includes(uses))
      assert.match(line, /#\s*v\d+/, `${path.relative(root, file)}: ${uses} needs a "# vX.Y.Z" comment`)
    }
  }
})

test("jobs run on pinned runner images, not moving -latest labels", () => {
  for (const file of workflowFiles().filter((candidate) => candidate.includes("workflows"))) {
    const source = fs.readFileSync(file, "utf8")
    assert.doesNotMatch(source, /-latest\b/, `${path.relative(root, file)} uses a -latest runner label`)
  }
})

test("CI and release run release:check on Linux, Windows and both Mac architectures", () => {
  for (const name of ["ci.yml", "release.yml"]) {
    const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8"))
    const targets = workflow.jobs["release-check"].strategy.matrix.include.map(
      ({ os, arch }) => `${os}/${arch}`
    )
    assert.deepEqual(
      targets.sort(),
      ["macos-15-intel/x64", "macos-15/arm64", "ubuntu-24.04/x64", "windows-2025/x64"],
      name
    )
  }
})

test("macOS legs turn off Spotlight before release:check builds the DMG", () => {
  for (const name of ["ci.yml", "release.yml"]) {
    const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8"))
    const steps = workflow.jobs["release-check"].steps
    const spotlight = steps.findIndex((step) => step.run === "sudo mdutil -a -i off")
    assert.notEqual(spotlight, -1, `${name} turns off Spotlight`)
    assert.equal(steps[spotlight].if, "runner.os == 'macOS'", name)
    const check = steps.findIndex((step) => String(step.run ?? "").startsWith("npm run release:check"))
    assert.ok(spotlight < check, `${name} turns it off before release:check`)
  }
})

test("publishing waits for every platform and the Node compatibility leg", () => {
  const release = YAML.parse(fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8"))
  assert.deepEqual(release.jobs.publish.needs.sort(), ["node-compat", "release-check", "tag"])
  assert.equal(release.jobs["release-check"].strategy["fail-fast"], false)
  assert.deepEqual(release.permissions, { contents: "read" })
  assert.deepEqual(release.jobs.publish.permissions, { contents: "write" })
})

test("the desktop legs leave the phone app to its own jobs", () => {
  for (const name of ["ci.yml", "release.yml"]) {
    const command = runs(readWorkflow(name).jobs["release-check"]).find((run) => run.includes("release:check"))
    assert.match(command, /--mobile none\b/, name)
  }
})

test("CI builds the phone app and runs its device tests on Android and iOS", () => {
  const ci = readWorkflow("ci.yml")
  const android = ci.jobs["mobile-android"]
  assert.equal(android["runs-on"], "ubuntu-24.04")
  assert.deepEqual(runs(android).filter((run) => run.includes("mobile-android.mjs")), [
    "node scripts/mobile-android.mjs build --signing test-key",
    "node scripts/mobile-android.mjs e2e",
  ])
  const emulator = android.steps.find((step) => step.uses?.startsWith("reactivecircus/android-emulator-runner@"))
  assert.equal(emulator.with["api-level"], androidRequirements().targetSdk, "the emulator runs the app's targetSdk")
  assert.equal(emulator.with.arch, "x86_64")
  assert.equal(emulator.with["avd-name"], DEFAULT_AVD, "the device tests only use the test AVD")

  const ios = ci.jobs["mobile-ios"]
  assert.match(ios["runs-on"], /^macos-\d+$/)
  assert.deepEqual(runs(ios).filter((run) => run.includes("mobile-ios.mjs")), ["node scripts/mobile-ios.mjs all"])
  const xcode = /Xcode_(\d+)\.[\d.]+\.app/.exec(ios.env.DEVELOPER_DIR)
  assert.ok(xcode && Number(xcode[1]) >= MINIMUM_XCODE, `iOS builds need Xcode ${MINIMUM_XCODE}+`)
})

test("CI uses no secrets, so pull requests from forks run everything", () => {
  const source = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8")
  assert.doesNotMatch(source, /secrets\./)
})
