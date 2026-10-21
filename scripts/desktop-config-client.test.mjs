// The main process's client for the backend-owned desktop configuration
// (apps/shell/shared/desktop-config-client.cjs): how it reaches the backend,
// how it reports refusals, and the revision-checked read-modify-write every
// *-ipc.cjs store relies on.

import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { installFakeDesktopConfigBackend } from "./fake-desktop-config-backend.mjs"

const require = createRequire(import.meta.url)
const client = require("../apps/shell/shared/desktop-config-client.cjs")
const { setBackendConnection } = require("../apps/shell/shared/backend-endpoint.cjs")

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-desktop-config-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function fakeBackend(t) {
  const home = tempHome(t)
  const backend = installFakeDesktopConfigBackend(home)
  t.after(() => backend.restore())
  return { home, backend, file: (name) => path.join(home, name) }
}

/** A transport answering from `respond(request, index)`; records requests. */
function scriptedTransport(t, respond) {
  const requests = []
  client.setDesktopConfigTransport(async (request) => {
    requests.push(request)
    return respond(request, requests.length - 1)
  })
  t.after(() => client.setDesktopConfigTransport())
  return requests
}

const ok = (body) => ({ status: 200, body })

test("requests reach the live backend with the bearer and the main-process capability header", async (t) => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ content: "rules", revision: "absent" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  let connection = { port: 4567, token: "t".repeat(40) }
  setBackendConnection(() => connection)
  t.after(() => {
    globalThis.fetch = originalFetch
    setBackendConnection(() => null)
  })
  client.setDesktopConfigTransport()

  assert.equal(await client.readRules(), "rules")
  assert.equal(calls[0].url, "http://127.0.0.1:4567/api/v1/config/rules")
  assert.equal(calls[0].init.method, "GET")
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${"t".repeat(40)}`)
  assert.equal(calls[0].init.headers[client.DESKTOP_SHELL_CAPABILITY_HEADER], "t".repeat(40))
  assert.equal(client.DESKTOP_SHELL_CAPABILITY_HEADER, "X-BetterC0de-Desktop-Shell")
  assert.equal(calls[0].init.redirect, "error")
  assert.equal(calls[0].init.body, undefined)
  assert.equal("Content-Type" in calls[0].init.headers, false)

  // The connection is read per request: a restarted backend's new port and
  // token are used at once.
  connection = { port: 5678, token: "u".repeat(40) }
  await client.writeRules("new rules")
  assert.equal(calls[1].url, "http://127.0.0.1:5678/api/v1/config/rules")
  assert.equal(calls[1].init.method, "PUT")
  assert.equal(calls[1].init.headers[client.DESKTOP_SHELL_CAPABILITY_HEADER], "u".repeat(40))
  assert.equal(calls[1].init.headers["Content-Type"], "application/json")
  assert.deepEqual(JSON.parse(calls[1].init.body), { content: "new rules" })
})

test("without a running backend nothing is sent and the error says why", async (t) => {
  const originalFetch = globalThis.fetch
  let fetched = false
  globalThis.fetch = async () => {
    fetched = true
    throw new Error("must not be called")
  }
  setBackendConnection(() => null)
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  client.setDesktopConfigTransport()
  await assert.rejects(client.readDocument("hooks"), (error) => {
    assert.match(error.message, /backend is not running/)
    assert.equal(error.code, "backend_unavailable")
    return true
  })
  assert.equal(fetched, false)
})

test("a refusal surfaces with the backend's message, status and code", async (t) => {
  scriptedTransport(t, (_request, index) =>
    index === 0
      ? { status: 403, body: { error: "The desktop configuration is managed by the BetterC0de desktop app.", code: "desktop_only" } }
      : { status: 500, body: null },
  )
  await assert.rejects(client.readRules(), (error) => {
    assert.ok(error instanceof client.DesktopConfigError)
    assert.equal(error.status, 403)
    assert.equal(error.code, "desktop_only")
    assert.match(error.message, /managed by the BetterC0de desktop app/)
    return true
  })
  await assert.rejects(client.readRules(), /HTTP 500/)
})

test("an invalid document from the backend is refused", async (t) => {
  scriptedTransport(t, () => ok({ entries: "not a list", revision: "absent" }))
  await assert.rejects(client.readDocument("mcp"), /invalid configuration document/)
})

test("a write conflict re-runs the change on the entries stored by then", async (t) => {
  const { backend, file } = fakeBackend(t)
  fs.writeFileSync(file("hooks.json"), JSON.stringify([{ id: "first", event: "on_commit", command: "" }]))
  // Another writer adds a hook between this change's read and its write.
  backend.beforeNextWrite("hooks", () => {
    const current = JSON.parse(fs.readFileSync(file("hooks.json"), "utf8"))
    fs.writeFileSync(file("hooks.json"), JSON.stringify([...current, { id: "other", event: "on_commit", command: "" }]))
  })
  const seen = []
  const result = await client.mutateDocument("hooks", (entries) => {
    seen.push(entries.map((entry) => entry.id))
    return { entries: [...entries, { id: "mine", event: "on_commit", command: "" }], result: "done" }
  })
  assert.equal(result, "done")
  assert.deepEqual(seen, [["first"], ["first", "other"]])
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file("hooks.json"), "utf8")).map((entry) => entry.id),
    ["first", "other", "mine"],
  )
  const writes = backend.requests.filter((request) => request.method === "PUT")
  assert.equal(writes.length, 2)
  for (const write of writes) assert.equal(typeof write.body.expectedRevision, "string")
})

test("a busy file is retried; a refused write is not", async (t) => {
  const document = { entries: [], revision: "absent" }
  const requests = scriptedTransport(t, (request) => {
    if (request.method === "GET") return ok(document)
    const puts = requests.filter((entry) => entry.method === "PUT").length
    return puts === 1
      ? { status: 409, body: { error: "hooks.json is being written by another process; retry shortly.", code: "desktop_config_busy" } }
      : ok({ entries: request.body.entries, revision: "sha256:next" })
  })
  await client.mutateDocument("hooks", () => ({ entries: [{ id: "a" }] }))
  assert.equal(requests.filter((request) => request.method === "PUT").length, 2)

  let runs = 0
  const refusing = scriptedTransport(t, (request) =>
    request.method === "GET"
      ? ok(document)
      : { status: 409, body: { error: "hooks.json cannot be used: it is not a list of entries.", code: "desktop_config_unsafe" } },
  )
  await assert.rejects(
    client.mutateDocument("hooks", () => {
      runs += 1
      return { entries: [{ id: "a" }] }
    }),
    (error) => {
      assert.equal(error.code, "desktop_config_unsafe")
      assert.match(error.message, /not a list of entries/)
      return true
    },
  )
  assert.equal(runs, 1)
  assert.equal(refusing.filter((request) => request.method === "PUT").length, 1)
})

test("a document that keeps changing gives up with a clear error", async (t) => {
  const requests = scriptedTransport(t, (request) =>
    request.method === "GET"
      ? ok({ entries: [], revision: "absent" })
      : { status: 409, body: { error: "changed", code: "desktop_config_conflict" } },
  )
  await assert.rejects(
    client.mutateDocument("mcp", () => ({ entries: [] })),
    (error) => {
      assert.match(error.message, /kept changing/)
      assert.equal(error.code, "desktop_config_conflict")
      return true
    },
  )
  assert.equal(requests.filter((request) => request.method === "PUT").length, 6)
})

test("a mutation that returns nothing writes nothing", async (t) => {
  const requests = scriptedTransport(t, () => ok({ entries: [{ id: "a" }], revision: "sha256:x" }))
  assert.equal(await client.mutateDocument("mcp", () => null), undefined)
  assert.deepEqual(requests.map((request) => request.method), ["GET"])
})

test("a document store upserts, patches and removes with the old adapter's semantics", async (t) => {
  const { backend, file } = fakeBackend(t)
  const store = client.createDocumentStore("hooks")

  const created = await store.save({ name: "alpha" })
  assert.ok(created.id)
  assert.ok(created.createdAt && created.updatedAt)
  assert.equal((await store.list()).length, 1)

  const fixed = await store.save({ id: "fixed", name: "first" })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const again = await store.save({ id: "fixed", name: "second" })
  assert.equal(again.createdAt, fixed.createdAt)
  assert.notEqual(again.updatedAt, fixed.createdAt)
  assert.equal((await store.get("fixed")).name, "second")
  assert.equal(await store.get("missing"), null)

  const patched = await store.update("fixed", (entry) => ({ ...entry, flag: true, id: "renamed" }))
  assert.equal(patched.id, "fixed", "update keeps the id")
  assert.equal(patched.flag, true)
  assert.ok(patched.updatedAt)
  assert.equal(await store.update("missing", (entry) => entry), null)

  assert.equal(await store.remove("missing"), false)
  assert.equal(await store.remove(created.id), true)
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["fixed"])

  await store.replaceAll([{ id: "b" }, { id: "c" }])
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file("hooks.json"), "utf8")).map((entry) => entry.id),
    ["b", "c"],
  )
  // A whole-list replacement names no revision; every mutation does.
  const writes = backend.requests.filter((request) => request.method === "PUT")
  assert.equal("expectedRevision" in writes.at(-1).body, false)
  assert.ok(writes.slice(0, -1).every((request) => typeof request.body.expectedRevision === "string"))
})

test("a document store builds entries with buildEntry and maps every list through its codecs", async (t) => {
  const { file } = fakeBackend(t)
  const store = client.createDocumentStore("mcp", {
    buildEntry: (input, existing, { now, id }) => ({
      id,
      derived: `value:${input.input}`,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      secret: input.secret,
    }),
    toStored: (entries) => entries.map((entry) => ({ ...entry, secret: `sealed:${entry.secret}` })),
    fromStored: (entries) =>
      entries.map((entry) => ({ ...entry, secret: String(entry.secret).replace(/^sealed:/, "") })),
  })
  const entry = await store.save({ id: "k", input: "raw", secret: "s1" })
  assert.deepEqual([entry.derived, entry.secret], ["value:raw", "s1"])
  await store.save({ id: "other", input: "x", secret: "s2" })
  const onDisk = () => JSON.parse(fs.readFileSync(file("mcp-servers.json"), "utf8"))
  assert.deepEqual(onDisk().map((stored) => stored.secret), ["sealed:s1", "sealed:s2"])
  assert.deepEqual((await store.list()).map((stored) => stored.secret), ["s1", "s2"])
  // Removal writes the other entries back exactly as stored (not re-sealed).
  await store.remove("k")
  assert.deepEqual(onDisk().map((stored) => stored.secret), ["sealed:s2"])
})

test("a document store refuses too many or too large entries before sending anything", async (t) => {
  const { backend } = fakeBackend(t)
  const small = client.createDocumentStore("hooks", { maxItems: 1, maxBytes: 200 })
  await small.save({ id: "a" })
  const writes = () => backend.requests.filter((request) => request.method === "PUT").length
  const before = writes()
  await assert.rejects(small.save({ id: "b" }), /more than 1 entries/)
  await assert.rejects(small.replaceAll([{ id: "a" }, { id: "b" }]), /more than 1 entries/)
  await assert.rejects(small.save({ id: "a", padding: "x".repeat(500) }), /exceeds 200 bytes/)
  assert.equal(writes(), before)
})

test("an unreadable document lists empty, and a write keeps text that is not JSON aside", async (t) => {
  const { file, home } = fakeBackend(t)
  const store = client.createDocumentStore("hooks")
  fs.writeFileSync(file("hooks.json"), '[{"id":"existing","name":"unfinished')
  const document = await store.read()
  assert.deepEqual(document.entries, [])
  assert.match(document.problem, /not valid JSON/)
  assert.deepEqual(await store.list(), [])
  await store.save({ id: "new" })
  const backups = fs.readdirSync(home).filter((name) => name.startsWith("hooks.json.corrupt-"))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(home, backups[0]), "utf8"), '[{"id":"existing","name":"unfinished')

  // JSON whose entries cannot be told apart is never overwritten.
  const ambiguous = JSON.stringify([{ id: "a" }, { id: "a" }])
  fs.writeFileSync(file("hooks.json"), ambiguous)
  await assert.rejects(store.save({ id: "b" }), (error) => {
    assert.equal(error.code, "desktop_config_unsafe")
    return true
  })
  assert.equal(fs.readFileSync(file("hooks.json"), "utf8"), ambiguous)
})

test("skills and subagents are addressed by encoded id under their own route", async (t) => {
  const requests = scriptedTransport(t, (request) => {
    if (request.method === "GET" && request.path === "/config/skills") {
      return ok({ entries: [{ id: "a", manifest: { name: "A" }, text: "body" }] })
    }
    if (request.method === "GET") return ok({ entry: null })
    if (request.method === "PUT") return ok({ id: "a" })
    return ok({ removed: true })
  })
  assert.deepEqual(await client.listDirectory("skills"), [
    { id: "a", manifest: { name: "A" }, text: "body" },
  ])
  assert.equal(await client.getDirectoryEntry("subagents", "a b"), null)
  await client.putDirectoryEntry("skills", "a", { name: "A" }, "body")
  assert.equal(await client.removeDirectoryEntry("subagents", "a"), true)
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    [
      "GET /config/skills",
      "GET /config/subagents/a%20b",
      "PUT /config/skills/a",
      "DELETE /config/subagents/a",
    ],
  )
  assert.deepEqual(requests[2].body, { manifest: { name: "A" }, text: "body" })
  await assert.rejects(client.listDirectory("hooks"), /Unknown desktop configuration/)
})
