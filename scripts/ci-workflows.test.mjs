import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import YAML from "yaml"

const root = path.resolve(import.meta.dirname, "..")

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
