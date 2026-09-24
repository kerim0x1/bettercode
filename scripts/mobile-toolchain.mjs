#!/usr/bin/env node

// Finds what the phone app's native builds and device tests need on this
// machine and says how to get whatever is missing. It installs nothing but
// Maestro, the device-test runner, which is pinned with its checksum in
// apps/mobile/maestro/maestro.json and cached per user.
//
//   node scripts/mobile-toolchain.mjs                 Android, and iOS on macOS
//   node scripts/mobile-toolchain.mjs android         one platform
//   node scripts/mobile-toolchain.mjs --maestro       also download Maestro
//   node scripts/mobile-toolchain.mjs --sdk-packages  `packages=<sdkmanager ids>` for CI
//
// Android builds use JDK 17, the version React Native documents and CI
// uses. JAVA_HOME is taken only when it is a JDK 17 (machines often point
// it at a newer one); BETTERC0DE_JAVA_HOME overrides the search. The SDK
// packages come from React Native's own version catalog, so they follow
// React Native upgrades without a second list here.

import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { readZipEntries, readZipEntry } from "./android-apk.mjs"

const root = path.resolve(import.meta.dirname, "..")
export const MAESTRO_PIN_FILE = path.join(root, "apps", "mobile", "maestro", "maestro.json")
export const DEFAULT_AVD = "BetterC0de_Test"
export const REQUIRED_JDK = 17

// ---------------------------------------------------------------------------
// Android requirements
// ---------------------------------------------------------------------------

/** The `[versions]` table of a Gradle version catalog (libs.versions.toml). */
export function parseVersionCatalog(text) {
  const versions = {}
  let inVersions = false
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim()
    if (!line) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      inVersions = section[1] === "versions"
      continue
    }
    const entry = /^([\w.-]+)\s*=\s*"([^"]*)"$/.exec(line)
    if (inVersions && entry) versions[entry[1]] = entry[2]
  }
  return versions
}

/** SDK levels and packages the app's React Native version builds with. */
export function androidRequirements(repoRoot = root) {
  const catalog = path.join(repoRoot, "node_modules", "react-native", "gradle", "libs.versions.toml")
  if (!fs.existsSync(catalog)) {
    throw new Error(`${path.relative(repoRoot, catalog)} is missing. Run npm ci first.`)
  }
  const versions = parseVersionCatalog(fs.readFileSync(catalog, "utf8"))
  const required = ["minSdk", "targetSdk", "compileSdk", "buildTools", "ndkVersion"]
  const missing = required.filter((key) => !versions[key])
  if (missing.length > 0) {
    throw new Error(`React Native's version catalog no longer names ${missing.join(", ")}.`)
  }
  return {
    minSdk: Number(versions.minSdk),
    targetSdk: Number(versions.targetSdk),
    compileSdk: Number(versions.compileSdk),
    buildTools: versions.buildTools,
    ndk: versions.ndkVersion,
  }
}

/**
 * sdkmanager package ids for a build, plus the emulator for device tests.
 * The emulator's system image is the AVD's business: any image of an AVD
 * the tests can boot will do.
 */
export function androidSdkPackages(requirements, { emulator = false } = {}) {
  const packages = [
    "platform-tools",
    `platforms;android-${requirements.compileSdk}`,
    `build-tools;${requirements.buildTools}`,
    `ndk;${requirements.ndk}`,
  ]
  if (emulator) packages.push("emulator")
  return packages
}

/** The image to create a test AVD from: the target SDK for this CPU, Google APIs, no Play Store needed. */
export function emulatorImage(requirements, hostArch = os.arch()) {
  const abi = hostArch === "arm64" ? "arm64-v8a" : "x86_64"
  return `system-images;android-${requirements.targetSdk};google_apis;${abi}`
}

/** Where an sdkmanager package id lives inside the SDK. */
export function sdkPackagePath(packageId) {
  return packageId.split(";").join(path.sep)
}

/** Path rules of the platform being resolved for, which tests pick freely. */
const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix)

// ---------------------------------------------------------------------------
// JDK
// ---------------------------------------------------------------------------

/** The major version in a JDK's `release` file (`JAVA_VERSION="17.0.17"` → 17, `"1.8.0_481"` → 8). */
export function javaMajorVersion(releaseText) {
  const match = /^JAVA_VERSION="([^"]+)"/m.exec(String(releaseText))
  if (!match) return null
  const [first, second] = match[1].split(/[._-]/).map(Number)
  return first === 1 ? second : first
}

/** Folders a JDK is commonly installed in, most specific first. */
export function jdkSearchRoots(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files"
    return ["Microsoft", "Eclipse Adoptium", "Java", "Amazon Corretto", "Zulu", "BellSoft", "Semeru"].map((vendor) =>
      path.win32.join(programFiles, vendor)
    )
  }
  if (platform === "darwin") return ["/Library/Java/JavaVirtualMachines"]
  return ["/usr/lib/jvm"]
}

function jdkHomeIn(folder, platform) {
  // macOS bundles keep the JDK under Contents/Home.
  return platform === "darwin" ? path.posix.join(folder, "Contents", "Home") : folder
}

/**
 * JDK 17: BETTERC0DE_JAVA_HOME if set (it must be 17), else JAVA_HOME when
 * it is 17, else the newest 17 found in the usual install folders.
 */
export function findJdk({ env = process.env, platform = process.platform, fsImpl = fs } = {}) {
  const join = pathFor(platform).join
  const version = (home) => {
    try {
      return javaMajorVersion(fsImpl.readFileSync(join(home, "release"), "utf8"))
    } catch {
      return null
    }
  }
  const explicit = env.BETTERC0DE_JAVA_HOME?.trim()
  if (explicit) {
    const found = version(explicit)
    if (found !== REQUIRED_JDK) {
      return { problem: `BETTERC0DE_JAVA_HOME (${explicit}) is ${found ? `JDK ${found}` : "not a JDK"}; it must be JDK ${REQUIRED_JDK}.` }
    }
    return { home: explicit, source: "BETTERC0DE_JAVA_HOME" }
  }
  const javaHome = env.JAVA_HOME?.trim()
  if (javaHome && version(javaHome) === REQUIRED_JDK) return { home: javaHome, source: "JAVA_HOME" }
  const candidates = []
  for (const searchRoot of jdkSearchRoots(platform, env)) {
    let names = []
    try {
      names = fsImpl.readdirSync(searchRoot)
    } catch {
      continue
    }
    for (const name of names) {
      const home = jdkHomeIn(join(searchRoot, name), platform)
      if (version(home) === REQUIRED_JDK) candidates.push(home)
    }
  }
  candidates.sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
  if (candidates.length > 0) return { home: candidates[0], source: "installed JDKs" }
  const other = javaHome ? ` JAVA_HOME points to JDK ${version(javaHome) ?? "?"}, which is not used.` : ""
  return {
    problem: `JDK ${REQUIRED_JDK} was not found.${other} Install one (for example Microsoft Build of OpenJDK 17 or Temurin 17), or set BETTERC0DE_JAVA_HOME.`,
  }
}

// ---------------------------------------------------------------------------
// Android SDK
// ---------------------------------------------------------------------------

export function androidSdkCandidates(env = process.env, platform = process.platform, home = os.homedir()) {
  const configured = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].map((value) => value?.trim()).filter(Boolean)
  const fallback =
    platform === "win32"
      ? path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"), "Android", "Sdk")
      : platform === "darwin"
        ? path.posix.join(home, "Library", "Android", "sdk")
        : path.posix.join(home, "Android", "Sdk")
  return [...new Set([...configured, fallback])]
}

const exe = (name, platform = process.platform) => (platform === "win32" ? `${name}.exe` : name)

export function findAndroidSdk({ env = process.env, platform = process.platform, fsImpl = fs } = {}) {
  for (const candidate of androidSdkCandidates(env, platform)) {
    if (fsImpl.existsSync(pathFor(platform).join(candidate, "platform-tools", exe("adb", platform)))) {
      return { root: candidate }
    }
  }
  return {
    problem:
      "The Android SDK was not found. Install Android Studio or the command-line tools, then set ANDROID_HOME (or ANDROID_SDK_ROOT) to the SDK folder.",
  }
}

/** Packages from `wanted` that the SDK folder does not contain. */
export function missingSdkPackages(sdkRoot, wanted, { fsImpl = fs } = {}) {
  return wanted.filter((packageId) => !fsImpl.existsSync(path.join(sdkRoot, sdkPackagePath(packageId))))
}

/** Command-line tools inside the SDK (and the JDK) that the build scripts call. */
export function androidTools(sdkRoot, javaHome, requirements, platform = process.platform) {
  const buildTools = path.join(sdkRoot, "build-tools", requirements.buildTools)
  return {
    adb: path.join(sdkRoot, "platform-tools", exe("adb", platform)),
    emulator: path.join(sdkRoot, "emulator", exe("emulator", platform)),
    aapt2: path.join(buildTools, exe("aapt2", platform)),
    // Run through the JDK directly: the .bat wrapper needs a shell on Windows.
    apksignerJar: path.join(buildTools, "lib", "apksigner.jar"),
    java: path.join(javaHome, "bin", exe("java", platform)),
    keytool: path.join(javaHome, "bin", exe("keytool", platform)),
  }
}

/** AVD names from `emulator -list-avds` (the emulator prints info lines too). */
export function parseAvdList(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(INFO|WARNING|ERROR)\b/.test(line) && !line.includes(" "))
}

/** The Android environment for a build: JDK 17, SDK, packages and tools, or what is missing. */
export function resolveAndroid({ emulator = false, env = process.env, platform = process.platform } = {}) {
  const problems = []
  const jdk = findJdk({ env, platform })
  if (jdk.problem) problems.push(jdk.problem)
  const sdk = findAndroidSdk({ env, platform })
  if (sdk.problem) problems.push(sdk.problem)
  let requirements = null
  try {
    requirements = androidRequirements()
  } catch (error) {
    problems.push(error.message)
  }
  let missing = []
  if (sdk.root && requirements) {
    missing = missingSdkPackages(sdk.root, androidSdkPackages(requirements, { emulator }))
    if (missing.length > 0) {
      problems.push(
        `The Android SDK lacks ${missing.join(", ")}. Install them with: sdkmanager ${missing.map((id) => `"${id}"`).join(" ")}`
      )
    }
  }
  if (problems.length > 0) return { problems }
  return {
    problems,
    javaHome: jdk.home,
    javaSource: jdk.source,
    sdkRoot: sdk.root,
    requirements,
    tools: androidTools(sdk.root, jdk.home, requirements, platform),
  }
}

/** Environment variables Gradle, the SDK tools and Maestro run with. */
export function androidEnv(android, env = process.env) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
  return {
    ...env,
    JAVA_HOME: android.javaHome,
    ANDROID_HOME: android.sdkRoot,
    ANDROID_SDK_ROOT: android.sdkRoot,
    [pathKey]: [
      path.join(android.javaHome, "bin"),
      path.join(android.sdkRoot, "platform-tools"),
      env[pathKey] ?? "",
    ].join(path.delimiter),
  }
}

// ---------------------------------------------------------------------------
// Maestro
// ---------------------------------------------------------------------------

export function readMaestroPin(file = MAESTRO_PIN_FILE) {
  const pin = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? "")) throw new Error(`${file}: "version" must be x.y.z.`)
  if (!/^https:\/\/github\.com\/mobile-dev-inc\/maestro\/releases\/download\//.test(pin.url ?? "")) {
    throw new Error(`${file}: "url" must be a Maestro release download.`)
  }
  if (!/^[0-9a-f]{64}$/.test(pin.sha256 ?? "")) throw new Error(`${file}: "sha256" must be 64 hex digits.`)
  return pin
}

export function maestroCacheRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.BETTERC0DE_MAESTRO_HOME?.trim()) return env.BETTERC0DE_MAESTRO_HOME.trim()
  const join = pathFor(platform).join
  const base =
    platform === "win32"
      ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "betterc0de")
      : platform === "darwin"
        ? join(home, "Library", "Caches", "betterc0de")
        : join(env.XDG_CACHE_HOME?.trim() || join(home, ".cache"), "betterc0de")
  return join(base, "maestro")
}

/** Maestro without usage analytics or its "Analyze with AI" banner. */
export const MAESTRO_ENV = {
  MAESTRO_CLI_NO_ANALYTICS: "1",
  MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
}

/** Arguments that run every flow on one device and keep a JUnit report and the debug output. */
export function maestroTestArgs(device, flowsDir, outputDir) {
  return [
    "--device",
    device,
    "test",
    flowsDir,
    "--format",
    "JUNIT",
    "--output",
    path.join(outputDir, "maestro-junit.xml"),
    "--debug-output",
    path.join(outputDir, "maestro"),
    "--flatten-debug-output",
  ]
}

/**
 * What adb says when it loses the device in the middle of a command: the
 * emulator's adbd dropped the connection ("connection terminated: write
 * failed") and took a moment to take a new one.
 */
const LOST_DEVICE = /device offline|device server died/i

function decodeXml(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
}

/** The error of the command a flow failed on, from its debug output. */
function failedCommandError(flowDebugDir) {
  let commands
  try {
    commands = JSON.parse(fs.readFileSync(path.join(flowDebugDir, "commands.json"), "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  const failed = commands.find((entry) => entry?.metadata?.status === "FAILED")
  const error = failed?.metadata?.error
  return typeof error === "string" ? error : typeof error?.message === "string" ? error.message : null
}

/**
 * The flows a Maestro run (maestroTestArgs) failed, from its JUnit report,
 * each with the error of the command it failed on and whether that was the
 * device dropping out rather than anything the flow checks.
 */
export function maestroFailures(outputDir) {
  const report = fs.readFileSync(path.join(outputDir, "maestro-junit.xml"), "utf8")
  const failures = []
  for (const match of report.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decodeXml(value)])
    )
    if (attributes.status === "SUCCESS") continue
    const junitMessage = decodeXml(/<failure[^>]*>([\s\S]*?)<\/failure>/.exec(match[2] ?? "")?.[1] ?? "").trim()
    const reason =
      failedCommandError(path.join(outputDir, "maestro", attributes.name ?? "")) ?? (junitMessage || "unknown")
    failures.push({
      name: attributes.name ?? "",
      file: attributes.file ?? "",
      reason,
      lostDevice: LOST_DEVICE.test(reason),
    })
  }
  return failures
}

export function maestroExecutable(installDir, platform = process.platform) {
  return path.join(installDir, "maestro", "bin", platform === "win32" ? "maestro.bat" : "maestro")
}

/**
 * The pinned Maestro, downloaded and verified on first use. A download
 * whose SHA-256 differs from the pin is deleted and fails.
 */
export async function ensureMaestro({ pin = readMaestroPin(), cacheRoot = maestroCacheRoot(), log = () => {} } = {}) {
  const installDir = path.join(cacheRoot, pin.version)
  const executable = maestroExecutable(installDir)
  const marker = path.join(installDir, ".verified-sha256")
  if (fs.existsSync(executable) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === pin.sha256) {
    return executable
  }
  fs.rmSync(installDir, { recursive: true, force: true })
  fs.mkdirSync(installDir, { recursive: true })
  log(`Downloading Maestro ${pin.version} from ${pin.url}`)
  const response = await fetch(pin.url)
  if (!response.ok) throw new Error(`Maestro download failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const actual = crypto.createHash("sha256").update(archive).digest("hex")
  if (actual !== pin.sha256) {
    fs.rmSync(installDir, { recursive: true, force: true })
    throw new Error(`Maestro ${pin.version} has SHA-256 ${actual}, expected ${pin.sha256}. Not installed.`)
  }
  extractZip(archive, installDir)
  fs.writeFileSync(marker, `${pin.sha256}\n`)
  if (!fs.existsSync(executable)) throw new Error(`The Maestro archive has no ${path.relative(installDir, executable)}.`)
  return executable
}

/** Extracts a ZIP archive, refusing entries that would land outside `target`. */
export function extractZip(archive, target) {
  const resolvedTarget = path.resolve(target)
  for (const entry of readZipEntries(archive)) {
    const destination = path.resolve(resolvedTarget, entry.name)
    if (destination !== resolvedTarget && !destination.startsWith(resolvedTarget + path.sep)) {
      throw new Error(`The archive entry ${entry.name} points outside the target folder.`)
    }
    if (entry.name.endsWith("/")) {
      fs.mkdirSync(destination, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, readZipEntry(archive, entry))
    const executable = (entry.unixMode & 0o111) !== 0 || /\/bin\/[^/.]+$/.test(entry.name)
    if (process.platform !== "win32" && executable) fs.chmodSync(destination, 0o755)
  }
}

// ---------------------------------------------------------------------------
// iOS (macOS only)
// ---------------------------------------------------------------------------

export const MINIMUM_XCODE = 26

/** `xcodebuild -version` → 26 for "Xcode 26.0.1". */
export function parseXcodeMajor(text) {
  const match = /^Xcode (\d+)(?:\.\d+)*/m.exec(String(text))
  return match ? Number(match[1]) : null
}

export function resolveIos({ platform = process.platform, run = capture } = {}) {
  if (platform !== "darwin") return { problems: ["iOS builds need macOS with Xcode."] }
  const problems = []
  const xcode = parseXcodeMajor(run("xcodebuild", ["-version"]))
  if (xcode === null) problems.push("Xcode is not installed or not selected (xcode-select -s /Applications/Xcode.app).")
  else if (xcode < MINIMUM_XCODE) problems.push(`Xcode ${xcode} is too old; the app is built with Xcode ${MINIMUM_XCODE} or newer.`)
  if (!run("pod", ["--version"])) problems.push("CocoaPods is not installed (brew install cocoapods).")
  return { problems, xcode }
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  return result.status === 0 ? result.stdout : ""
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  if (argv.includes("--sdk-packages")) {
    process.stdout.write(`packages=${androidSdkPackages(androidRequirements(), { emulator: true }).join(" ")}\n`)
    return 0
  }
  const wanted = argv.filter((arg) => !arg.startsWith("-"))
  const platforms = wanted.length > 0 ? wanted : process.platform === "darwin" ? ["android", "ios"] : ["android"]
  let failed = false
  if (platforms.includes("android")) {
    const android = resolveAndroid({ emulator: true })
    if (android.problems.length > 0) {
      failed = true
      for (const problem of android.problems) process.stdout.write(`  missing  ${problem}\n`)
    } else {
      process.stdout.write(`  ok       JDK 17 at ${android.javaHome} (${android.javaSource})\n`)
      process.stdout.write(`  ok       Android SDK at ${android.sdkRoot}\n`)
      process.stdout.write(`  ok       ${androidSdkPackages(android.requirements, { emulator: true }).join(", ")}\n`)
      const avds = parseAvdList(capture(android.tools.emulator, ["-list-avds"]))
      const avd = process.env.BETTERC0DE_AVD?.trim() || DEFAULT_AVD
      if (avds.includes(avd)) {
        process.stdout.write(`  ok       emulator ${avd}\n`)
      } else {
        failed = true
        process.stdout.write(
          `  missing  emulator ${avd}. Create it: avdmanager create avd -n ${avd} -k "${emulatorImage(android.requirements)}"\n`
        )
      }
    }
  }
  if (platforms.includes("ios")) {
    const ios = resolveIos()
    if (ios.problems.length > 0) failed = true
    for (const problem of ios.problems) process.stdout.write(`  missing  ${problem}\n`)
    if (ios.problems.length === 0) process.stdout.write(`  ok       Xcode ${ios.xcode}, CocoaPods\n`)
  }
  if (argv.includes("--maestro")) {
    const executable = await ensureMaestro({ log: (line) => process.stdout.write(`  ${line}\n`) })
    process.stdout.write(`  ok       Maestro at ${executable}\n`)
  } else {
    process.stdout.write(`  info     Maestro ${readMaestroPin().version} is downloaded on first use (--maestro to fetch it now)\n`)
  }
  return failed ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
  )
}
