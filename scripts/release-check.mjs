#!/usr/bin/env node

// The single gate a commit passes before it can be released:
//
//   preflight → clean install from the lockfile → workspace versions →
//   formatting → lint → type-check → tests → production build →
//   package → packaged-app smoke → installers → installer smoke
//
// It runs the same steps locally, in the pre-push hook for release tags, and
// in CI on every supported platform, and exits non-zero on the first
// failure. Only Node built-ins are imported here: the install step deletes
// and recreates node_modules while this script is running.
//
//   npm run release:check                    full gate for this OS and CPU
//   npm run release:check -- --until build   stop after a step (Node matrix)
//   npm run release:check -- --list          show the steps
//
// A run that skips anything (--skip-install, --from, --until, or the
// installer smoke outside CI) says so in its summary and does not count as
// a full release check.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)

const PLATFORM_FLAGS = { win32: "--win", darwin: "--mac", linux: "--linux" }
const RUNNER_OS_NAMES = { win32: "Windows", darwin: "macOS", linux: "Linux" }
const SIGNING_ENV = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_INSTALLER_LINK",
  "CSC_INSTALLER_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
]

export const STEP_IDS = [
  "preflight",
  "install",
  "versions",
  "format",
  "lint",
  "typecheck",
  "test",
  "build",
  "package",
  "smoke",
  "installers",
  "installer-smoke",
]

// ---------------------------------------------------------------------------
// Version handling (no dependencies: node_modules may not exist yet)
// ---------------------------------------------------------------------------

export function parseVersion(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return match.slice(1, 4).map(Number)
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * Supports the range forms used in package.json `engines`: `||` between
 * alternatives, and `^x.y.z`, `>=`, `>`, `<=`, `<`, `=` or a bare version
 * inside each alternative (space-separated comparators must all hold).
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version)
  if (!parsed) return false
  return String(range)
    .split("||")
    .some((alternative) => {
      const comparators = alternative.trim().split(/\s+/).filter(Boolean)
      if (comparators.length === 0) return false
      return comparators.every((comparator) => {
        const match = comparator.match(/^(\^|>=|<=|>|<|=)?(v?\d+(?:\.\d+){0,2})$/)
        if (!match) throw new Error(`Unsupported version range: ${comparator}`)
        const [, operator = "=", raw] = match
        const [major = 0, minor = 0, patch = 0] = raw.replace(/^v/, "").split(".").map(Number)
        const bound = [major, minor, patch]
        const order = compareVersions(parsed, bound)
        switch (operator) {
          case "^":
            return order >= 0 && parsed[0] === major
          case ">=":
            return order >= 0
          case ">":
            return order > 0
          case "<=":
            return order <= 0
          case "<":
            return order < 0
          default:
            return order === 0
        }
      })
    })
}

/**
 * Judges the running Node against the exact pin in .nvmrc and the supported
 * range in `engines`. Outside the range is always an error. Inside the range
 * but off the pin is an error only when `strict` (CI building release
 * artifacts, which must come from the pinned toolchain) and a warning
 * otherwise, e.g. for the CI leg that checks the next Node LTS.
 */
export function assessNodeVersion({ current, pinned, engines, strict }) {
  if (!satisfiesRange(current, engines)) {
    return {
      level: "error",
      message: `Node ${current} is outside the supported range ${engines}. Install Node ${pinned} (see .nvmrc).`,
    }
  }
  const [pinnedVersion, currentVersion] = [parseVersion(pinned), parseVersion(current)]
  if (pinnedVersion && currentVersion && compareVersions(pinnedVersion, currentVersion) === 0) {
    return { level: "ok", message: `Node ${current} matches .nvmrc.` }
  }
  return {
    level: strict ? "error" : "warn",
    message: `Node ${current} is supported, but releases are built with ${pinned} (.nvmrc). Use ${pinned} for a release build.`,
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export function parseOptions(argv, env = process.env) {
  const options = {
    arch: process.arch,
    from: null,
    until: null,
    skipInstall: false,
    installerSmoke: env.CI === "true" || env.CI === "1",
    list: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    if (arg === "--arch") options.arch = value()
    else if (arg === "--from") options.from = value()
    else if (arg === "--until") options.until = value()
    else if (arg === "--skip-install") options.skipInstall = true
    else if (arg === "--installer-smoke") options.installerSmoke = true
    else if (arg === "--no-installer-smoke") options.installerSmoke = false
    else if (arg === "--list") options.list = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  for (const key of ["from", "until"]) {
    if (options[key] && !STEP_IDS.includes(options[key])) {
      throw new Error(`--${key} must be one of: ${STEP_IDS.join(", ")}`)
    }
  }
  if (options.from && options.until && STEP_IDS.indexOf(options.from) > STEP_IDS.indexOf(options.until)) {
    throw new Error("--from must not come after --until")
  }
  if (options.arch !== "x64" && options.arch !== "arm64") {
    throw new Error(`--arch must be x64 or arm64, not ${options.arch}`)
  }
  return options
}

/** Which steps run, and why each of the others does not. */
export function planSteps(options) {
  const fromIndex = options.from ? STEP_IDS.indexOf(options.from) : 0
  const untilIndex = options.until ? STEP_IDS.indexOf(options.until) : STEP_IDS.length - 1
  return STEP_IDS.map((id, index) => {
    // Preflight is cheap and guards every other step, so it always runs.
    if (id === "preflight") return { id, run: true }
    if (index < fromIndex) return { id, run: false, reason: `before --from ${options.from}` }
    if (index > untilIndex) return { id, run: false, reason: `after --until ${options.until}` }
    if (id === "install" && options.skipInstall) return { id, run: false, reason: "--skip-install" }
    if (id === "installer-smoke" && !options.installerSmoke) {
      return {
        id,
        run: false,
        reason: "changes the host (registry, packages); runs on clean CI runners, or pass --installer-smoke",
      }
    }
    return { id, run: true }
  })
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function resolveNpmCli() {
  const fromEnv = process.env.npm_execpath
  if (fromEnv && /npm-cli\.js$/.test(fromEnv) && fs.existsSync(fromEnv)) return fromEnv
  const nodeDir = path.dirname(process.execPath)
  return (
    [
      path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ].find((candidate) => fs.existsSync(candidate)) ?? null
  )
}

const npmCli = resolveNpmCli()

function run(command, args, { env = {}, label } = {}) {
  const display = label ?? [command, ...args].join(" ")
  process.stdout.write(`\n$ ${display}\n`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
    // npm/npx shims on Windows are .cmd files, which need a shell. Node
    // scripts are always started through process.execPath instead.
    shell: process.platform === "win32" && command !== process.execPath,
  })
  if (result.error) throw new Error(`${display} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${display} failed (${result.status ?? result.signal})`)
  }
}

function npm(args, options = {}) {
  if (npmCli) run(process.execPath, [npmCli, ...args], { ...options, label: `npm ${args.join(" ")}` })
  else run("npm", args, options)
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32" && command !== process.execPath,
  })
  return result.error || result.status !== 0 ? null : result.stdout.trim()
}

function hasCommand(command) {
  const probe = process.platform === "win32" ? ["where", [command]] : ["sh", ["-c", `command -v ${command}`]]
  return spawnSync(probe[0], probe[1], { stdio: "ignore" }).status === 0
}

/** Missing optional signing secrets arrive from CI as empty strings. */
function signingEnv() {
  const env = { ...process.env }
  for (const name of SIGNING_ENV) {
    if (env[name] === "") delete env[name]
  }
  return env
}

function electronBuilder(args) {
  const cli = require.resolve("electron-builder/out/cli/cli.js", { paths: [root] })
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: "inherit",
    env: signingEnv(),
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`electron-builder ${args.join(" ")} failed (${result.status ?? result.signal})`)
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"))
}

function preflight(plan, options) {
  const ci = process.env.CI === "true" || process.env.CI === "1"
  const manifest = readJson("package.json")
  const pinned = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim()
  const problems = []
  const note = (level, message) => {
    process.stdout.write(`  ${level === "ok" ? "ok  " : level === "warn" ? "WARN" : "FAIL"} ${message}\n`)
    if (level === "error") problems.push(message)
  }

  const runs = (id) => plan.find((step) => step.id === id)?.run
  const nodeCheck = assessNodeVersion({
    current: process.version,
    pinned,
    engines: manifest.engines.node,
    strict: ci && Boolean(runs("package") || runs("installers")),
  })
  note(nodeCheck.level, nodeCheck.message)

  const npmVersion = npmCli ? capture(process.execPath, [npmCli, "--version"]) : capture("npm", ["--version"])
  if (!npmVersion) note("error", "npm is not available.")
  else if (!satisfiesRange(npmVersion, manifest.engines.npm)) {
    note("error", `npm ${npmVersion} is outside the supported range ${manifest.engines.npm}.`)
  } else note("ok", `npm ${npmVersion}.`)

  if (!hasCommand("git")) note("error", "git is not on PATH.")
  else note("ok", "git is available.")

  if (!PLATFORM_FLAGS[process.platform]) {
    note("error", `Packaging is not configured for ${process.platform}.`)
  }
  if (options.arch !== process.arch) {
    note(
      "warn",
      `Packaging ${options.arch} on a ${process.arch} host: native modules are cross-compiled and the smoke test depends on emulation.`
    )
  }

  if (process.platform === "linux") {
    if ((runs("smoke") || runs("installer-smoke")) && !hasCommand("xvfb-run")) {
      note("error", "xvfb-run is missing; the packaged-app smoke needs a virtual display. Install it: sudo apt-get install -y xvfb")
    }
    if (runs("installers") && !hasCommand("rpmbuild")) {
      note("error", "rpmbuild is missing; electron-builder needs it for the .rpm target. Install it: sudo apt-get install -y rpm")
    }
  }
  if (process.platform === "darwin" && !capture("xcode-select", ["-p"])) {
    note("warn", "Xcode Command Line Tools are not installed; native modules without a prebuilt binary cannot compile. Run: xcode-select --install")
  }

  if (problems.length > 0) {
    throw new Error(`Preflight found ${problems.length} problem(s); fix them before running the release check.`)
  }
}

function smokeResultFile() {
  return path.join(root, "release", "packaged-smoke.json")
}

function readSmokeResult() {
  const file = smokeResultFile()
  if (!fs.existsSync(file)) {
    throw new Error(`No verified unpacked build found (${path.relative(root, file)}). Run the package and smoke steps first.`)
  }
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function makeSteps(options) {
  const platformFlag = PLATFORM_FLAGS[process.platform]
  const archFlag = `--${options.arch}`
  let nativeModulesRebuiltForElectron = false

  return {
    state: () => ({ nativeModulesRebuiltForElectron }),
    steps: {
      install: () => npm(["ci", "--no-audit", "--no-fund"]),
      versions: () => npm(["run", "check:versions"]),
      format: () => npm(["run", "format:check"]),
      lint: () => npm(["run", "lint"]),
      typecheck: () => {
        // The shared schema's declarations are an input to the UI and mobile
        // type-checks, so the schema and backend are compiled first.
        npm(["run", "build:backend"])
        for (const script of ["typecheck", "typecheck:backend", "typecheck:shell", "typecheck:mobile", "typecheck:remotion"]) {
          npm(["run", script])
        }
      },
      test: () => {
        for (const script of ["test:packaging", "test", "test:backend", "test:mobile"]) {
          npm(["run", script])
        }
      },
      build: () => {
        // Vite's production bundle can exceed Node's default heap while
        // rendering the Monaco worker chunks on hosted macOS runners.
        const nodeOptions = [process.env.NODE_OPTIONS, "--max-old-space-size=4096"].filter(Boolean).join(" ")
        npm(["run", "build"], { env: { NODE_OPTIONS: nodeOptions } })
        npm(["run", "perf:backend"])
        npm(["run", "export:web", "--workspace", "@betterc0de/mobile"], { env: { EXPO_NO_TELEMETRY: "1" } })
      },
      package: () => {
        nativeModulesRebuiltForElectron = true
        npm(["run", "backend:rebuild", "--", "--arch", options.arch])
        fs.rmSync(path.join(root, "release"), { recursive: true, force: true })
        const { buildSigningMetadataArgs } = require(path.join(root, "scripts", "pack-electron.cjs"))
        electronBuilder([platformFlag, archFlag, "--dir", "--publish", "never", ...buildSigningMetadataArgs(signingEnv())])
        npm(["run", "audit:package-size"])
      },
      smoke: () => {
        fs.rmSync(smokeResultFile(), { force: true })
        run(process.execPath, [path.join(root, "scripts", "packaged-startup-smoke.mjs")], {
          env: { PACKAGED_SMOKE_OUTPUT: smokeResultFile() },
          label: "node scripts/packaged-startup-smoke.mjs",
        })
      },
      installers: () => {
        const { packageRoot } = readSmokeResult()
        // Build installers from the exact app the smoke test launched.
        electronBuilder([platformFlag, archFlag, "--prepackaged", packageRoot, "--publish", "never"])
        npm(["run", "release:checksums"], {
          env: { CHECKSUM_FILE: `SHA256SUMS-${RUNNER_OS_NAMES[process.platform]}-${options.arch}.txt` },
        })
      },
      "installer-smoke": () =>
        run(process.execPath, [path.join(root, "scripts", "installer-smoke.mjs"), "--arch", options.arch], {
          label: `node scripts/installer-smoke.mjs --arch ${options.arch}`,
        }),
    },
    restoreNodeNativeModules: () => npm(["rebuild", "better-sqlite3"]),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: npm run release:check -- [options]",
      "",
      "  --arch <x64|arm64>      target CPU architecture (default: this machine's)",
      "  --until <step>          stop after <step>",
      "  --from <step>           start at <step> (reuses earlier results)",
      "  --skip-install          reuse the current node_modules",
      "  --installer-smoke       install/launch/uninstall the installers on this machine",
      "  --no-installer-smoke    skip that even in CI",
      "  --list                  print the steps and exit",
      "",
      `Steps: ${STEP_IDS.join(" → ")}`,
      "",
    ].join("\n")
  )
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseOptions(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n`)
    printUsage()
    return 2
  }
  if (options.help) {
    printUsage()
    return 0
  }

  const plan = planSteps(options)
  if (options.list) {
    for (const step of plan) {
      process.stdout.write(`${step.run ? "run " : "skip"}  ${step.id}${step.reason ? `  (${step.reason})` : ""}\n`)
    }
    return 0
  }

  const { steps, state, restoreNodeNativeModules } = makeSteps(options)
  const results = []
  const startedAt = Date.now()
  let failure = null

  process.stdout.write(
    `release:check for ${process.platform}-${options.arch} on Node ${process.version} (${os.cpus().length} CPUs)\n`
  )
  try {
    for (const step of plan) {
      if (!step.run) {
        results.push({ id: step.id, status: "skipped", detail: step.reason })
        continue
      }
      process.stdout.write(`\n${"=".repeat(72)}\n▶ ${step.id}\n${"=".repeat(72)}\n`)
      const stepStart = Date.now()
      try {
        if (step.id === "preflight") preflight(plan, options)
        else steps[step.id]()
        results.push({ id: step.id, status: "passed", ms: Date.now() - stepStart })
      } catch (error) {
        failure = { id: step.id, error }
        results.push({ id: step.id, status: "FAILED", ms: Date.now() - stepStart, detail: error.message })
        break
      }
    }
  } finally {
    if (state().nativeModulesRebuiltForElectron) {
      // Packaging rebuilt better-sqlite3 for Electron's ABI; put the local
      // Node build back so tests and `npm run dev` keep working afterwards.
      try {
        restoreNodeNativeModules()
      } catch (error) {
        process.stderr.write(`Could not restore the Node build of better-sqlite3: ${error.message}\n`)
        failure ??= { id: "restore native modules", error }
      }
    }
  }

  for (const step of plan.slice(results.length)) {
    results.push({ id: step.id, status: "not run" })
  }

  process.stdout.write(`\n${"=".repeat(72)}\nrelease:check summary (${formatDuration(Date.now() - startedAt)})\n`)
  for (const result of results) {
    const time = result.ms === undefined ? "" : formatDuration(result.ms)
    process.stdout.write(
      `  ${result.status.padEnd(8)} ${result.id.padEnd(16)} ${time.padStart(7)}${result.detail ? `  ${result.detail}` : ""}\n`
    )
  }
  const skipped = results.filter((result) => result.status === "skipped")
  if (failure) {
    process.stdout.write(`\nRELEASE CHECK FAILED at "${failure.id}".\n`)
    return 1
  }
  if (skipped.length > 0) {
    process.stdout.write(
      `\nRELEASE CHECK PASSED for the steps that ran. Skipped: ${skipped.map((result) => result.id).join(", ")}.\n`
    )
  } else {
    process.stdout.write("\nRELEASE CHECK PASSED (all steps).\n")
  }
  return 0
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry
}

if (isEntryPoint()) {
  process.exitCode = await main()
}
