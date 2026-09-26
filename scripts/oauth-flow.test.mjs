import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const require = createRequire(import.meta.url)
const codexSource = readFileSync(new URL("../apps/shell/oauth/codex.cjs", import.meta.url), "utf8")
const providerSource = readFileSync(new URL("../apps/shell/provider-ipc.cjs", import.meta.url), "utf8")

async function tokenFlow(tokens) {
  let closed = 0
  const module = { exports: {} }
  runInNewContext(codexSource, {
    module, URLSearchParams, Buffer,
    require: (name) => name === "./index.cjs" ? {
      generatePkce: async () => ({ verifier: "verifier", challenge: "challenge" }),
      generateState: () => "state",
      startCallbackServer: async () => ({
        redirectUri: "http://127.0.0.1:1455/auth/callback", wait: async () => ({ code: "code" }),
        close: () => { closed++ },
      }),
    } : { fetchJson: async () => tokens },
  })
  const flow = await module.exports.start()
  return { flow, closed: () => closed }
}

test("OAuth token exchange rejects malformed credentials and always closes the callback", async () => {
  for (const tokens of [null, [], {}, { access_token: "a", refresh_token: "r", expires_in: "3600" }, { access_token: "a", refresh_token: "r", expires_in: -1 }]) {
    const result = await tokenFlow(tokens)
    await assert.rejects(result.flow.wait(), /invalid credential/)
    assert.equal(result.closed(), 1)
  }
  const result = await tokenFlow({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
  const credential = await result.flow.wait()
  assert.equal(credential.access, "access")
  assert.equal(credential.refresh, "refresh")
  assert.ok(credential.expires > Date.now())
  assert.equal(result.closed(), 1)
})

test("failed browser launch cancels OAuth and does not persist a credential", async () => {
  const handlers = new Map()
  let closed = 0, waited = false, requested = false
  const module = { exports: {} }
  runInNewContext(providerSource, {
    module, console: { log() {} }, process: { platform: process.platform },
    require: (name) => {
      if (name === "electron") return { shell: { openExternal: async () => { throw new Error("browser unavailable") } } }
      if (name === "./shared/ipc-contract.cjs") return require("../apps/shell/shared/ipc-contract.cjs")
      if (name === "./shared/ipc-handlers-factory.cjs") return { safeHandle: (channel, handler) => handlers.set(channel, handler), rawHandle() {} }
      if (name === "./shared/fetch-json.cjs") return { fetchJson: async () => { requested = true } }
      if (name === "./shared/backend-endpoint.cjs") return { getBackendConnection: () => null }
      if (name === "./shared/urlPolicy.cjs") return {
        isAllowedExternalUrl: (value) => {
          try { return new URL(value).protocol === "https:" } catch { return false }
        },
      }
      if (name === "./oauth/codex.cjs") return {
        id: "openai", start: async () => ({ url: "https://auth.openai.com/oauth/authorize", close: () => { closed++ }, wait: async () => { waited = true } }),
      }
      throw new Error(`Unexpected dependency ${name}`)
    },
  })
  module.exports.registerProviderHandlers()
  await assert.rejects(handlers.get("provider:oauth-start")({}, { providerId: "openai", handler: "constructor" }), /Unknown OAuth handler/)
  await assert.rejects(handlers.get("provider:oauth-start")({}, { providerId: "openai", handler: "codex-oauth" }), /browser unavailable/)
  assert.equal(closed, 1)
  assert.equal(waited, false)
  assert.equal(requested, false)
})

test("OAuth refuses a non-HTTPS authorize URL and posts the credential only when the backend is connected", async () => {
  const handlers = new Map()
  const posts = []
  let closed = 0
  const module = { exports: {} }
  runInNewContext(providerSource, {
    module, console: { log() {} }, process: { platform: process.platform },
    require: (name) => {
      if (name === "electron") return { shell: { openExternal: async () => {} } }
      if (name === "./shared/ipc-contract.cjs") return require("../apps/shell/shared/ipc-contract.cjs")
      if (name === "./shared/ipc-handlers-factory.cjs") return {
        safeHandle: (channel, handler) => handlers.set(channel, handler),
        rawHandle() {},
      }
      if (name === "./shared/fetch-json.cjs") return {
        fetchJson: async (url, init) => {
          posts.push({ url, body: init?.body })
          return { ok: true }
        },
      }
      if (name === "./shared/backend-endpoint.cjs") return {
        getBackendConnection: () => posts.length === 0 && closed === 0
          ? null
          : { port: 4317, token: "backend-token" },
      }
      if (name === "./shared/urlPolicy.cjs") return {
        isAllowedExternalUrl: (value) => {
          try { return new URL(value).protocol === "https:" } catch { return false }
        },
      }
      if (name === "./oauth/codex.cjs") return {
        id: "openai",
        start: async () => ({
          url: closed === 0 ? "http://auth.openai.com/oauth/authorize" : "https://auth.openai.com/oauth/authorize",
          close: () => { closed++ },
          wait: async () => ({ type: "oauth", access: "access-token", refresh: "refresh-token", expires: 1 }),
        }),
      }
      throw new Error(`Unexpected dependency ${name}`)
    },
  })
  module.exports.registerProviderHandlers()
  const start = handlers.get("provider:oauth-start")
  await assert.rejects(start({}, { providerId: "openai", handler: "codex-oauth" }), /non-HTTPS/)
  assert.equal(closed, 1)
  assert.equal(posts.length, 0)
  const result = await start({}, { providerId: "openai", handler: "codex-oauth" })
  assert.equal(result.ok, true)
  assert.equal(posts.length, 1)
  assert.match(posts[0].url, /^http:\/\/127\.0\.0\.1:4317\/api\/v1\/providers\/openai\/credential$/)
  assert.match(posts[0].body, /access-token/)
})
