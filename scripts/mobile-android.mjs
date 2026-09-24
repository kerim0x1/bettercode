#!/usr/bin/env node

// Builds, checks and device-tests the Android app, BetterC0de Remote.
//
//   node scripts/mobile-android.mjs build [--signing release|test-key]
//   node scripts/mobile-android.mjs verify <apk> [--signing release|test-key]
//   node scripts/mobile-android.mjs e2e [<apk>]
//   node scripts/mobile-android.mjs all [--signing release|test-key]
//
// `build` compiles the shared schema, regenerates apps/mobile/android with
// the pinned template, runs Gradle's assembleRelease with JDK 17 and checks
// the result like `verify`. It writes apps/mobile/build/android/
//   BetterC0de-Remote-<version>.apk           with the release key, or
//   BetterC0de-Remote-<version>-test-key.apk  with a key made for this run.
// Only the first can be published: the release assembly accepts no other
// name, and `verify --signing release` compares the certificate with the
// fingerprint pinned in apps/mobile/signing/android-release.json.
//
// The release key comes from BETTERC0DE_ANDROID_KEYSTORE,
// BETTERC0DE_ANDROID_KEYSTORE_PASSWORD, BETTERC0DE_ANDROID_KEY_ALIAS and
// BETTERC0DE_ANDROID_KEY_PASSWORD in the environment or in the git-ignored
// .env.signing. CI passes the keystore itself as
// BETTERC0DE_ANDROID_KEYSTORE_BASE64; it is written to a temporary file and
// deleted after the build. The test key is a new throwaway key every run.
//
// `verify` checks what a user installs: an APK Signature Scheme v2
// signature by one certificate, the pinned one for a release and neither it
// nor the template's public debug key for a test build; the package,
// version, SDK levels, ABIs and permissions; that it is not debuggable; that
// 64-bit native libraries load on devices with 16 KB memory pages; and the
// size budget.
//
// `e2e` runs on the test emulator: the AVD named by BETTERC0DE_AVD
// (BetterC0de_Test by default), used when it is already running and booted
// otherwise. It never touches another device or emulator, because it
// uninstalls the app and turns animations off; ANDROID_SERIAL names one
// explicitly. It installs the APK, checks that the app starts without a
// crash, and runs the Maestro flows in apps/mobile/maestro/flows.
// Screenshots and logs of a failed run land in apps/mobile/build/e2e/android.
//
// Gradle runs without a daemon, and Kotlin compiles in a process per task
// instead of the Kotlin daemon: a daemon left behind on Windows keeps files
// in node_modules open (React Native libraries build inside their package
// folders), and the next `npm ci` fails with EBUSY. Compiling inside the
// Gradle process instead runs out of the metaspace the React Native
// template gives it.

import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  misalignedLibraries,
  nativeAbis,
  parseApksignerOutput,
  parseBadging,
  parseKeytoolFingerprint,
  readZipEntries,
} from "./android-apk.mjs"
import { EXPECTED_ANDROID_ABIS } from "./mobile-checks.mjs"
import { prebuild } from "./mobile-prebuild.mjs"
import { capture, npm, releaseVersion, run, sleep, waitFor } from "./mobile-run.mjs"
import {
  DEFAULT_AVD,
  MAESTRO_ENV,
  androidEnv,
  ensureMaestro,
  maestroFailures,
  maestroTestArgs,
  resolveAndroid,
} from "./mobile-toolchain.mjs"

const require = createRequire(import.meta.url)
const { androidVersionCode } = require("../apps/mobile/config/version.cjs")

const root = path.resolve(import.meta.dirname, "..")
const mobileRoot = path.join(root, "apps", "mobile")
const androidRoot = path.join(mobileRoot, "android")
export const APK_OUTPUT_DIR = path.join(mobileRoot, "build", "android")
export const E2E_OUTPUT_DIR = path.join(mobileRoot, "build", "e2e", "android")
export const FLOWS_DIR = path.join(mobileRoot, "maestro", "flows")
export const RELEASE_CERTIFICATE_FILE = path.join(mobileRoot, "signing", "android-release.json")
export const PACKAGE_NAME = "com.betterc0de.remote"
export const SIGNINGS = ["release", "test-key"]
export const COMMANDS = ["build", "verify", "e2e", "all"]
export const SIGNING_ENV = [
  "BETTERC0DE_ANDROID_KEYSTORE",
  "BETTERC0DE_ANDROID_KEYSTORE_PASSWORD",
  "BETTERC0DE_ANDROID_KEY_ALIAS",
  "BETTERC0DE_ANDROID_KEY_PASSWORD",
]

/**
 * Every permission the APK may ask for. A new one is a change users see in
 * the install dialog and has to be justified here; permissions libraries
 * declare that the app does not use are blocked in app.config.ts.
 */
export const EXPECTED_PERMISSIONS = [
  // Scanning the pairing QR code (asked for when the scanner opens).
  "android.permission.CAMERA",
  // Reaching the desktop.
  "android.permission.INTERNET",
  // Whether a network is up, which React Native's networking checks.
  "android.permission.ACCESS_NETWORK_STATE",
  // Haptic feedback when a message is sent or the agent is stopped.
  "android.permission.VIBRATE",
  // AndroidX declares it so only this app can send to its own receivers.
  "com.betterc0de.remote.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
]

/**
 * The largest APK a release may ship: 52.9 MB measured for 0.1.0-beta.2
 * (three ABIs, Hermes, the camera's barcode model), plus about 15 %.
 */
export const MAX_APK_BYTES = 61_000_000

// ---------------------------------------------------------------------------
// Arguments and names
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!COMMANDS.includes(command)) {
    throw new Error(`Usage: mobile-android.mjs <${COMMANDS.join("|")}> [apk] [--signing release|test-key]`)
  }
  let signing = "test-key"
  let apk = null
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === "--signing") {
      signing = rest[index + 1]
      index += 1
      if (!SIGNINGS.includes(signing)) throw new Error(`--signing takes ${SIGNINGS.join(" or ")}.`)
    } else if (arg.startsWith("--signing=")) {
      signing = arg.slice("--signing=".length)
      if (!SIGNINGS.includes(signing)) throw new Error(`--signing takes ${SIGNINGS.join(" or ")}.`)
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}.`)
    } else if (apk === null && (command === "verify" || command === "e2e")) {
      apk = arg
    } else {
      throw new Error(`Unexpected argument ${arg}.`)
    }
  }
  if (command === "verify" && !apk) throw new Error("verify needs the APK to check.")
  return { command, signing, apk }
}

/** The published name for a release build; test builds carry a suffix the release assembly rejects. */
export function apkFileName(version, signing) {
  return signing === "release" ? `BetterC0de-Remote-${version}.apk` : `BetterC0de-Remote-${version}-${signing}.apk`
}

// ---------------------------------------------------------------------------
// Signing keys
// ---------------------------------------------------------------------------

/** The shell-style assignments of .env.signing (as scripts/build-mac-signed.cjs reads them). */
export function parseEnvFile(source) {
  const values = {}
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) throw new Error(`Cannot parse this line of .env.signing: ${rawLine}`)
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

/**
 * The release key's settings, from the environment first and .env.signing
 * second, with BETTERC0DE_ANDROID_KEYSTORE_BASE64 standing in for the
 * keystore path. `missing` names what neither provides.
 */
export function releaseSigningSettings(env, envFileText = null) {
  const file = envFileText === null ? {} : parseEnvFile(envFileText)
  const value = (name) => env[name]?.trim() || file[name]?.trim() || ""
  const settings = Object.fromEntries(SIGNING_ENV.map((name) => [name, value(name)]))
  const keystoreBase64 = env.BETTERC0DE_ANDROID_KEYSTORE_BASE64?.trim() || ""
  const missing = SIGNING_ENV.filter(
    (name) => !settings[name] && !(name === "BETTERC0DE_ANDROID_KEYSTORE" && keystoreBase64)
  )
  return { settings, keystoreBase64, missing }
}

/** Makes the key for one build and returns its settings and a cleanup. */
function prepareSigning(signing, android, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-android-key-"))
  const cleanup = () => fs.rmSync(temp, { recursive: true, force: true })
  try {
    if (signing === "test-key") {
      const password = crypto.randomBytes(18).toString("base64url")
      const keystore = path.join(temp, "test-key.p12")
      capture(android.tools.keytool, [
        "-genkeypair",
        "-noprompt",
        "-storetype",
        "PKCS12",
        "-keystore",
        keystore,
        "-alias",
        "betterc0de-test",
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "2",
        "-dname",
        "CN=BetterC0de Remote test key",
        "-storepass",
        password,
        "-keypass",
        password,
      ])
      return {
        cleanup,
        settings: {
          BETTERC0DE_ANDROID_KEYSTORE: keystore,
          BETTERC0DE_ANDROID_KEYSTORE_PASSWORD: password,
          BETTERC0DE_ANDROID_KEY_ALIAS: "betterc0de-test",
          BETTERC0DE_ANDROID_KEY_PASSWORD: password,
        },
      }
    }
    const envFile = path.join(root, ".env.signing")
    const { settings, keystoreBase64, missing } = releaseSigningSettings(
      env,
      fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : null
    )
    if (missing.length > 0) {
      throw new Error(
        `The release key is not configured: set ${missing.join(", ")} in the environment or in .env.signing (see docs/development/mobile.md). For a local test build use --signing test-key.`
      )
    }
    if (!settings.BETTERC0DE_ANDROID_KEYSTORE) {
      settings.BETTERC0DE_ANDROID_KEYSTORE = path.join(temp, "release.p12")
      fs.writeFileSync(settings.BETTERC0DE_ANDROID_KEYSTORE, Buffer.from(keystoreBase64, "base64"), { mode: 0o600 })
    }
    if (!fs.existsSync(settings.BETTERC0DE_ANDROID_KEYSTORE)) {
      throw new Error(`The release keystore ${settings.BETTERC0DE_ANDROID_KEYSTORE} does not exist.`)
    }
    return { cleanup, settings }
  } catch (error) {
    cleanup()
    throw error
  }
}

/** The certificate a release must be signed with, if it has been pinned yet. */
export function readReleaseCertificate(file = RELEASE_CERTIFICATE_FILE) {
  if (!fs.existsSync(file)) return null
  const pinned = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!/^[0-9a-f]{64}$/.test(pinned.sha256 ?? "")) throw new Error(`${file}: "sha256" must be 64 lowercase hex digits.`)
  return pinned
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export async function build({ signing, android, env = process.env }) {
  const version = releaseVersion()
  const gradleEnv = androidEnv(android, env)
  // Metro reads the shared schema from its build output.
  npm(["run", "build:schema"])
  prebuild(["android"], { env: gradleEnv })
  const key = prepareSigning(signing, android, env)
  try {
    const gradlew = path.join(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew")
    run(
      gradlew,
      [
        "assembleRelease",
        "--no-daemon",
        "--console=plain",
        "-Pkotlin.compiler.execution.strategy=out-of-process",
      ],
      { cwd: androidRoot, env: { ...gradleEnv, ...key.settings }, label: "gradlew" }
    )
  } finally {
    key.cleanup()
  }
  const built = path.join(androidRoot, "app", "build", "outputs", "apk", "release", "app-release.apk")
  if (!fs.existsSync(built)) throw new Error(`Gradle reported success but ${built} does not exist.`)
  fs.mkdirSync(APK_OUTPUT_DIR, { recursive: true })
  for (const stale of fs.readdirSync(APK_OUTPUT_DIR).filter((name) => name.endsWith(".apk"))) {
    fs.rmSync(path.join(APK_OUTPUT_DIR, stale))
  }
  const apk = path.join(APK_OUTPUT_DIR, apkFileName(version, signing))
  fs.copyFileSync(built, apk)
  verify({ apk, signing, android })
  return apk
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/** What is wrong with the APK's contents (the parts that do not need the SDK tools to find). */
export function checkApkContents({ badging, abis, misaligned, size, version, requirements }) {
  const problems = []
  const expect = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
  }
  expect("package", badging.packageName, PACKAGE_NAME)
  expect("versionName", badging.versionName, version)
  expect("versionCode", badging.versionCode, androidVersionCode(version))
  expect("minSdk", badging.minSdk, requirements.minSdk)
  expect("targetSdk", badging.targetSdk, requirements.targetSdk)
  expect("native-code", badging.nativeCode, [...EXPECTED_ANDROID_ABIS].sort())
  expect("ABIs with libraries", abis, [...EXPECTED_ANDROID_ABIS].sort())
  expect("permissions", badging.permissions, [...EXPECTED_PERMISSIONS].sort())
  if (badging.debuggable) problems.push("the APK is debuggable")
  problems.push(...misaligned.map((problem) => `not 16 KB page aligned: ${problem}`))
  if (MAX_APK_BYTES > 0 && size > MAX_APK_BYTES) {
    problems.push(`the APK is ${size} bytes, over the budget of ${MAX_APK_BYTES}`)
  }
  return problems
}

/** What is wrong with the APK's signature for the given signing. */
export function checkSignature({ signer, signing, releaseCertificate, debugCertificate }) {
  const problems = []
  if (!signer.verified) problems.push("apksigner does not verify the APK")
  if (!signer.schemes.v2) problems.push("no APK Signature Scheme v2 signature")
  if (signer.signerCount !== 1) problems.push(`${signer.signerCount ?? "no"} signers, expected exactly one`)
  const fingerprint = signer.signers[0]?.sha256 ?? null
  if (fingerprint && debugCertificate && fingerprint === debugCertificate) {
    problems.push("signed with the React Native template's public debug key")
  }
  if (signing === "release") {
    if (!releaseCertificate) {
      problems.push(
        `no release certificate is pinned in ${path.relative(root, RELEASE_CERTIFICATE_FILE)} (see docs/development/mobile.md)`
      )
    } else if (fingerprint !== releaseCertificate.sha256) {
      problems.push(`signed by ${fingerprint}, not by the pinned release certificate ${releaseCertificate.sha256}`)
    }
  } else if (releaseCertificate && fingerprint === releaseCertificate.sha256) {
    problems.push("a test build is signed with the release key")
  }
  return problems
}

/** The template's debug key, whose password is public: nothing we ship may use it. */
function debugCertificateFingerprint(android) {
  const keystore = path.join(androidRoot, "app", "debug.keystore")
  if (!fs.existsSync(keystore)) return null
  return parseKeytoolFingerprint(
    capture(android.tools.keytool, ["-list", "-v", "-keystore", keystore, "-storepass", "android"])
  )
}

export function verify({ apk, signing, android }) {
  const version = releaseVersion()
  const archive = fs.readFileSync(apk)
  const entries = readZipEntries(archive)
  const badging = parseBadging(capture(android.tools.aapt2, ["dump", "badging", apk]))
  const signer = parseApksignerOutput(
    capture(android.tools.java, ["-jar", android.tools.apksignerJar, "verify", "--verbose", "--print-certs", apk], {
      allowFailure: true,
    })
  )
  const problems = [
    ...checkSignature({
      signer,
      signing,
      releaseCertificate: readReleaseCertificate(),
      debugCertificate: debugCertificateFingerprint(android),
    }),
    ...checkApkContents({
      badging,
      abis: nativeAbis(entries),
      misaligned: misalignedLibraries(archive, entries),
      size: archive.length,
      version,
      requirements: android.requirements,
    }),
  ]
  const summary = [
    `${path.relative(root, apk)} (${(archive.length / 1024 / 1024).toFixed(1)} MB)`,
    `  ${badging.packageName} ${badging.versionName} (${badging.versionCode}), SDK ${badging.minSdk}–${badging.targetSdk}, ${badging.nativeCode.join(" ")}`,
    `  signed by ${signer.signers[0]?.dn ?? "?"} (SHA-256 ${signer.signers[0]?.sha256 ?? "?"})`,
    `  permissions: ${badging.permissions.join(", ") || "none"}`,
  ]
  process.stdout.write(`${summary.join("\n")}\n`)
  if (problems.length > 0) {
    throw new Error(`The APK failed verification:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
  }
  process.stdout.write("  verified\n")
}

// ---------------------------------------------------------------------------
// e2e
// ---------------------------------------------------------------------------

/**
 * The device the tests may use: the one ANDROID_SERIAL names, else an
 * emulator already running the test AVD, else none (the test AVD is then
 * booted). `avds` maps emulator serials to the AVD they run.
 */
export function chooseDevice({ attached, avds, wanted, testAvd }) {
  if (wanted) {
    if (!attached.includes(wanted)) throw new Error(`ANDROID_SERIAL=${wanted} is not attached.`)
    return wanted
  }
  return attached.find((serial) => avds[serial] === testAvd) ?? null
}

/** The first emulator console port no attached emulator uses (serial emulator-<port>). */
export function freeEmulatorPort(attached) {
  for (let port = 5554; port <= 5682; port += 2) {
    if (!attached.includes(`emulator-${port}`)) return port
  }
  throw new Error("Every emulator port from 5554 to 5682 is in use.")
}

/** Serials of attached devices that are ready (`adb devices`). */
export function parseAdbDevices(text) {
  return String(text)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial)
}

/** The AVD an attached emulator runs (`adb emu avd name`). */
function emulatorAvds(android, attached, env) {
  const avds = {}
  for (const serial of attached.filter((candidate) => candidate.startsWith("emulator-"))) {
    const output = capture(android.tools.adb, ["-s", serial, "emu", "avd", "name"], { env, allowFailure: true })
    avds[serial] = output.split(/\r?\n/)[0].trim()
  }
  return avds
}

/** Boots the test AVD on a free port, so its serial is known before it appears. */
async function bootEmulator(android, avd, attached, env) {
  const port = freeEmulatorPort(attached)
  const serial = `emulator-${port}`
  fs.mkdirSync(E2E_OUTPUT_DIR, { recursive: true })
  const log = fs.openSync(path.join(E2E_OUTPUT_DIR, "emulator.log"), "w")
  process.stdout.write(`Booting the emulator ${avd} as ${serial}\n`)
  const child = spawn(
    android.tools.emulator,
    [
      "-avd",
      avd,
      "-port",
      String(port),
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot-save",
      "-gpu",
      "swiftshader_indirect",
    ],
    { env, detached: true, stdio: ["ignore", log, log] }
  )
  child.unref()
  const adb = (args) => capture(android.tools.adb, args, { env, allowFailure: true })
  await waitFor(`${avd} to appear in adb`, 240_000, () => parseAdbDevices(adb(["devices"])).includes(serial))
  await waitFor(`${avd} to finish booting`, 300_000, () =>
    adb(["-s", serial, "shell", "getprop", "sys.boot_completed"]).trim() === "1"
  )
  return serial
}

function saveDiagnostics(android, serial, env) {
  fs.mkdirSync(E2E_OUTPUT_DIR, { recursive: true })
  const adb = (args) => spawnSync(android.tools.adb, ["-s", serial, ...args], { env, maxBuffer: 256 * 1024 * 1024 })
  fs.writeFileSync(path.join(E2E_OUTPUT_DIR, "logcat.txt"), adb(["logcat", "-d"]).stdout ?? "")
  fs.writeFileSync(path.join(E2E_OUTPUT_DIR, "screen.png"), adb(["exec-out", "screencap", "-p"]).stdout ?? "")
}

export async function e2e({ apk, android, env = process.env }) {
  if (!apk) {
    const version = releaseVersion()
    const candidates = SIGNINGS.map((signing) => path.join(APK_OUTPUT_DIR, apkFileName(version, signing)))
    apk = candidates.find((candidate) => fs.existsSync(candidate))
    if (!apk) throw new Error(`No APK in ${path.relative(root, APK_OUTPUT_DIR)}; run the build first.`)
  }
  const toolEnv = androidEnv(android, env)
  const adbCapture = (args, options = {}) => capture(android.tools.adb, args, { env: toolEnv, ...options })
  const attached = parseAdbDevices(adbCapture(["devices"]))
  const testAvd = env.BETTERC0DE_AVD?.trim() || DEFAULT_AVD
  let serial = chooseDevice({
    attached,
    avds: emulatorAvds(android, attached, toolEnv),
    wanted: env.ANDROID_SERIAL?.trim(),
    testAvd,
  })
  let booted = false
  if (!serial) {
    serial = await bootEmulator(android, testAvd, attached, toolEnv)
    booted = true
  }
  process.stdout.write(`Testing on ${serial}\n`)
  const adb = (args, options) => adbCapture(["-s", serial, ...args], options)
  try {
    if (serial.startsWith("emulator-")) {
      // Animations only slow the flows down and make their waits flaky.
      for (const setting of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
        adb(["shell", "settings", "put", "global", setting, "0"])
      }
    }
    adb(["uninstall", PACKAGE_NAME], { allowFailure: true })
    run(android.tools.adb, ["-s", serial, "install", apk], { env: toolEnv, label: "adb" })

    // The app starts and keeps running.
    adb(["logcat", "-b", "crash", "-c"], { allowFailure: true })
    adb(["shell", "am", "start", "-W", "-n", `${PACKAGE_NAME}/.MainActivity`])
    await sleep(8_000)
    const pid = adb(["shell", "pidof", PACKAGE_NAME], { allowFailure: true }).trim()
    const crashes = adb(["logcat", "-b", "crash", "-d"], { allowFailure: true })
    if (!pid || crashes.includes(PACKAGE_NAME)) {
      throw new Error(`The app did not stay up after launch.${crashes.trim() ? `\n${crashes.trim()}` : ""}`)
    }
    adb(["shell", "am", "force-stop", PACKAGE_NAME])
    process.stdout.write("The app starts without crashing.\n")

    const maestro = await ensureMaestro({ log: (line) => process.stdout.write(`${line}\n`) })
    fs.mkdirSync(E2E_OUTPUT_DIR, { recursive: true })
    // Maestro renames a flow's debug folder that exists already ("-2"), and
    // a run that ends early leaves the last run's report in place; both
    // would be read below as this run's. Only Maestro's output goes: the
    // emulator is still writing its log here.
    for (const entry of fs.readdirSync(E2E_OUTPUT_DIR)) {
      if (entry === "maestro" || entry === "maestro-junit.xml" || entry.startsWith("rerun-")) {
        fs.rmSync(path.join(E2E_OUTPUT_DIR, entry), { recursive: true, force: true })
      }
    }
    const maestroEnv = { ...toolEnv, ...MAESTRO_ENV }
    try {
      run(maestro, maestroTestArgs(serial, FLOWS_DIR, E2E_OUTPUT_DIR), { env: maestroEnv, label: "maestro" })
    } catch (error) {
      // The emulator's adbd sometimes drops the connection for a moment
      // ("connection terminated: write failed"), and the command that lands
      // in that gap fails with "device offline". A flow that failed that way
      // tested nothing, so it runs once more; any other failure stands.
      const failures = maestroFailures(E2E_OUTPUT_DIR)
      if (failures.length === 0 || failures.some((failure) => !failure.lostDevice)) throw error
      for (const [index, failure] of failures.entries()) {
        process.stdout.write(
          `The emulator dropped its connection during "${failure.name}" (${failure.reason}). Running that flow once more.\n`
        )
        run(
          maestro,
          maestroTestArgs(serial, path.resolve(root, failure.file), path.join(E2E_OUTPUT_DIR, `rerun-${index + 1}`)),
          { env: maestroEnv, label: "maestro" }
        )
      }
    }
  } catch (error) {
    saveDiagnostics(android, serial, toolEnv)
    throw error
  } finally {
    if (booted) {
      spawnSync(android.tools.adb, ["-s", serial, "emu", "kill"], { env: toolEnv })
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, signing, apk } = parseArgs(argv)
  const android = resolveAndroid({ emulator: command === "e2e" || command === "all", env })
  if (android.problems.length > 0) {
    throw new Error(`The Android toolchain is incomplete:\n${android.problems.map((line) => `  - ${line}`).join("\n")}`)
  }
  process.stdout.write(`JDK 17: ${android.javaHome}\nAndroid SDK: ${android.sdkRoot}\n`)
  if (command === "build") await build({ signing, android, env })
  if (command === "verify") verify({ apk: path.resolve(apk), signing, android })
  if (command === "e2e") await e2e({ apk: apk && path.resolve(apk), android, env })
  if (command === "all") {
    const built = await build({ signing, android, env })
    await e2e({ apk: built, android, env })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`\n${error.message}\n`)
    process.exit(1)
  })
}
