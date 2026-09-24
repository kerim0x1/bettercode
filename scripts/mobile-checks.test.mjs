import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

import {
  EXPECTED_ANDROID_ABIS,
  EXPECTED_ATS,
  checkIntrospectedConfig,
  findDuplicateNativeModules,
} from "./mobile-checks.mjs"

const require = createRequire(import.meta.url)
const { androidVersionCode } = require("../apps/mobile/config/version.cjs")

const releaseVersion = "0.1.0-beta.2"

/** The parts of `expo config --type introspect --json` the check reads, as the current config produces them. */
function introspected(overrides = {}) {
  const config = {
    version: releaseVersion,
    plugins: ["expo-router", "./plugins/with-android-release-signing.cjs"],
    ios: { bundleIdentifier: "com.betterc0de.remote" },
    android: { package: "com.betterc0de.remote", versionCode: androidVersionCode(releaseVersion) },
    _internal: {
      modResults: {
        ios: {
          infoPlist: {
            CFBundleShortVersionString: "0.1.0",
            NSAppTransportSecurity: structuredClone(EXPECTED_ATS),
            ITSAppUsesNonExemptEncryption: false,
            NSLocalNetworkUsageDescription: "BetterC0de Remote connects to the desktop app.",
          },
        },
        android: {
          manifest: { manifest: { application: [{ $: { "android:usesCleartextTraffic": "true" } }] } },
          gradleProperties: [
            { type: "comment", value: "generated" },
            { type: "property", key: "reactNativeArchitectures", value: EXPECTED_ANDROID_ABIS.join(",") },
            { type: "property", key: "expo.useLegacyPackaging", value: "true" },
          ],
        },
      },
    },
  }
  overrides.edit?.(config)
  return config
}

test("the current app config passes", () => {
  assert.deepEqual(checkIntrospectedConfig(introspected(), { releaseVersion }), [])
})

test("each deviation from the intended config is reported", () => {
  const cases = [
    [(config) => (config.version = "0.1.0-beta.1"), /desktop version/],
    [(config) => (config._internal.modResults.ios.infoPlist.CFBundleShortVersionString = "0.1.0-beta.2"), /CFBundleShortVersionString/],
    [(config) => (config.android.versionCode = 1), /versionCode/],
    [(config) => (config.ios.bundleIdentifier = "com.example"), /bundleIdentifier/],
    [
      // Ignored by iOS once NSAllowsLocalNetworking is set, and a review flag.
      (config) => (config._internal.modResults.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads = true),
      /NSAppTransportSecurity/,
    ],
    [(config) => delete config._internal.modResults.ios.infoPlist.ITSAppUsesNonExemptEncryption, /ITSAppUsesNonExemptEncryption/],
    [(config) => delete config._internal.modResults.ios.infoPlist.NSLocalNetworkUsageDescription, /NSLocalNetworkUsageDescription/],
    [
      (config) =>
        (config._internal.modResults.android.manifest.manifest.application[0].$["android:usesCleartextTraffic"] = "false"),
      /usesCleartextTraffic/,
    ],
    [(config) => (config._internal.modResults.android.gradleProperties[1].value = "arm64-v8a"), /ABIs/],
    [(config) => config._internal.modResults.android.gradleProperties.pop(), /useLegacyPackaging/],
    [(config) => config.plugins.pop(), /release-signing/],
  ]
  for (const [edit, expected] of cases) {
    const problems = checkIntrospectedConfig(introspected({ edit }), { releaseVersion })
    assert.equal(problems.length, 1, `${expected}: ${JSON.stringify(problems)}`)
    assert.match(problems[0], expected)
  }
})

test("a native module installed twice is reported by name", () => {
  const output = {
    dependencies: [
      { name: "expo", duplicates: [] },
      { name: "expo-status-bar", duplicates: null },
      {
        name: "react-native-gesture-handler",
        duplicates: [{ name: "react-native-gesture-handler", version: "3.1.0", path: "node_modules/react-native-gesture-handler" }],
      },
    ],
  }
  assert.deepEqual(findDuplicateNativeModules(output), ["react-native-gesture-handler"])
  assert.deepEqual(findDuplicateNativeModules({ dependencies: [] }), [])
})
