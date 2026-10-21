import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

// The ChatGPT OAuth flow stored access and refresh tokens that nothing ever
// read, refreshed or revoked. It was removed; these checks keep it removed.

const require = createRequire(import.meta.url)
const providerUrl = new URL("../apps/shell/provider-ipc.cjs", import.meta.url)
const providerSource = readFileSync(providerUrl, "utf8")

function registerHandlers() {
  const handlers = new Map()
  const module = { exports: {} }
  runInNewContext(providerSource, {
    module,
    console: { log() {} },
    process: { platform: process.platform },
    require: (name) => {
      if (name === "./shared/ipc-contract.cjs") return require("../apps/shell/shared/ipc-contract.cjs")
      if (name === "./shared/ipc-handlers-factory.cjs") {
        return {
          safeHandle: (channel, handler) => handlers.set(channel, handler),
          rawHandle: (channel, handler) => handlers.set(channel, handler),
        }
      }
      throw new Error(`Unexpected dependency ${name}`)
    },
  })
  module.exports.registerProviderHandlers()
  return { handlers, exports: module.exports }
}

test("the OAuth flow and its client are gone from the shell", () => {
  assert.equal(existsSync(new URL("../apps/shell/oauth", import.meta.url)), false)
  assert.doesNotMatch(providerSource, /oauth\/|OAUTH_HANDLERS|openExternal|\/credential/)
})

test("no provider sign-in channel exists; the remaining provider handlers are inert", async () => {
  const { handlers } = registerHandlers()
  assert.equal(handlers.has("provider:oauth-start"), false)
  // The handlers run in a vm context, so their objects have its prototypes.
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(await handlers.get("provider:auth-status")()), {})
  assert.deepEqual(plain(await handlers.get("provider:auth-clear")({}, { providerId: "openai" })), { ok: true })
  await assert.rejects(handlers.get("provider:auth-clear")({}, {}), /providerId is required/)
})

test("the provider catalog offers no OAuth sign-in method", () => {
  const { exports } = registerHandlers()
  for (const provider of exports.PROVIDER_CATALOG) {
    for (const method of provider.authMethods) {
      assert.notEqual(method.type, "oauth", `${provider.id} still offers OAuth`)
    }
  }
})
