// App-level IPC (shared/app-ipc.cjs), extracted from main.cjs: the path and
// window-cwd validation behind `open-path` and `window:open-with`, and the
// backend release of a renderer's terminals.
import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  DANGEROUS_OPEN_EXT,
  releaseRendererShellResources,
  resolveOpenPathTarget,
  resolveSecondaryWindowCwd,
} = require("../apps/shell/shared/app-ipc.cjs")
const { setBackendConnection } = require("../apps/shell/shared/backend-endpoint.cjs")

function homeFixture(t) {
  // `.native`, like the code under test: it also expands Windows 8.3 names
  // (CI temp directories are often under C:\Users\RUNNER~1).
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-app-ipc-")))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, "project"))
  fs.writeFileSync(path.join(home, "project", "notes.md"), "# notes")
  fs.writeFileSync(path.join(home, "project", "run.cmd"), "echo hi")
  fs.writeFileSync(path.join(home, "project", "tool.SH"), "echo hi")
  return home
}

test("open-path resolves existing files and folders, including ~ paths", (t) => {
  const home = homeFixture(t)
  const getHome = () => home
  assert.deepEqual(resolveOpenPathTarget(path.join(home, "project"), { getHome }), {
    canonical: path.join(home, "project"),
    isDirectory: true,
  })
  assert.deepEqual(resolveOpenPathTarget("~/project/notes.md", { getHome }), {
    canonical: path.join(home, "project", "notes.md"),
    isDirectory: false,
  })
  assert.deepEqual(resolveOpenPathTarget("~", { getHome }), { canonical: home, isDirectory: true })
})

test("open-path refuses invalid input, missing paths and executable file types", (t) => {
  const home = homeFixture(t)
  const getHome = () => home
  for (const invalid of [undefined, 42, "", "x".repeat(2049), "a\u0000b"]) {
    assert.throws(() => resolveOpenPathTarget(invalid, { getHome }), /Invalid path/)
  }
  assert.throws(() => resolveOpenPathTarget(path.join(home, "missing"), { getHome }), /does not exist/)
  assert.throws(() => resolveOpenPathTarget(path.join(home, "project", "run.cmd"), { getHome }), /Refusing to open executable path: \.cmd/)
  assert.throws(() => resolveOpenPathTarget(path.join(home, "project", "tool.SH"), { getHome }), /executable path: \.sh/)
  for (const ext of [".exe", ".ps1", ".app", ".jar", ".lnk"]) assert.ok(DANGEROUS_OPEN_EXT.has(ext), ext)
})

test("a secondary window opens only on an existing folder inside the home directory", (t) => {
  const home = homeFixture(t)
  const getHome = () => home
  assert.equal(resolveSecondaryWindowCwd(path.join(home, "project"), { getHome }), path.join(home, "project"))
  assert.equal(resolveSecondaryWindowCwd(home, { getHome }), home)
  assert.equal(resolveSecondaryWindowCwd(path.join(home, "project", "notes.md"), { getHome }), undefined)
  assert.equal(resolveSecondaryWindowCwd(path.join(home, "missing"), { getHome }), undefined)
  assert.equal(resolveSecondaryWindowCwd(path.dirname(home), { getHome }), undefined, "outside home")
  assert.equal(resolveSecondaryWindowCwd("", { getHome }), undefined)
  assert.equal(resolveSecondaryWindowCwd("x".repeat(2049), { getHome }), undefined)
  assert.equal(resolveSecondaryWindowCwd("a\u0000b", { getHome }), undefined)
})

test("a renderer's terminals are released through the backend only while it runs", async (t) => {
  t.after(() => setBackendConnection(() => null))
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ terminals: 2, runs: 1 }) }
  }
  const logs = []
  const log = { log: (...args) => logs.push(args.join(" ")) }

  setBackendConnection(() => null)
  await releaseRendererShellResources("client-1", "reload", { isQuitting: () => false, fetchImpl, log })
  assert.equal(requests.length, 0, "no backend, nothing to release")

  setBackendConnection(() => ({ port: 3773, token: "t".repeat(32) }))
  await releaseRendererShellResources("client-1", "quit", { isQuitting: () => true, fetchImpl, log })
  assert.equal(requests.length, 0, "the backend stops with the app anyway")

  await releaseRendererShellResources("client-1", "reload", { isQuitting: () => false, fetchImpl, log })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "http://127.0.0.1:3773/api/v1/shell/client/release")
  assert.equal(requests[0].init.method, "POST")
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${"t".repeat(32)}`)
  assert.deepEqual(JSON.parse(requests[0].init.body), { clientInstanceId: "client-1" })
  assert.match(logs[0], /Ended 2 terminal\(s\) and 1 shell run\(s\) of a renderer \(reload\)/)

  const failing = async () => ({ ok: false, status: 503, json: async () => null })
  await assert.rejects(
    releaseRendererShellResources("client-1", "reload", { isQuitting: () => false, fetchImpl: failing, log }),
    /release request failed \(503\)/,
  )
})
