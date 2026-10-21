import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  createBackendDevReloader,
  isBackendBuildFile,
} = require("../apps/shell/backend-dev-reloader.cjs")

test("backend development reloads only for emitted JavaScript", () => {
  assert.equal(isBackendBuildFile("http/routes/workspace.js"), true)
  assert.equal(isBackendBuildFile("index.cjs"), true)
  assert.equal(isBackendBuildFile("index.js.map"), false)
  assert.equal(isBackendBuildFile("workspace.d.ts"), false)
  assert.equal(isBackendBuildFile(null), false)
})

test("backend development reload coalesces a TypeScript build burst", async () => {
  const watcher = new EventEmitter()
  watcher.close = () => {}
  let onWatch
  let reloads = 0
  let digestValue = "a"

  const reloader = createBackendDevReloader({
    directory: "dist",
    debounceMs: 5,
    digest: () => digestValue,
    watch: (_directory, _options, callback) => {
      onWatch = callback
      return watcher
    },
    onReload: async () => {
      reloads += 1
    },
  })

  digestValue = "b"
  onWatch("change", "index.js")
  onWatch("change", "http/router.js")
  onWatch("change", "http/router.js.map")
  await new Promise((resolve) => setTimeout(resolve, 25))

  assert.equal(reloads, 1)
  reloader.close()
})

// Regression: `npm run dev` runs `build:backend` and THEN `tsc --watch`, whose
// initial pass rewrites dist/ with byte-identical output seconds after Electron
// already booted the backend from it. Restarting on that rewrite made every
// cold start drop its connections — ERR_CONNECTION_REFUSED in the renderer,
// pollers retrying, requests stuck in the shutdown drain.
test("backend development reload skips a rebuild with identical output", async () => {
  const watcher = new EventEmitter()
  watcher.close = () => {}
  let onWatch
  let reloads = 0
  let skips = 0

  const reloader = createBackendDevReloader({
    directory: "dist",
    debounceMs: 5,
    digest: () => "unchanged",
    onSkip: () => {
      skips += 1
    },
    watch: (_directory, _options, callback) => {
      onWatch = callback
      return watcher
    },
    onReload: async () => {
      reloads += 1
    },
  })

  onWatch("change", "index.js")
  onWatch("change", "http/router.js")
  await new Promise((resolve) => setTimeout(resolve, 25))

  assert.equal(reloads, 0)
  assert.equal(skips, 1)
  reloader.close()
})

test("backend development reload still fires when output actually changes", async () => {
  const watcher = new EventEmitter()
  watcher.close = () => {}
  let onWatch
  let reloads = 0
  const digests = ["baseline", "changed-once", "changed-twice"]
  let index = 0

  const reloader = createBackendDevReloader({
    directory: "dist",
    debounceMs: 5,
    digest: () => digests[Math.min(index, digests.length - 1)],
    watch: (_directory, _options, callback) => {
      onWatch = callback
      return watcher
    },
    onReload: async () => {
      reloads += 1
    },
  })

  index = 1
  onWatch("change", "index.js")
  await new Promise((resolve) => setTimeout(resolve, 25))
  index = 2
  onWatch("change", "index.js")
  await new Promise((resolve) => setTimeout(resolve, 25))

  assert.equal(reloads, 2)
  reloader.close()
})

// Regression: the backend requires @betterc0de/schema from packages/schema/dist.
// Watching only apps/backend/dist kept a stale schema loaded, so a new
// settings field (chat_folders) was rejected as unknown until a full restart.
test("backend development reload also fires for a watched package build", async () => {
  const watched = new Map()
  const digests = { "backend/dist": "backend", "schema/dist": "schema-v1" }
  let reloads = 0

  const reloader = createBackendDevReloader({
    directories: ["backend/dist", "schema/dist"],
    debounceMs: 5,
    digest: (dir) => digests[dir],
    watch: (directory, _options, callback) => {
      const watcher = new EventEmitter()
      watcher.close = () => watched.delete(directory)
      watched.set(directory, callback)
      return watcher
    },
    onReload: async () => {
      reloads += 1
    },
  })

  assert.deepEqual([...watched.keys()], ["backend/dist", "schema/dist"])
  digests["schema/dist"] = "schema-v2"
  watched.get("schema/dist")("change", "settings.js")
  await new Promise((resolve) => setTimeout(resolve, 25))

  assert.equal(reloads, 1)
  reloader.close()
  assert.equal(watched.size, 0)
})

test("computeBuildDigest tracks content, not write timestamps", () => {
  const { computeBuildDigest } = require("../apps/shell/backend-dev-reloader.cjs")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-digest-"))
  try {
    fs.mkdirSync(path.join(root, "http"), { recursive: true })
    fs.writeFileSync(path.join(root, "index.js"), "export const a = 1\n")
    fs.writeFileSync(path.join(root, "http", "router.js"), "export const b = 2\n")
    const first = computeBuildDigest(root)

    // Rewrite byte-identical output, as `tsc --watch`'s initial pass does.
    fs.writeFileSync(path.join(root, "index.js"), "export const a = 1\n")
    assert.equal(computeBuildDigest(root), first)

    fs.writeFileSync(path.join(root, "index.js"), "export const a = 99\n")
    assert.notEqual(computeBuildDigest(root), first)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("the root development command compiles continuously and enables reload", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
  )
  const devSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../apps/shell/dev.cjs"),
    "utf8",
  )

  assert.match(packageJson.scripts.dev, /npm:backend:dev/)
  assert.match(devSource, /BETTERC0DE_BACKEND_WATCH/)
})
