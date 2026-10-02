import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  MACOS_SIGNING_ENV,
  assessMacSigning,
  describeMacSigning,
  writeApiKeyFile,
} from "./macos-signing.mjs"

const certificate = { CSC_LINK: "base64-p12", CSC_KEY_PASSWORD: "p12-password" }
const apiKey = {
  APPLE_API_KEY: "/tmp/AuthKey_ABC123DEFG.p8",
  APPLE_API_KEY_ID: "ABC123DEFG",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
}
const appleId = {
  APPLE_ID: "dev@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
  APPLE_TEAM_ID: "ABCDE12345",
}

test("no credentials build an unsigned app unless signing is required", () => {
  const state = assessMacSigning({})
  assert.deepEqual(state, {
    required: false,
    certificate: false,
    notarization: null,
    signed: false,
    problems: [],
  })
  assert.match(describeMacSigning(state), /unsigned/)

  const required = assessMacSigning({ BETTERC0DE_MACOS_SIGNING: "true" })
  assert.equal(required.signed, false)
  assert.equal(required.problems.length, 3)
  assert.match(required.problems.join("\n"), /CSC_LINK \+ CSC_KEY_PASSWORD/)
  assert.match(required.problems.join("\n"), /notarization credentials/)
  assert.match(required.problems.join("\n"), /APPLE_TEAM_ID/)
})

test("a certificate with an App Store Connect key signs and notarizes", () => {
  const state = assessMacSigning({
    ...certificate,
    ...apiKey,
    APPLE_TEAM_ID: "ABCDE12345",
    BETTERC0DE_MACOS_SIGNING: "true",
  })
  assert.deepEqual(state.problems, [])
  assert.equal(state.signed, true)
  assert.equal(state.notarization, "api-key")
  assert.match(describeMacSigning(state), /notarized with an App Store Connect API key/)
})

test("a base64 key counts as the key file", () => {
  const state = assessMacSigning({
    ...certificate,
    APPLE_API_KEY_BASE64: "LS0t",
    APPLE_API_KEY_ID: apiKey.APPLE_API_KEY_ID,
    APPLE_API_ISSUER: apiKey.APPLE_API_ISSUER,
  })
  assert.equal(state.notarization, "api-key")
  assert.deepEqual(state.problems, [])
})

test("an Apple ID login signs and notarizes", () => {
  const state = assessMacSigning({ ...certificate, ...appleId })
  assert.equal(state.signed, true)
  assert.equal(state.notarization, "apple-id")
})

test("empty strings from a workflow do not count as credentials", () => {
  const empty = Object.fromEntries(MACOS_SIGNING_ENV.map((name) => [name, ""]))
  assert.deepEqual(assessMacSigning(empty).problems, [])
  assert.equal(assessMacSigning(empty).signed, false)
})

test("half configurations fail instead of shipping a warned-about app", () => {
  assert.match(
    assessMacSigning(certificate).problems.join("\n"),
    /no notarization credentials; Gatekeeper would still warn/
  )
  assert.match(assessMacSigning(apiKey).problems.join("\n"), /no Developer ID certificate/)
  assert.match(
    assessMacSigning({ CSC_LINK: "base64-p12", ...apiKey }).problems.join("\n"),
    /without CSC_KEY_PASSWORD/
  )
  assert.match(
    assessMacSigning({ ...certificate, APPLE_API_KEY_ID: "ABC123DEFG" }).problems.join("\n"),
    /API key is incomplete; missing APPLE_API_KEY \(or APPLE_API_KEY_BASE64\), APPLE_API_ISSUER/
  )
  assert.match(
    assessMacSigning({ ...certificate, APPLE_ID: "dev@example.com" }).problems.join("\n"),
    /Apple ID notarization login is incomplete; missing APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/
  )
  assert.match(
    assessMacSigning({ ...certificate, ...apiKey, ...appleId }).problems.join("\n"),
    /more than one method/
  )
  assert.match(
    assessMacSigning({ ...certificate, ...appleId, APPLE_TEAM_ID: "team" }).problems.join("\n"),
    /10-character team ID/
  )
})

test("signing is only required by an explicit true", () => {
  for (const value of ["", "false", "1", "yes"]) {
    assert.equal(assessMacSigning({ BETTERC0DE_MACOS_SIGNING: value }).required, false, value)
  }
  assert.equal(assessMacSigning({ BETTERC0DE_MACOS_SIGNING: "TRUE" }).required, true)
})

test("a base64 App Store Connect key is written to a private .p8 file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "macos-signing-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const pem = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----"
  const file = writeApiKeyFile(
    { APPLE_API_KEY_BASE64: Buffer.from(pem).toString("base64"), APPLE_API_KEY_ID: "ABC123DEFG" },
    path.join(directory, "keys")
  )
  assert.equal(file, path.join(directory, "keys", "AuthKey_ABC123DEFG.p8"))
  assert.equal(fs.readFileSync(file, "utf8"), `${pem}\n`)
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)

  assert.equal(writeApiKeyFile({ APPLE_API_KEY: "/already/AuthKey.p8", APPLE_API_KEY_BASE64: "x" }, directory), null)
  assert.equal(writeApiKeyFile({}, directory), null)
  assert.throws(
    () => writeApiKeyFile({ APPLE_API_KEY_BASE64: Buffer.from("not a key").toString("base64") }, directory),
    /not a base64-encoded \.p8 key/
  )
})
