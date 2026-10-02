#!/usr/bin/env node

// macOS signing and notarization credentials for desktop builds.
//
// electron-builder signs the app with a "Developer ID Application"
// certificate (CSC_LINK + CSC_KEY_PASSWORD) and then notarizes and staples it
// itself when notarization credentials are in the environment. Gatekeeper
// only opens a downloaded app without the "Apple could not verify ..."
// warning when both happened.
//
// Notarization uses one of:
//   - an App Store Connect API key (recommended for CI):
//       APPLE_API_KEY (path to AuthKey_<id>.p8) or APPLE_API_KEY_BASE64,
//       APPLE_API_KEY_ID, APPLE_API_ISSUER
//   - an Apple ID with an app-specific password:
//       APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
//
// BETTERC0DE_MACOS_SIGNING=true makes signing mandatory: a build without
// complete credentials fails instead of producing an unsigned app. Without
// it, a build with no credentials is unsigned, as before, and a half
// configuration still fails.
//
//   node scripts/macos-signing.mjs check     report the configuration
//   node scripts/macos-signing.mjs prepare   CI: validate, write the API key
//                                            file and export APPLE_API_KEY
//
// Only Node built-ins: release:check imports this while node_modules is
// being reinstalled. Secret values are never printed.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const MACOS_SIGNING_FLAG = "BETTERC0DE_MACOS_SIGNING"

/** Every variable that carries macOS signing or notarization credentials. */
export const MACOS_SIGNING_ENV = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "APPLE_API_KEY",
  "APPLE_API_KEY_BASE64",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
]

const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/

function present(env, name) {
  const value = env[name]
  return typeof value === "string" && value.trim().length > 0
}

export function macSigningRequired(env = process.env) {
  return String(env[MACOS_SIGNING_FLAG] ?? "").trim().toLowerCase() === "true"
}

/**
 * What a build with this environment would produce, and why it must not run
 * when the configuration is incomplete.
 *
 * @returns {{
 *   required: boolean,
 *   certificate: boolean,
 *   notarization: "api-key" | "apple-id" | "keychain-profile" | null,
 *   signed: boolean,
 *   problems: string[],
 * }}
 */
export function assessMacSigning(env = process.env) {
  const required = macSigningRequired(env)
  const problems = []

  const certificate = present(env, "CSC_LINK") || present(env, "CSC_NAME")
  if (present(env, "CSC_LINK") && !present(env, "CSC_KEY_PASSWORD")) {
    problems.push("CSC_LINK is set without CSC_KEY_PASSWORD (the .p12 export password).")
  }

  const apiKeyFields = ["APPLE_API_KEY_ID", "APPLE_API_ISSUER"]
  const apiKeyFile = present(env, "APPLE_API_KEY") || present(env, "APPLE_API_KEY_BASE64")
  const apiKeyStarted = apiKeyFile || apiKeyFields.some((name) => present(env, name))
  const apiKeyMissing = [
    ...(apiKeyFile ? [] : ["APPLE_API_KEY (or APPLE_API_KEY_BASE64)"]),
    ...apiKeyFields.filter((name) => !present(env, name)),
  ]

  const appleIdFields = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"]
  const appleIdStarted = appleIdFields.some((name) => present(env, name))
  const appleIdMissing = [...appleIdFields, "APPLE_TEAM_ID"].filter((name) => !present(env, name))

  const keychainProfile = present(env, "APPLE_KEYCHAIN_PROFILE")

  const methods = [
    apiKeyStarted && "api-key",
    appleIdStarted && "apple-id",
    keychainProfile && "keychain-profile",
  ].filter(Boolean)
  if (methods.length > 1) {
    problems.push(
      `Notarization credentials for more than one method are set (${methods.join(", ")}); keep one.`
    )
  }
  if (apiKeyStarted && apiKeyMissing.length > 0) {
    problems.push(`The App Store Connect API key is incomplete; missing ${apiKeyMissing.join(", ")}.`)
  }
  if (appleIdStarted && appleIdMissing.length > 0) {
    problems.push(`The Apple ID notarization login is incomplete; missing ${appleIdMissing.join(", ")}.`)
  }

  let notarization = null
  if (methods.length === 1) {
    if (apiKeyStarted && apiKeyMissing.length === 0) notarization = "api-key"
    else if (appleIdStarted && appleIdMissing.length === 0) notarization = "apple-id"
    else if (keychainProfile) notarization = "keychain-profile"
  }

  if (present(env, "APPLE_TEAM_ID") && !TEAM_ID_PATTERN.test(env.APPLE_TEAM_ID.trim())) {
    problems.push("APPLE_TEAM_ID must be the 10-character team ID from the Apple Developer account.")
  }

  // A certificate without notarization still gets the Gatekeeper warning; a
  // notarization login without a certificate has nothing to notarize.
  if (certificate && !notarization && methods.length === 0) {
    problems.push(
      "A signing certificate is set but no notarization credentials; Gatekeeper would still warn. " +
        "Add an App Store Connect API key (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER) or an Apple ID login."
    )
  }
  if (!certificate && methods.length > 0) {
    problems.push(
      "Notarization credentials are set but no Developer ID certificate (CSC_LINK + CSC_KEY_PASSWORD)."
    )
  }

  if (required) {
    if (!certificate) {
      problems.push(
        `${MACOS_SIGNING_FLAG}=true needs the Developer ID Application certificate (CSC_LINK + CSC_KEY_PASSWORD).`
      )
    }
    if (methods.length === 0) {
      problems.push(
        `${MACOS_SIGNING_FLAG}=true needs notarization credentials: an App Store Connect API key or an Apple ID login.`
      )
    }
    if (!present(env, "APPLE_TEAM_ID")) {
      problems.push(
        `${MACOS_SIGNING_FLAG}=true needs APPLE_TEAM_ID so the build can check that the app is signed by your team.`
      )
    }
  }

  const unique = [...new Set(problems)]
  return {
    required,
    certificate,
    notarization,
    signed: certificate && notarization !== null && unique.length === 0,
    problems: unique,
  }
}

export function describeMacSigning(state) {
  if (state.problems.length > 0) return "macOS signing is misconfigured."
  if (state.signed) {
    const method =
      state.notarization === "api-key"
        ? "an App Store Connect API key"
        : state.notarization === "apple-id"
          ? "an Apple ID"
          : "a keychain profile"
    return `macOS builds are signed with a Developer ID certificate and notarized with ${method}.`
  }
  return "macOS builds are unsigned (no signing credentials are configured)."
}

/**
 * Writes a base64 App Store Connect key (`APPLE_API_KEY_BASE64`) to a private
 * `.p8` file, because notarytool only accepts a path. Returns the path, or
 * null when no base64 key is set or a key path is already configured.
 */
export function writeApiKeyFile(env, directory) {
  if (present(env, "APPLE_API_KEY") || !present(env, "APPLE_API_KEY_BASE64")) return null
  const pem = Buffer.from(env.APPLE_API_KEY_BASE64.trim(), "base64").toString("utf8")
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(pem)) {
    throw new Error(
      "APPLE_API_KEY_BASE64 is not a base64-encoded .p8 key. Encode the downloaded AuthKey_<id>.p8 file with base64."
    )
  }
  const keyId = String(env.APPLE_API_KEY_ID ?? "key").replace(/[^A-Za-z0-9]/g, "") || "key"
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `AuthKey_${keyId}.p8`)
  fs.writeFileSync(file, pem.endsWith("\n") ? pem : `${pem}\n`, { mode: 0o600 })
  return file
}

function prepare(env) {
  if (process.platform !== "darwin") {
    console.log("[macos-signing] not a macOS build; nothing to prepare.")
    return 0
  }
  const state = assessMacSigning(env)
  if (state.problems.length > 0) {
    for (const problem of state.problems) console.log(`::error::${problem}`)
    return 1
  }
  if (state.notarization === "api-key") {
    const directory = path.join(env.RUNNER_TEMP || os.tmpdir(), "betterc0de-notarization")
    const file = writeApiKeyFile(env, directory)
    if (file) {
      if (!env.GITHUB_ENV) {
        throw new Error("GITHUB_ENV is not set; run `prepare` inside a GitHub Actions step.")
      }
      fs.appendFileSync(env.GITHUB_ENV, `APPLE_API_KEY=${file}\n`)
      console.log("[macos-signing] App Store Connect key written for notarization.")
    }
  }
  console.log(`[macos-signing] ${describeMacSigning(state)}`)
  return 0
}

function check(env) {
  const state = assessMacSigning(env)
  for (const problem of state.problems) console.error(`[macos-signing] ${problem}`)
  console.log(`[macos-signing] ${describeMacSigning(state)}`)
  return state.problems.length > 0 ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const command = process.argv[2]
  try {
    if (command === "prepare") process.exitCode = prepare(process.env)
    else if (command === "check") process.exitCode = check(process.env)
    else {
      console.error("Usage: node scripts/macos-signing.mjs check|prepare")
      process.exitCode = 2
    }
  } catch (error) {
    console.error(`[macos-signing] ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}
