#!/usr/bin/env node

// Builds the iOS app for the simulator and runs the device tests on it.
// Needs macOS with Xcode 26 or newer and CocoaPods; from Windows, iOS
// builds go through EAS (docs/development/mobile.md).
//
//   node scripts/mobile-ios.mjs build        unsigned simulator build, checked
//   node scripts/mobile-ios.mjs e2e [<app>]  boot a simulator, install, run the Maestro flows
//   node scripts/mobile-ios.mjs all          both
//
// The build uses the Release configuration, so the JavaScript bundle is
// inside the app as in TestFlight, for the simulator and without code
// signing, into apps/mobile/build/ios. It then checks the app's Info.plist:
// bundle identifier, version, network policy (ATS), the encryption
// declaration, the camera prompt and the betterc0de:// scheme. The signed
// App Store build comes from EAS; this one proves that the native project
// compiles and that the app runs.
//
// `e2e` uses the simulator named by BETTERC0DE_SIMULATOR (name or UDID),
// otherwise an available iPhone on the newest iOS. Screenshots and logs of
// a failed run land in apps/mobile/build/e2e/ios.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { EXPECTED_ATS } from "./mobile-checks.mjs"
import { prebuild } from "./mobile-prebuild.mjs"
import { capture, npm, releaseVersion, root, run, sleep } from "./mobile-run.mjs"
import { MAESTRO_ENV, ensureMaestro, findJdk, maestroTestArgs, resolveIos } from "./mobile-toolchain.mjs"

const require = createRequire(import.meta.url)
const { iosMarketingVersion } = require("../apps/mobile/config/version.cjs")

const mobileRoot = path.join(root, "apps", "mobile")
const iosRoot = path.join(mobileRoot, "ios")
export const IOS_OUTPUT_DIR = path.join(mobileRoot, "build", "ios")
export const E2E_OUTPUT_DIR = path.join(mobileRoot, "build", "e2e", "ios")
const FLOWS_DIR = path.join(mobileRoot, "maestro", "flows")
export const BUNDLE_ID = "com.betterc0de.remote"
export const URL_SCHEME = "betterc0de"
export const COMMANDS = ["build", "e2e", "all"]

export function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!COMMANDS.includes(command)) throw new Error(`Usage: mobile-ios.mjs <${COMMANDS.join("|")}> [app]`)
  const app = command === "e2e" ? (rest.find((arg) => !arg.startsWith("-")) ?? null) : null
  const unknown = rest.filter((arg) => arg !== app)
  if (unknown.length > 0) throw new Error(`Unexpected argument ${unknown[0]}.`)
  return { command, app }
}

/** What is wrong with the built app's Info.plist (as `plutil -convert json` prints it). */
export function checkInfoPlist(plist, version) {
  const problems = []
  const expect = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
  }
  expect("CFBundleIdentifier", plist.CFBundleIdentifier, BUNDLE_ID)
  expect("CFBundleShortVersionString", plist.CFBundleShortVersionString, iosMarketingVersion(version))
  expect("NSAppTransportSecurity", plist.NSAppTransportSecurity, EXPECTED_ATS)
  expect("ITSAppUsesNonExemptEncryption", plist.ITSAppUsesNonExemptEncryption, false)
  if (typeof plist.NSCameraUsageDescription !== "string" || !plist.NSCameraUsageDescription.trim()) {
    problems.push("NSCameraUsageDescription is missing: iOS would refuse the camera for the pairing QR code")
  }
  if ("NSMicrophoneUsageDescription" in plist) {
    problems.push("NSMicrophoneUsageDescription is set, but the app never records audio")
  }
  const schemes = (plist.CFBundleURLTypes ?? []).flatMap((type) => type.CFBundleURLSchemes ?? [])
  if (!schemes.includes(URL_SCHEME)) problems.push(`the ${URL_SCHEME}:// scheme is not registered`)
  return problems
}

/**
 * The simulator to test on, from `xcrun simctl list devices available --json`:
 * the one BETTERC0DE_SIMULATOR names (by name or UDID), else an iPhone on
 * the newest iOS runtime, a booted one first.
 */
export function chooseSimulator(list, wanted = "") {
  const devices = Object.entries(list.devices ?? {}).flatMap(([runtime, entries]) => {
    const version = /iOS-(\d+)-(\d+)/.exec(runtime)
    if (!version) return []
    return entries
      .filter((device) => device.isAvailable !== false)
      .map((device) => ({ ...device, runtime, version: [Number(version[1]), Number(version[2])] }))
  })
  if (wanted) {
    const match = devices.find((device) => device.udid === wanted || device.name === wanted)
    if (!match) throw new Error(`No available simulator is named ${wanted}.`)
    return match
  }
  const iphones = devices.filter((device) => device.name.startsWith("iPhone"))
  iphones.sort(
    (a, b) =>
      b.version[0] - a.version[0] ||
      b.version[1] - a.version[1] ||
      Number(b.state === "Booted") - Number(a.state === "Booted")
  )
  if (iphones.length === 0) throw new Error("No iPhone simulator is available. Add one in Xcode → Window → Devices and Simulators.")
  return iphones[0]
}

function xcodeEnv(env = process.env) {
  // CocoaPods refuses to run without a UTF-8 locale.
  return { ...env, LANG: env.LANG || "en_US.UTF-8", LC_ALL: env.LC_ALL || "en_US.UTF-8" }
}

function workspaceName() {
  const workspaces = fs.readdirSync(iosRoot).filter((name) => name.endsWith(".xcworkspace"))
  if (workspaces.length !== 1) throw new Error(`Expected one Xcode workspace in apps/mobile/ios, found ${workspaces.length}.`)
  return path.basename(workspaces[0], ".xcworkspace")
}

function readPlist(file) {
  return JSON.parse(capture("plutil", ["-convert", "json", "-o", "-", file]))
}

export function build({ env = process.env } = {}) {
  const version = releaseVersion()
  const toolEnv = xcodeEnv(env)
  npm(["run", "build:schema"])
  prebuild(["ios"], { env: toolEnv })
  run("pod", ["install"], { cwd: iosRoot, env: toolEnv })
  const name = workspaceName()
  const derivedData = path.join(IOS_OUTPUT_DIR, "DerivedData")
  fs.rmSync(derivedData, { recursive: true, force: true })
  run(
    "xcodebuild",
    [
      "-workspace",
      path.join(iosRoot, `${name}.xcworkspace`),
      "-scheme",
      name,
      "-configuration",
      "Release",
      "-sdk",
      "iphonesimulator",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      derivedData,
      // One slice, for the simulator on this Mac.
      `ARCHS=${os.arch() === "arm64" ? "arm64" : "x86_64"}`,
      "ONLY_ACTIVE_ARCH=NO",
      "CODE_SIGNING_ALLOWED=NO",
      "COMPILER_INDEX_STORE_ENABLE=NO",
      "build",
    ],
    { cwd: iosRoot, env: toolEnv }
  )
  const products = path.join(derivedData, "Build", "Products", "Release-iphonesimulator")
  const app = fs
    .readdirSync(products)
    .filter((entry) => entry.endsWith(".app"))
    .map((entry) => path.join(products, entry))[0]
  if (!app) throw new Error(`xcodebuild reported success but ${products} has no .app.`)
  const problems = checkInfoPlist(readPlist(path.join(app, "Info.plist")), version)
  if (!fs.existsSync(path.join(app, "main.jsbundle"))) problems.push("the JavaScript bundle is not inside the app")
  if (problems.length > 0) {
    throw new Error(`The iOS app failed verification:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
  }
  process.stdout.write(`${path.relative(root, app)}\n  ${BUNDLE_ID} ${iosMarketingVersion(version)}, verified\n`)
  return app
}

function builtApp() {
  const products = path.join(IOS_OUTPUT_DIR, "DerivedData", "Build", "Products", "Release-iphonesimulator")
  const app = fs.existsSync(products) ? fs.readdirSync(products).find((entry) => entry.endsWith(".app")) : null
  if (!app) throw new Error("No simulator build in apps/mobile/build/ios; run the build first.")
  return path.join(products, app)
}

export async function e2e({ app, env = process.env }) {
  app ??= builtApp()
  const simctl = (args, options) => capture("xcrun", ["simctl", ...args], { env, ...options })
  const simulator = chooseSimulator(JSON.parse(simctl(["list", "devices", "available", "--json"])), env.BETTERC0DE_SIMULATOR?.trim())
  const udid = simulator.udid
  const booted = simulator.state !== "Booted"
  process.stdout.write(`Simulator: ${simulator.name} (${simulator.runtime}, ${udid})\n`)
  if (booted) simctl(["boot", udid])
  simctl(["bootstatus", udid, "-b"])
  const executable = readPlist(path.join(app, "Info.plist")).CFBundleExecutable
  try {
    simctl(["uninstall", udid, BUNDLE_ID], { allowFailure: true })
    simctl(["install", udid, app])

    // The app starts and keeps running.
    simctl(["launch", udid, BUNDLE_ID])
    await sleep(8_000)
    const services = simctl(["spawn", udid, "launchctl", "list"], { allowFailure: true })
    if (!services.includes(`UIKitApplication:${BUNDLE_ID}`)) throw new Error("The app did not stay up after launch.")
    simctl(["terminate", udid, BUNDLE_ID], { allowFailure: true })
    process.stdout.write("The app starts without crashing.\n")

    const jdk = findJdk({ env })
    const maestro = await ensureMaestro({ log: (line) => process.stdout.write(`${line}\n`) })
    fs.mkdirSync(E2E_OUTPUT_DIR, { recursive: true })
    run(maestro, maestroTestArgs(udid, FLOWS_DIR, E2E_OUTPUT_DIR), {
      env: { ...env, ...(jdk.home ? { JAVA_HOME: jdk.home } : {}), ...MAESTRO_ENV },
      label: "maestro",
    })
  } catch (error) {
    fs.mkdirSync(E2E_OUTPUT_DIR, { recursive: true })
    spawnSync("xcrun", ["simctl", "io", udid, "screenshot", path.join(E2E_OUTPUT_DIR, "screen.png")])
    const log = spawnSync(
      "xcrun",
      ["simctl", "spawn", udid, "log", "show", "--last", "10m", "--style", "compact", "--predicate", `process == "${executable}"`],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
    )
    fs.writeFileSync(path.join(E2E_OUTPUT_DIR, "app.log"), log.stdout ?? "")
    throw error
  } finally {
    if (booted) spawnSync("xcrun", ["simctl", "shutdown", udid])
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, app } = parseArgs(argv)
  const ios = resolveIos()
  if (ios.problems.length > 0) {
    throw new Error(`The iOS toolchain is incomplete:\n${ios.problems.map((line) => `  - ${line}`).join("\n")}`)
  }
  if (command === "build") build({ env })
  if (command === "e2e") await e2e({ app: app && path.resolve(app), env })
  if (command === "all") await e2e({ app: build({ env }), env })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`\n${error.message}\n`)
    process.exit(1)
  })
}
