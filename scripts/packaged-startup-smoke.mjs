import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { access, appendFile, mkdtemp, readdir, stat, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  findPackagedExecutableFiles,
  parseDevToolsWebSocketUrl,
  removeDirectoryWithRetries,
  selectRendererTarget,
  taskkillOutcome,
  validateRendererSnapshot,
} from "./packaged-smoke-helpers.mjs"

const require = createRequire(import.meta.url)
const { listPackage } = require("@electron/asar")

const root = path.resolve(import.meta.dirname, "..")
const releaseDir = path.resolve(root, process.env.PACKAGE_RELEASE_DIR || "release")
// PACKAGED_EXECUTABLE launches one specific binary (an installed app, an
// AppImage) instead of searching release/ for the unpacked build.
const explicitExecutable = process.env.PACKAGED_EXECUTABLE
  ? path.resolve(process.env.PACKAGED_EXECUTABLE)
  : null
// Linux smoke runs pass --no-sandbox by default because an unpacked build's
// chrome-sandbox is not setuid root. An installed .deb ships an AppArmor
// profile and must start with the sandbox, the way users launch it.
const keepLinuxSandbox = process.env.PACKAGED_SANDBOX === "1"
const startupTimeoutMs = 30_000
const stabilityWindowMs = 2_000
const childExitTimeoutMs = 5_000
const gracefulExitTimeoutMs = 10_000
const taskkillTimeoutMs = 5_000
const defaultBackendPorts = [3773, 3774, 3775, 3776]
const packaged = explicitExecutable
  ? await describePackagedExecutable(explicitExecutable)
  : await findPackagedApplication(releaseDir)
let stdout = ""
let stderr = ""
let successMessage = null

if (packaged.resourcesDir) await validatePackageStructure(packaged)

const preexistingBackend = await findHealthyBackend(defaultBackendPorts)
if (preexistingBackend) {
  throw new Error(
    `Refusing a false-positive package smoke: BetterC0de health already responds on port ${preexistingBackend.port}.`
  )
}

const dataDir = await mkdtemp(
  path.join(os.tmpdir(), "betterc0de-package-smoke-")
)
const command = process.platform === "linux" ? "xvfb-run" : packaged.executable
const args =
  process.platform === "linux"
    ? [
        "-a",
        packaged.executable,
        ...(keepLinuxSandbox ? [] : ["--no-sandbox"]),
        `--user-data-dir=${dataDir}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
      ]
    : [
        `--user-data-dir=${dataDir}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
      ]
let child = null
let appExitedOnItsOwn = false

try {
  child = spawn(command, args, {
    cwd: path.dirname(packaged.executable),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      BETTERC0DE_BACKEND: "node-spawn",
      BETTERC0DE_HOME: dataDir,
      BETTERC0DE_DATA_DIR: dataDir,
      BETTERC0DE_PROVIDER_SESSION_REAPER: "0",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  child.stdout?.on("data", (chunk) => {
    stdout = appendDiagnosticTail(stdout, chunk)
  })
  child.stderr?.on("data", (chunk) => {
    stderr = appendDiagnosticTail(stderr, chunk)
  })
  child.once("error", (error) => {
    stderr = appendDiagnosticTail(
      stderr,
      `\npackaged launch failed: ${error.message}\n`
    )
  })

  const health = await waitForPackagedReady(child, () => ({ stdout, stderr }))
  const renderer = await waitForRendererReady(child, () => ({ stdout, stderr }))
  await assertStableAfterReady(child, () => ({ stdout, stderr }))
  if (!explicitExecutable) {
    await publishPrepackagedPath(packaged.packageRoot)
    await writeSmokeResult(packaged)
  }
  successMessage = `Packaged startup smoke passed: ${path.relative(root, packaged.executable)}; backend health ready on port ${health.port}; renderer mounted at ${renderer.url}.\n`
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  )
  if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`)
  process.exitCode = 1
} finally {
  const cleanupFailures = []
  if (child) {
    // Quit the app itself first, the way a session shutdown does, while its
    // display (Xvfb on Linux) is still up. Signalling only the launcher's
    // process group tore the display down under the app and never reached
    // the backend, which runs in its own group: on Linux CI the app, its
    // crash handler and the backend all outlived the smoke, and the backend
    // kept port 3773.
    try {
      await stopPackageProcesses(packaged)
    } catch (error) {
      cleanupFailures.push(error)
    }
    try {
      await stopChildTree(child)
    } catch (error) {
      cleanupFailures.push(error)
    }
    // Anything that still holds the inherited stdout/stderr must not keep
    // this script alive after the verdict.
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  try {
    await removeDirectoryWithRetries(dataDir)
  } catch (error) {
    cleanupFailures.push(error)
  }
  if (appExitedOnItsOwn) {
    process.stdout.write(
      `WARNING: the app exited on its own (code ${child?.exitCode ?? "null"}, signal ${child?.signalCode ?? "none"}) before the smoke stopped it. Its last output:\n${diagnosticTail()}\n`
    )
  }
  if (cleanupFailures.length > 0) {
    process.stderr.write(`Cleanup failed. The app's last output:\n${diagnosticTail()}\n`)
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) {
    throw new AggregateError(
      cleanupFailures,
      "Packaged smoke process and profile cleanup failed"
    )
  }
}

if (successMessage) process.stdout.write(successMessage)

async function describePackagedExecutable(executable) {
  const executableStats = await stat(executable)
  if (!executableStats.isFile()) {
    throw new Error(`PACKAGED_EXECUTABLE is not a file: ${executable}`)
  }
  if (process.platform !== "win32") {
    await access(executable, fsConstants.X_OK)
  }
  // An AppImage is a single self-mounting file; its app.asar only exists
  // once the runtime has extracted it, so there is no structure to inspect.
  if (/\.appimage$/i.test(executable)) {
    return { executable, packageRoot: path.dirname(executable), resourcesDir: null }
  }
  const packageRoot = packagedRootForExecutable(executable)
  return {
    executable,
    packageRoot,
    resourcesDir:
      process.platform === "darwin"
        ? path.join(packageRoot, "Contents", "Resources")
        : path.join(packageRoot, "resources"),
  }
}

async function findPackagedApplication(directory) {
  const files = await walk(directory)
  const matches = await findPackagedExecutableFiles(files, process.platform)
  if (matches.length === 0) {
    throw new Error(`No packaged executable found below ${directory}`)
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one unpacked application below ${directory}, found ${matches.length}. Split architecture builds so every published package is smoked independently.`
    )
  }
  const [match] = matches
  if (process.platform !== "win32") {
    await access(match, fsConstants.X_OK)
  }

  const packageRoot = packagedRootForExecutable(match)
  return {
    executable: match,
    packageRoot,
    resourcesDir:
      process.platform === "darwin"
        ? path.join(packageRoot, "Contents", "Resources")
        : path.join(packageRoot, "resources"),
  }
}

function packagedRootForExecutable(executable) {
  if (process.platform !== "darwin") return path.dirname(executable)
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`
  const markerIndex = executable.lastIndexOf(marker)
  if (markerIndex <= 0) {
    throw new Error(`Could not resolve the macOS app bundle for ${executable}`)
  }
  return executable.slice(0, markerIndex)
}

async function validatePackageStructure(packaged) {
  const executableStats = await stat(packaged.executable)
  if (!executableStats.isFile() || executableStats.size === 0) {
    throw new Error("Packaged executable is missing or empty.")
  }

  const asarPath = path.join(packaged.resourcesDir, "app.asar")
  const asarStats = await stat(asarPath)
  if (!asarStats.isFile() || asarStats.size < 1024) {
    throw new Error("Packaged app.asar is missing or unexpectedly small.")
  }

  // Listing the archive validates its header without extracting or executing
  // application code. These entries prove that both renderer and backend
  // build outputs used by the packaged app are present in the exact archive
  // that will later be handed to electron-builder via --prepackaged.
  const entries = new Set(
    listPackage(asarPath, { isPack: false }).map((entry) =>
      entry.replaceAll("\\", "/").replace(/^\/+/, "")
    )
  )
  for (const expected of [
    "apps/ui/dist/index.html",
    "apps/backend/dist/index.js",
    "apps/backend/package.json",
  ]) {
    if (!entries.has(expected)) {
      throw new Error(`Packaged archive is missing required asset: ${expected}`)
    }
  }
}

async function waitForPackagedReady(processHandle, diagnostics) {
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    assertProcessHealthy(processHandle, diagnostics())
    const readyPort = parseReadyPort(diagnostics())
    const candidates = readyPort
      ? [readyPort, ...defaultBackendPorts.filter((port) => port !== readyPort)]
      : defaultBackendPorts
    const health = await findHealthyBackend(candidates)
    if (health) return health
    await delay(250)
  }
  throw new Error(
    `Packaged application did not expose a healthy BetterC0de backend within ${startupTimeoutMs}ms.`
  )
}

async function assertStableAfterReady(processHandle, diagnostics) {
  const deadline = Date.now() + stabilityWindowMs
  while (Date.now() < deadline) {
    assertProcessHealthy(processHandle, diagnostics())
    await delay(100)
  }
}

async function waitForRendererReady(processHandle, diagnostics) {
  const deadline = Date.now() + startupTimeoutMs
  let lastReason = "Chromium DevTools endpoint was not announced"
  while (Date.now() < deadline) {
    const currentDiagnostics = diagnostics()
    assertProcessHealthy(processHandle, currentDiagnostics)
    const browserEndpoint = parseDevToolsWebSocketUrl(
      `${currentDiagnostics.stdout}\n${currentDiagnostics.stderr}`
    )
    if (!browserEndpoint) {
      await delay(100)
      continue
    }
    try {
      const endpoint = new URL(browserEndpoint)
      const response = await fetch(
        `http://${endpoint.hostname}:${endpoint.port}/json/list`,
        { signal: AbortSignal.timeout(1_000) }
      )
      if (!response.ok) {
        lastReason = `DevTools target list returned HTTP ${response.status}`
        await delay(100)
        continue
      }
      const target = selectRendererTarget(await response.json())
      if (!target) {
        lastReason = "no non-blank renderer page target is available"
        await delay(100)
        continue
      }
      const snapshot = await evaluateRendererSnapshot(
        target.webSocketDebuggerUrl
      )
      const verdict = validateRendererSnapshot(snapshot)
      if (verdict.ok) return snapshot
      lastReason = verdict.reason
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new Error(
    `Packaged renderer did not mount successfully within ${startupTimeoutMs}ms: ${lastReason}`
  )
}

function evaluateRendererSnapshot(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") {
    throw new Error(
      "Node.js runtime does not provide the WebSocket API required for CDP"
    )
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    const requestId = 1
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error("CDP renderer evaluation timed out"))
    }, 2_000)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // The target may have disappeared while startup was still settling.
      }
      if (error) reject(error)
      else resolve(value)
    }

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: {
            expression: `(() => ({
              readyState: document.readyState,
              title: document.title,
              url: location.href,
              rootChildCount: document.getElementById("root")?.childElementCount ?? -1
            }))()`,
            returnByValue: true,
          },
        })
      )
    })
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data))
        if (message.id !== requestId) return
        if (message.error) {
          finish(
            new Error(`CDP Runtime.evaluate failed: ${message.error.message}`)
          )
          return
        }
        if (message.result?.exceptionDetails) {
          finish(new Error("renderer evaluation raised an exception"))
          return
        }
        finish(null, message.result?.result?.value)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.addEventListener("error", () => {
      finish(new Error("CDP renderer connection failed"))
    })
  })
}

function assertProcessHealthy(processHandle, diagnostics) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    throw new Error(
      `packaged application exited during startup (code ${processHandle.exitCode ?? "null"}, signal ${processHandle.signalCode ?? "none"})`
    )
  }
  const fatal = fatalDiagnostic(diagnostics)
  if (fatal)
    throw new Error(`Packaged application emitted a fatal diagnostic: ${fatal}`)
}

function fatalDiagnostic({ stdout: out, stderr: err }) {
  const text = `${out}\n${err}`
  const patterns = [
    /uncaught exception/i,
    /unhandled(?: promise)? rejection/i,
    /cannot find module/i,
    /ERR_(?:FILE_NOT_FOUND|MODULE_NOT_FOUND)/i,
    /failed to load (?:resource|url|renderer)/i,
    /renderer process (?:crashed|gone)/i,
    /backend exited before ready/i,
    /packaged launch failed/i,
    /"status"\s*:\s*"error"/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match || match.index === undefined) continue
    const lineStart = text.lastIndexOf("\n", match.index) + 1
    const lineEnd = text.indexOf("\n", match.index)
    return text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim()
  }
  return null
}

function parseReadyPort({ stdout: out, stderr: err }) {
  for (const line of `${out}\n${err}`.split(/\r?\n/)) {
    if (!line.includes('"status"') || !line.includes('"ready"')) continue
    try {
      const message = JSON.parse(line.trim())
      if (
        message?.status === "ready" &&
        Number.isSafeInteger(message.port) &&
        message.port > 0 &&
        message.port <= 65_535
      ) {
        return message.port
      }
    } catch {
      // Structured log lines can contain non-JSON prefixes. Health polling
      // remains the authoritative fallback for packaged Electron startup.
    }
  }
  return null
}

async function findHealthyBackend(ports) {
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(750),
      })
      if (!response.ok) continue
      const body = await response.json()
      if (body?.status === "ok" && body?.db === "ok") return { port, body }
    } catch {
      // Not ready on this candidate port yet.
    }
  }
  return null
}

// release:check hands the verified unpacked build to the installer step
// through this file; CI jobs use the GITHUB_OUTPUT value below.
async function writeSmokeResult({ executable, packageRoot }) {
  const outputFile = process.env.PACKAGED_SMOKE_OUTPUT
  if (!outputFile) return
  await writeFile(
    outputFile,
    `${JSON.stringify({ executable, packageRoot }, null, 2)}
`,
    "utf8"
  )
}

/** Processes started from the package: the app, its helpers and backend. */
function packageProcessIds({ packageRoot, executable }) {
  const listing = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
  if (listing.status !== 0) return []
  const markers = [packageRoot, executable, "/tmp/appimage_extracted_", "/tmp/.mount_"]
  const processes = []
  for (const line of listing.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match) continue
    const [, pid, args] = match
    // The display server and its wrapper go last, after the app has quit.
    if (/\bxvfb-run\b|\bXvfb\b/.test(args)) continue
    if (Number(pid) === process.pid || args.includes("packaged-startup-smoke")) continue
    if (markers.some((marker) => args.includes(marker))) {
      processes.push({ pid: Number(pid), args: args.slice(0, 200) })
    }
  }
  return processes
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

function signalPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Exited between listing and signalling.
    }
  }
}

async function waitForPidsExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let alive = pids.filter(isPidAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(200)
    alive = alive.filter(isPidAlive)
  }
  return alive
}

/**
 * Quits the app the way a session shutdown does: SIGTERM to the main process
 * only (renderer or GPU helpers killed first would raise the app's
 * "renderer process gone" dialog), which then stops its helpers and backend.
 * Whatever is still running after the graceful window is reported and
 * killed; anything that survives SIGKILL fails the smoke, because the next
 * launch would meet a stale backend.
 */
async function stopPackageProcesses(packaged) {
  if (process.platform === "win32") return // taskkill /T covers the whole tree.
  const mains = packageProcessIds(packaged).filter(
    (entry) => entry.args.includes("--remote-debugging-port") && !entry.args.includes("--type=")
  )
  if (mains.length > 0) {
    signalPids(mains.map((entry) => entry.pid), "SIGTERM")
    const deadline = Date.now() + gracefulExitTimeoutMs
    while (Date.now() < deadline && packageProcessIds(packaged).length > 0) {
      await delay(200)
    }
  }

  const remaining = packageProcessIds(packaged)
  if (remaining.length === 0) return
  process.stdout.write(
    `WARNING: ${remaining.length} process(es) from the package were still running ${gracefulExitTimeoutMs / 1000}s after the app was asked to quit, and are being stopped:\n${remaining.map((entry) => `  ${entry.pid} ${entry.args}`).join("\n")}\n`
  )
  const pids = remaining.map((entry) => entry.pid)
  signalPids(pids, "SIGTERM")
  const stubborn = await waitForPidsExit(pids, childExitTimeoutMs)
  signalPids(stubborn, "SIGKILL")
  const survivors = await waitForPidsExit(stubborn, childExitTimeoutMs)
  if (survivors.length > 0) {
    throw new Error(`Processes from the package survived SIGKILL: ${survivors.join(", ")}`)
  }
}

async function publishPrepackagedPath(packageRoot) {
  const outputFile = process.env.GITHUB_OUTPUT
  if (!outputFile) return
  if (/\r|\n/.test(packageRoot)) {
    throw new Error("Prepackaged path contains an invalid newline.")
  }
  await appendFile(outputFile, `prepackaged-path=${packageRoot}\n`, "utf8")
}

function diagnosticTail() {
  const text = `${stdout.trim()}\n${stderr.trim()}`.trim()
  return text ? text.slice(-4_000) : "(no output)"
}

function appendDiagnosticTail(current, chunk) {
  return `${current}${chunk.toString("utf8")}`.slice(-64_000)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(candidate)))
    else if (entry.isFile() && (await stat(candidate)).size > 0)
      files.push(candidate)
  }
  return files
}

async function stopChildTree(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null)
    return
  if (!processHandle.pid) {
    throw new Error("Packaged application has no process ID for cleanup")
  }
  if (process.platform === "win32") {
    // taskkill exits 128 ("not found") when the app ended on its own between
    // the last liveness check and the kill, and 255 when it could not end
    // every process of the tree (CI saw it once); a second pass ends what is
    // left. Only a root that does not report its exit is a failure then. A
    // process that outlived both passes would still hold the profile, whose
    // removal below fails, or the port the next launch checks.
    for (let pass = 1; ; pass += 1) {
      let failure = null
      try {
        await terminateWindowsChildTree(processHandle.pid)
      } catch (error) {
        failure = error
      }
      const outcome = taskkillOutcome(failure ? failure.taskkillCode : 0, pass)
      if (outcome === "failed") throw failure
      if (outcome === "retry") {
        process.stdout.write(
          `WARNING: taskkill could not end every process of the app (code ${failure.taskkillCode}); running it once more.\n`
        )
        continue
      }
      await waitForChildExit(processHandle, childExitTimeoutMs)
      if (outcome === "exited-before") appExitedOnItsOwn = true
      return
    }
  }

  try {
    process.kill(-processHandle.pid, "SIGTERM")
  } catch {
    processHandle.kill("SIGTERM")
  }
  try {
    await waitForChildExit(processHandle, childExitTimeoutMs)
  } catch {
    try {
      process.kill(-processHandle.pid, "SIGKILL")
    } catch {
      processHandle.kill("SIGKILL")
    }
    await waitForChildExit(processHandle, childExitTimeoutMs)
  }
}

async function terminateWindowsChildTree(pid) {
  const windowsRoot =
    process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows"
  const taskkill = path.join(windowsRoot, "System32", "taskkill.exe")

  await new Promise((resolve, reject) => {
    let settled = false
    let killer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      try {
        killer?.kill("SIGKILL")
      } catch {
        // The taskkill helper may have exited at the timeout boundary.
      }
      finish(
        new Error(
          `taskkill did not finish within ${taskkillTimeoutMs}ms for packaged application pid ${pid}`
        )
      )
    }, taskkillTimeoutMs)

    try {
      killer = spawn(taskkill, ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
    } catch (error) {
      finish(error)
      return
    }
    killer.once("error", finish)
    killer.once("close", (code, signal) => {
      if (code === 0) {
        finish()
        return
      }
      finish(
        Object.assign(
          new Error(
            `taskkill failed for packaged application pid ${pid} (code ${code ?? "null"}, signal ${signal ?? "none"})`
          ),
          { taskkillCode: code }
        )
      )
    })
  })
}

function waitForChildExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      processHandle.removeListener("exit", onExit)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    const timer = setTimeout(() => {
      finish(
        new Error(
          `Packaged application did not exit within ${timeoutMs}ms after termination`
        )
      )
    }, timeoutMs)

    processHandle.once("exit", onExit)
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      finish()
    }
  })
}
