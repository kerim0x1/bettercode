import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { createHtmlPreviewRegistry, parseByteRange } = require("../apps/shell/html-preview.cjs")

test("HTML grants serve project assets, preserve relative URLs, and revoke with their owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "betterc0de-html-"))
  try {
    await mkdir(path.join(root, "pages"))
    await writeFile(path.join(root, "pages", "hello world.html"), '<link rel="stylesheet" href="../style.css"><h1>Local page</h1>')
    await writeFile(path.join(root, "style.css"), "h1 { color: red }")
    const registry = createHtmlPreviewRegistry()
    const grant = await registry.open(1, root, "pages/hello world.html")
    assert.equal(grant.status, "ready")
    assert.equal(grant.relativePath, "pages/hello world.html")
    assert.match(grant.url, /hello%20world.html$/)
    const page = await registry.handle(new Request(grant.url))
    assert.equal(page.status, 200)
    assert.equal(page.headers.get("content-type"), "text/html")
    assert.match(await page.text(), /Local page/)
    const css = await registry.handle(new Request(new URL("../style.css", grant.url)))
    assert.equal(css.status, 200)
    assert.match(await css.text(), /color: red/)
    await writeFile(path.join(root, "style.css"), "h1 { color: blue }")
    assert.match(await (await registry.handle(new Request(new URL("/style.css", grant.url)))).text(), /blue/)
    assert.equal((await registry.handle(new Request(grant.url, { method: "POST" }))).status, 405)
    registry.revokeOwner(2)
    assert.equal((await registry.handle(new Request(grant.url))).status, 200)
    registry.revokeOwner(1)
    assert.equal((await registry.handle(new Request(grant.url))).status, 404)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("HTML previews reject non-HTML entries, hidden files, traversal and symlink escapes", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "betterc0de-html-boundary-"))
  const root = path.join(parent, "project")
  try {
    await mkdir(root)
    await mkdir(path.join(root, ".git"))
    await writeFile(path.join(root, "index.html"), "ok")
    await writeFile(path.join(root, "script.js"), "ok")
    await writeFile(path.join(root, ".git", "secret.json"), "secret")
    await writeFile(path.join(parent, "private.html"), "private")
    const registry = createHtmlPreviewRegistry()
    const grant = await registry.open(1, root, "index.html")
    await assert.rejects(registry.open(1, root, "../private.html"))
    await assert.rejects(registry.open(1, root, "script.js"))
    for (const suffix of ["/.git/secret.json", "/%2e%2e%2fprivate.html", "/%5c..%5cprivate.html", "/index.html%00.js"]) {
      const response = await registry.handle(new Request(new URL(suffix, grant.url)))
      assert.notEqual(response.status, 200, suffix)
    }
    // Directory junctions work on Windows without Developer Mode or elevation.
    await symlink(parent, path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(registry.open(1, root, "outside/private.html"))
    assert.equal((await registry.handle(new Request(new URL("outside/private.html", grant.url)))).status, 403)
    await writeFile(path.join(root, "large.html"), "")
    await truncate(path.join(root, "large.html"), 32 * 1024 * 1024 + 1)
    await assert.rejects(registry.open(1, root, "large.html"))
    assert.equal((await registry.handle(new Request(new URL("large.html", grant.url)))).status, 413)
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test("HTML preview assets stream with byte ranges and HEAD sends no body", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "betterc0de-html-range-"))
  try {
    await writeFile(path.join(root, "index.html"), "<video src=clip.mp4></video>")
    await writeFile(path.join(root, "clip.mp4"), "0123456789")
    const registry = createHtmlPreviewRegistry()
    const grant = await registry.open(1, root, "index.html")
    const clip = new URL("clip.mp4", grant.url)

    const full = await registry.handle(new Request(clip))
    assert.equal(full.status, 200)
    assert.equal(full.headers.get("accept-ranges"), "bytes")
    assert.equal(full.headers.get("content-length"), "10")
    assert.equal(await full.text(), "0123456789")

    const middle = await registry.handle(new Request(clip, { headers: { Range: "bytes=2-5" } }))
    assert.equal(middle.status, 206)
    assert.equal(middle.headers.get("content-range"), "bytes 2-5/10")
    assert.equal(middle.headers.get("content-length"), "4")
    assert.equal(await middle.text(), "2345")

    const tail = await registry.handle(new Request(clip, { headers: { Range: "bytes=-3" } }))
    assert.equal(await tail.text(), "789")
    const open = await registry.handle(new Request(clip, { headers: { Range: "bytes=7-" } }))
    assert.equal(open.headers.get("content-range"), "bytes 7-9/10")

    const outside = await registry.handle(new Request(clip, { headers: { Range: "bytes=20-30" } }))
    assert.equal(outside.status, 416)
    assert.equal(outside.headers.get("content-range"), "bytes */10")

    const head = await registry.handle(new Request(clip, { method: "HEAD" }))
    assert.equal(head.status, 200)
    assert.equal(head.headers.get("content-length"), "10")
    assert.equal(head.body, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("byte range parsing accepts one range and ignores the rest", () => {
  assert.equal(parseByteRange(undefined, 10), null)
  assert.equal(parseByteRange("items=0-1", 10), null)
  assert.equal(parseByteRange("bytes=0-1,4-5", 10), null)
  assert.deepEqual(parseByteRange("bytes=0-99", 10), { start: 0, end: 9 })
  assert.deepEqual(parseByteRange("bytes=-20", 10), { start: 0, end: 9 })
  assert.equal(parseByteRange("bytes=5-2", 10), "unsatisfiable")
  assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable")
})
