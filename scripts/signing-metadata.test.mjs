import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

const { buildSigningMetadataArgs } = createRequire(import.meta.url)("./pack-electron.cjs")

const signed = (env, platform) =>
  buildSigningMetadataArgs(env, platform)[0].endsWith("=true")

test("a build counts as code-signed only when a signing certificate was supplied", () => {
  assert.equal(signed({}, "win32"), false)
  assert.equal(signed({ WIN_CSC_LINK: "cert" }, "win32"), true)
  assert.equal(signed({ CSC_LINK: "cert" }, "darwin"), true)
  assert.equal(signed({ CSC_NAME: "Developer ID Application: Example" }, "darwin"), true)
  // Notarization credentials alone do not sign the app.
  assert.equal(signed({ APPLE_TEAM_ID: "TEAM123" }, "darwin"), false)
  // Linux packages have no code signature; the runtime picks the update mode
  // from the package type instead.
  assert.equal(signed({ CSC_LINK: "cert" }, "linux"), false)
})
