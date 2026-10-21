import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import vm from "node:vm"
import { installFakeDesktopConfigBackend } from "./fake-desktop-config-backend.mjs"

const modulePath = new URL("../apps/shell/skills-ipc.cjs", import.meta.url)
const require = createRequire(modulePath)
const source = fs.readFileSync(modulePath, "utf8")

function importHarness(t, respond) {
  // BetterC0de's skills belong to the backend; a fake backend keeps them in
  // `home` (skills/<id>/manifest.json + content.md) like the real one.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-skill-import-"))
  const backend = installFakeDesktopConfigBackend(home)
  t.after(() => {
    backend.restore()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const handlers = new Map()
  const response = new PassThrough()
  response.statusCode = 200
  response.headers = { "content-type": "text/markdown; charset=utf-8" }
  response.on("error", () => {})
  t.after(() => response.destroy())
  let request
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, Buffer, URL, process, setTimeout, clearTimeout,
    console: { log() {} },
    require(id) {
      if (id === "./shared/ipc-handlers-factory.cjs") return {
        safeHandle: (channel, handler) => handlers.set(channel, handler),
        rawHandle() {},
      }
      if (id === "./shared/runtime-paths.cjs") return {
        ensureDir: (directory) => fs.mkdirSync(directory, { recursive: true }),
        slugify: () => "imported-skill",
      }
      if (id === "./shared/security-checks.cjs") return {
        resolvePublicHostPinned: async () => ({ address: "8.8.8.8", family: 4 }),
      }
      if (id === "./shared/appConfig.cjs") return {
        SKILL_IMPORT_MAX_BYTES: 1024,
        SKILL_IMPORT_REQUEST_TIMEOUT_MS: 30,
      }
      if (id === "./skills-sh.cjs") return {}
      if (id === "https") return {
        request(_options, onResponse) {
          request = new EventEmitter()
          request.destroyed = false
          request.destroy = (error) => {
            request.destroyed = true
            if (error) request.emit("error", error)
          }
          request.end = () => {
            onResponse(response)
            respond(response)
          }
          return request
        },
      }
      return require(id)
    },
  }, { filename: modulePath.pathname })
  module.exports.registerSkillsHandlers()
  return {
    run: () => handlers.get("skill:import-url")({}, { url: "https://skills.example/skill.md" }),
    content: () => fs.readFileSync(path.join(home, "skills", "imported-skill", "content.md"), "utf8"),
    manifest: () =>
      JSON.parse(fs.readFileSync(path.join(home, "skills", "imported-skill", "manifest.json"), "utf8")),
    backend,
    response,
    request: () => request,
  }
}

test("skill import preserves UTF-8 characters split across network chunks", async (t) => {
  const text = "# Grüße 🦊\n"
  const harness = importHarness(t, (response) => {
    for (const byte of Buffer.from(text)) response.write(Buffer.from([byte]))
    response.end()
  })
  await harness.run()
  assert.equal(harness.content(), text)
  assert.equal(harness.manifest().source, "url-import")
  assert.equal(harness.manifest().sourceUrl, "https://skills.example/skill.md")
  // Stored through the backend, never written by this process.
  assert.ok(
    harness.backend.requests.some(
      (request) => request.method === "PUT" && request.path === "/config/skills/imported-skill",
    ),
  )
})

test("skill import stops a trickling response at the total request deadline", { timeout: 1000 }, async (t) => {
  let interval
  t.after(() => clearInterval(interval))
  const harness = importHarness(t, (response) => {
    interval = setInterval(() => response.write("."), 5)
  })
  await assert.rejects(harness.run(), /timed out/)
  assert.equal(harness.request().destroyed, true)
  assert.equal(harness.response.destroyed, true)
})

test("skill import closes a rejected response instead of draining its body", async (t) => {
  const harness = importHarness(t, () => {})
  harness.response.statusCode = 302
  await assert.rejects(harness.run(), /redirect/)
  assert.equal(harness.response.destroyed, true)
  assert.equal(harness.request().destroyed, true)
})

test("skill import destroys an oversized response without persisting it", async (t) => {
  const harness = importHarness(t, (response) => response.end(Buffer.alloc(1025)))
  await assert.rejects(harness.run(), /byte-limit|byte limit/)
  assert.equal(harness.response.destroyed, true)
  assert.equal(harness.request().destroyed, true)
  assert.throws(harness.content, { code: "ENOENT" })
  assert.equal(harness.backend.requests.some((request) => request.method === "PUT"), false)
})
