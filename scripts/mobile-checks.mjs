#!/usr/bin/env node

// Checks the mobile app without Android or iOS toolchains. release:check
// runs it in the build step on every platform.
//
//   1. The evaluated app config (`expo config --type introspect`): store
//      identifiers, the versions derived from the root package.json, the
//      plain-HTTP policy (iOS App Transport Security, Android cleartext),
//      the Android ABIs and the export-compliance flag.
//   2. Native dependencies match the installed Expo SDK (`expo install
//      --check`, offline: the installed SDK's own list is the reference, so
//      a new Expo patch release cannot fail an unchanged commit).
//   3. No native module is installed twice (`expo-modules-autolinking
//      verify`); two copies link one and bundle the other.
//   4. The JavaScript bundles for Android, iOS and web build (`expo export`).
//
//   node scripts/mobile-checks.mjs

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const mobileRoot = path.join(root, "apps", "mobile")
const require = createRequire(import.meta.url)
const { androidVersionCode, iosMarketingVersion } = require("../apps/mobile/config/version.cjs")

export const EXPECTED_IDENTIFIERS = { ios: "com.betterc0de.remote", android: "com.betterc0de.remote" }
export const EXPECTED_ANDROID_ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64"]
/** See the NSAppTransportSecurity comment in apps/mobile/app.config.ts. */
export const EXPECTED_ATS = {
  NSAllowsLocalNetworking: true,
  NSExceptionDomains: {
    "ts.net": { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true },
  },
}
export const EXPORT_PLATFORMS = ["android", "ios", "web"]

function sameJson(left, right) {
  const sort = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]))
      : value
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right))
}

/** Problems in the output of `expo config --type introspect --json`; empty when it is as intended. */
export function checkIntrospectedConfig(config, { releaseVersion }) {
  const problems = []
  const expect = (condition, message) => {
    if (!condition) problems.push(message)
  }
  const infoPlist = config?._internal?.modResults?.ios?.infoPlist ?? {}
  const manifest = config?._internal?.modResults?.android?.manifest?.manifest ?? {}
  const gradleProperties = new Map(
    (config?._internal?.modResults?.android?.gradleProperties ?? [])
      .filter((entry) => entry.type === "property")
      .map((entry) => [entry.key, entry.value])
  )
  const application = manifest.application?.[0]?.$ ?? {}

  expect(config?.version === releaseVersion, `version is ${config?.version}, expected the desktop version ${releaseVersion}`)
  expect(
    infoPlist.CFBundleShortVersionString === iosMarketingVersion(releaseVersion),
    `iOS CFBundleShortVersionString is ${infoPlist.CFBundleShortVersionString}, expected ${iosMarketingVersion(releaseVersion)}`
  )
  expect(
    config?.android?.versionCode === androidVersionCode(releaseVersion),
    `android.versionCode is ${config?.android?.versionCode}, expected ${androidVersionCode(releaseVersion)}`
  )
  expect(
    config?.ios?.bundleIdentifier === EXPECTED_IDENTIFIERS.ios,
    `ios.bundleIdentifier is ${config?.ios?.bundleIdentifier}, expected ${EXPECTED_IDENTIFIERS.ios}`
  )
  expect(
    config?.android?.package === EXPECTED_IDENTIFIERS.android,
    `android.package is ${config?.android?.package}, expected ${EXPECTED_IDENTIFIERS.android}`
  )
  expect(
    sameJson(infoPlist.NSAppTransportSecurity, EXPECTED_ATS),
    `iOS NSAppTransportSecurity is ${JSON.stringify(infoPlist.NSAppTransportSecurity)}, expected ${JSON.stringify(EXPECTED_ATS)}`
  )
  expect(
    infoPlist.ITSAppUsesNonExemptEncryption === false,
    "iOS ITSAppUsesNonExemptEncryption must be false (the app uses only the platform's HTTPS)"
  )
  expect(
    typeof infoPlist.NSLocalNetworkUsageDescription === "string" && infoPlist.NSLocalNetworkUsageDescription.length > 0,
    "iOS NSLocalNetworkUsageDescription is missing; iOS shows it before the first local-network connection"
  )
  expect(
    application["android:usesCleartextTraffic"] === "true",
    `Android usesCleartextTraffic is ${application["android:usesCleartextTraffic"]}, expected "true" (desktops are reached by LAN/Tailscale IP)`
  )
  expect(
    gradleProperties.get("reactNativeArchitectures") === EXPECTED_ANDROID_ABIS.join(","),
    `Android ABIs are ${gradleProperties.get("reactNativeArchitectures")}, expected ${EXPECTED_ANDROID_ABIS.join(",")}`
  )
  expect(
    gradleProperties.get("expo.useLegacyPackaging") === "true",
    "Android native libraries must be compressed (expo.useLegacyPackaging=true) to keep the universal APK small"
  )
  expect(
    Array.isArray(config?.plugins) && config.plugins.includes("./plugins/with-android-release-signing.cjs"),
    "the release-signing config plugin is not applied"
  )
  return problems
}

/** Native modules that `expo-modules-autolinking verify --json` found more than once. */
export function findDuplicateNativeModules(verifyOutput) {
  return (verifyOutput?.dependencies ?? [])
    .filter((dependency) => Array.isArray(dependency.duplicates) && dependency.duplicates.length > 0)
    .map((dependency) => dependency.name)
}

function mobileRequire() {
  return createRequire(path.join(mobileRoot, "package.json"))
}

function expoBin(packageName, binPath) {
  return path.join(path.dirname(mobileRequire().resolve(`${packageName}/package.json`)), binPath)
}

function runNode(script, args, { capture = false } = {}) {
  process.stdout.write(`\n$ ${path.basename(script)} ${args.join(" ")}  (in apps/mobile)\n`)
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: mobileRoot,
    encoding: capture ? "utf8" : undefined,
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, EXPO_NO_TELEMETRY: process.env.EXPO_NO_TELEMETRY ?? "1" },
  })
  if (result.error) throw new Error(`${path.basename(script)} ${args[0]} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${path.basename(script)} ${args.join(" ")} failed (${result.status ?? result.signal})`)
  return capture ? result.stdout : null
}

function main() {
  if (!fs.existsSync(path.join(root, "packages", "schema", "dist"))) {
    throw new Error("packages/schema/dist is missing; the app bundles the compiled schema. Run: npm run build:schema")
  }
  const { version: releaseVersion } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const expoCli = expoBin("expo", path.join("bin", "cli"))

  const config = JSON.parse(runNode(expoCli, ["config", "--type", "introspect", "--json"], { capture: true }))
  const problems = checkIntrospectedConfig(config, { releaseVersion })
  if (problems.length > 0) throw new Error(`The app config is not as intended:\n  - ${problems.join("\n  - ")}`)
  process.stdout.write(`App config ok: ${releaseVersion}, iOS ${iosMarketingVersion(releaseVersion)}, versionCode ${androidVersionCode(releaseVersion)}.\n`)

  process.env.EXPO_OFFLINE = "1"
  try {
    runNode(expoCli, ["install", "--check"])
  } finally {
    delete process.env.EXPO_OFFLINE
  }

  const autolinking = expoBin("expo-modules-autolinking", path.join("bin", "expo-modules-autolinking.js"))
  const verify = JSON.parse(runNode(autolinking, ["verify", "--json", "--platform", "native"], { capture: true }))
  const duplicates = findDuplicateNativeModules(verify)
  if (duplicates.length > 0) {
    throw new Error(
      `Native modules installed more than once: ${duplicates.join(", ")}. Align the versions (root package.json overrides).`
    )
  }
  process.stdout.write("No duplicate native modules.\n")

  for (const platform of EXPORT_PLATFORMS) {
    runNode(expoCli, ["export", "--platform", platform, "--output-dir", path.join("dist", platform)])
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry
}

if (isEntryPoint()) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`\n${error.message}\n`)
    process.exitCode = 1
  }
}
