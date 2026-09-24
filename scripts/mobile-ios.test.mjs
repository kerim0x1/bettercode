import assert from "node:assert/strict"
import test from "node:test"

import { BUNDLE_ID, checkInfoPlist, chooseSimulator, parseArgs } from "./mobile-ios.mjs"
import { EXPECTED_ATS } from "./mobile-checks.mjs"

const version = "0.1.0-beta.3"

/** An Info.plist the way a correct build produces it. */
function plist(overrides = {}) {
  return {
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleShortVersionString: "0.1.0",
    CFBundleExecutable: "BetterC0deRemote",
    NSAppTransportSecurity: structuredClone(EXPECTED_ATS),
    ITSAppUsesNonExemptEncryption: false,
    NSCameraUsageDescription: "BetterC0de Remote uses the camera only to scan the pairing QR code.",
    CFBundleURLTypes: [{ CFBundleURLSchemes: ["betterc0de", "com.betterc0de.remote"] }],
    ...overrides,
  }
}

test("reads the command and the app to test", () => {
  assert.deepEqual(parseArgs(["build"]), { command: "build", app: null })
  assert.deepEqual(parseArgs(["e2e", "Remote.app"]), { command: "e2e", app: "Remote.app" })
  assert.deepEqual(parseArgs(["all"]), { command: "all", app: null })
  assert.throws(() => parseArgs(["archive"]), /Usage/)
  assert.throws(() => parseArgs(["build", "Remote.app"]), /Unexpected argument Remote\.app/)
})

test("accepts the Info.plist of a correct build", () => {
  assert.deepEqual(checkInfoPlist(plist(), version), [])
})

test("names every Info.plist setting a build got wrong", () => {
  const problems = checkInfoPlist(
    plist({
      CFBundleIdentifier: "com.example.remote",
      CFBundleShortVersionString: "0.1.0-beta.3",
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      ITSAppUsesNonExemptEncryption: undefined,
      NSCameraUsageDescription: "",
      NSMicrophoneUsageDescription: "Record audio",
      CFBundleURLTypes: [],
    }),
    version
  )
  assert.deepEqual(
    problems.map((problem) => problem.split(" ")[0]),
    [
      "CFBundleIdentifier",
      "CFBundleShortVersionString",
      "NSAppTransportSecurity",
      "ITSAppUsesNonExemptEncryption",
      "NSCameraUsageDescription",
      "NSMicrophoneUsageDescription",
      "the",
    ]
  )
  assert.match(problems.at(-1), /betterc0de:\/\/ scheme is not registered/)
})

const simulators = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
      { udid: "A", name: "iPhone 16", state: "Booted", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: "B", name: "iPad Pro 13-inch (M5)", state: "Shutdown", isAvailable: true },
      { udid: "C", name: "iPhone 17", state: "Shutdown", isAvailable: true },
      { udid: "D", name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
      { udid: "E", name: "iPhone Air", state: "Shutdown", isAvailable: false },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
      { udid: "F", name: "Apple Watch Ultra 3", state: "Shutdown", isAvailable: true },
    ],
  },
}

test("tests on an iPhone with the newest iOS, a booted one first", () => {
  assert.equal(chooseSimulator(simulators).udid, "D")
  const noneBooted = structuredClone(simulators)
  noneBooted.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-0"][2].state = "Shutdown"
  assert.equal(chooseSimulator(noneBooted).name.startsWith("iPhone 17"), true)
})

test("uses the simulator BETTERC0DE_SIMULATOR names", () => {
  assert.equal(chooseSimulator(simulators, "iPhone 16").udid, "A")
  assert.equal(chooseSimulator(simulators, "C").name, "iPhone 17")
  assert.throws(() => chooseSimulator(simulators, "iPhone 3G"), /No available simulator is named iPhone 3G/)
  assert.throws(() => chooseSimulator({ devices: {} }), /No iPhone simulator is available/)
})
