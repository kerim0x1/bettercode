import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import test from "node:test"
import { pruneBuildOutput } from "./prune-build-output.mjs"

function workspace(t, target = "backend") {
  // Canonical, because Node's resolver reports canonical paths and the
  // assertions compare against it; macOS reaches the temp dir through the
  // /var -> /private/var symlink.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-prune-test-")))
  // Only this fixture-owned absolute directory is removed, never the repository.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const backend = path.join(root, target === "schema" ? "packages" : "apps", target)
  fs.mkdirSync(path.join(backend, "src"), { recursive: true })
  fs.writeFileSync(path.join(backend, "package.json"), JSON.stringify({ name: `@betterc0de/${target}` }))
  function write(relative, content = "fixture") {
    const target = path.join(backend, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    return target
  }
  return { root, backend, write }
}

test("stale sibling JS no longer shadows the current directory entry; valid output and unrelated files survive", (t) => {
  const { root, backend, write } = workspace(t)
  write("src/services/git/index.ts", "export const current = true")
  write("dist/services/git.js", "module.exports = 'stale'")
  write("dist/services/git.js.map", "stale map")
  const current = write("dist/services/git/index.js", "module.exports = 'current'")
  const currentMap = write("dist/services/git/index.js.map", "current map")
  const unrelated = write("dist/asset.json", "unrelated asset")
  const declaration = write("dist/types.d.ts", "export type Value = string")
  write("src/valid.ts", "export const value = 1")
  const valid = write("dist/valid.js", "valid output")
  const validMap = write("dist/valid.js.map", "valid map")
  write("dist/removed/deep/old.js", "stale nested output")
  const require = createRequire(path.join(backend, "package.json"))
  assert.equal(require.resolve("./dist/services/git"), path.join(backend, "dist/services/git.js"))

  assert.deepEqual(pruneBuildOutput("backend", root), ["removed/deep/old.js", "services/git.js", "services/git.js.map"])
  assert.equal(require.resolve("./dist/services/git/index.js"), current)
  // A fresh resolver avoids Node's cached pre-prune module resolution.
  const cleanRequire = createRequire(path.join(backend, "dist/package.json"))
  assert.equal(cleanRequire.resolve("./services/git"), current)
  for (const file of [current, currentMap, unrelated, declaration, valid, validMap]) assert.ok(fs.existsSync(file), file)
  assert.ok(fs.statSync(path.join(backend, "dist/removed/deep")).isDirectory())
  assert.deepEqual(pruneBuildOutput("backend", root), [])
})

test("fresh clones without dist need no setup or cleanup", (t) => {
  const { root, backend } = workspace(t)
  assert.deepEqual(pruneBuildOutput("backend", root), [])
  assert.equal(fs.existsSync(path.join(backend, "dist")), false)
})

test("declarations alone do not preserve stale executable output", (t) => {
  const { root, write } = workspace(t)
  write("src/removed.d.ts", "export declare const value: string")
  write("dist/removed.js", "stale executable")
  write("dist/removed.js.map", "stale map")
  assert.deepEqual(pruneBuildOutput("backend", root), ["removed.js", "removed.js.map"])
})

test("invalid workspace identity and missing source fail before deleting outputs", (t) => {
  const { root, backend, write } = workspace(t)
  const stale = write("dist/old.js")
  fs.writeFileSync(path.join(backend, "package.json"), JSON.stringify({ name: "other" }))
  assert.throws(() => pruneBuildOutput("backend", root), /backend workspace manifest/)
  assert.ok(fs.existsSync(stale))
  fs.writeFileSync(path.join(backend, "package.json"), JSON.stringify({ name: "@betterc0de/backend" }))
  fs.rmdirSync(path.join(backend, "src"))
  assert.throws(() => pruneBuildOutput("backend", root), /directory is missing/)
  assert.ok(fs.existsSync(stale))
})

for (const location of ["src", "dist", "dist/nested"]) {
  test(`rejects symlink/junction ${location} without touching its outside target`, (t) => {
    const { root, backend, write } = workspace(t)
    const outside = path.join(root, "outside")
    fs.mkdirSync(outside)
    const sentinel = path.join(outside, "old.js")
    fs.writeFileSync(sentinel, "outside sentinel")
    const stale = write("dist/aaa.js", "workspace stale output")
    const link = path.join(backend, location)
    if (location === "src") fs.rmdirSync(link)
    if (location === "dist") {
      fs.unlinkSync(stale)
      fs.rmdirSync(link)
    }
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
    assert.throws(() => pruneBuildOutput("backend", root), /symlinked build path/)
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside sentinel")
    if (location !== "dist") assert.equal(fs.readFileSync(stale, "utf8"), "workspace stale output")
  })
}

test("a workspace reached through a symlinked ancestor is pruned; a symlinked workspace is refused", (t) => {
  const { root: base } = workspace(t)
  const real = path.join(base, "real")
  const repo = path.join(real, "repo")
  const backend = path.join(repo, "apps", "backend")
  fs.mkdirSync(path.join(backend, "src"), { recursive: true })
  fs.mkdirSync(path.join(backend, "dist"), { recursive: true })
  fs.writeFileSync(path.join(backend, "package.json"), JSON.stringify({ name: "@betterc0de/backend" }))
  fs.writeFileSync(path.join(backend, "dist", "stale.js"), "stale")
  const linkType = process.platform === "win32" ? "junction" : "dir"

  // Like a checkout under macOS /tmp or a symlinked home directory.
  const linkedParent = path.join(base, "linked-parent")
  fs.symlinkSync(real, linkedParent, linkType)
  assert.deepEqual(pruneBuildOutput("backend", path.join(linkedParent, "repo")), ["stale.js"])
  assert.equal(fs.existsSync(path.join(backend, "dist", "stale.js")), false)

  // The workspace directory itself must still be a real directory.
  fs.writeFileSync(path.join(backend, "dist", "stale.js"), "stale")
  const linkedRoot = path.join(base, "linked-root")
  fs.symlinkSync(repo, linkedRoot, linkType)
  assert.throws(() => pruneBuildOutput("backend", linkedRoot), /must be a real directory/)
  assert.equal(fs.readFileSync(path.join(backend, "dist", "stale.js"), "utf8"), "stale")
})

test("schema target removes only its orphan JS/maps and preserves current schema outputs", (t) => {
  const { root, write } = workspace(t, "schema")
  write("src/index.ts", "export const current = true")
  const valid = write("dist/index.js", "current schema")
  const map = write("dist/index.js.map", "current map")
  const unrelated = write("dist/schema.json", "unrelated")
  write("dist/system-skills.js", "obsolete schema")
  write("dist/system-skills.js.map", "obsolete map")
  const backendOutput = path.join(root, "apps/backend/dist/obsolete.js")
  fs.mkdirSync(path.dirname(backendOutput), { recursive: true })
  fs.writeFileSync(backendOutput, "other target")
  assert.deepEqual(pruneBuildOutput("schema", root), ["system-skills.js", "system-skills.js.map"])
  for (const file of [valid, map, unrelated, backendOutput]) assert.ok(fs.existsSync(file), file)
})

test("only the two fixed workspace targets are accepted", () => {
  for (const target of ["../backend", "apps/backend", "toString", "constructor", "__proto__", "ui", undefined]) {
    assert.throws(() => pruneBuildOutput(target), /target must be backend or schema/)
  }
})
