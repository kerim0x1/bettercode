import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { logger } from "../observability/logger"
import { restrictedChildEnvironment } from "../security/childEnvironment"
import {
  isChildProcessRunning,
  runWindowsTaskkill,
  signalPosixProcessGroup,
  waitForPosixProcessGroupExit,
  windowsPowerShellPath,
  windowsTaskkillPath,
} from "./process-termination"

/**
 * Process trees the backend owns, kept from outliving it.
 *
 * On POSIX every long-lived child runs in its own process group so the
 * backend can signal its whole tree; the side effect is that a backend that
 * dies does not take those groups with it. On Windows nothing ties a child
 * to the backend at all (no Job Object). Without this registry a crashed
 * backend left dev servers, shells and agent CLIs running, holding ports and
 * file locks, and the next backend had no record of them.
 *
 *  - In memory: when the backend process exits for any reason that still
 *    runs `exit` handlers (shutdown, a fatal error, `process.exit` after an
 *    incomplete drain), every tracked tree is killed synchronously.
 *  - On disk: the live entries are mirrored to a pidfile in the data
 *    directory. A backend that starts after one that was killed outright
 *    (SIGKILL, power loss) reaps the trees listed there, but only when the
 *    root process still exists and its start time matches the recorded one,
 *    so a reused PID is never touched.
 *
 * What remains: a POSIX tree whose root already exited cannot be verified at
 * the next start and is left alone; on Windows, descendants whose root exited
 * cannot be addressed at all (that needs a Job Object). Short-lived helpers
 * such as git, which are bounded by their own timeouts, are not tracked.
 */

export interface TrackedProcessTree {
  readonly pid: number
  readonly label: string
  /** POSIX: the child leads its own process group (spawned `detached`). */
  readonly processGroup: boolean
  /** Whether the root has not reported an exit, i.e. its PID is still ours. */
  readonly isRunning: () => boolean
}

interface RegistryEntry {
  readonly pid: number
  readonly label: string
  readonly processGroup: boolean
  readonly startedAt: number
  readonly isRunning: () => boolean
}

interface PidfileEntry {
  readonly pid: number
  readonly label: string
  readonly processGroup: boolean
  readonly startedAt: number
}

interface Pidfile {
  readonly version: 1
  readonly backendPid: number
  readonly platform: NodeJS.Platform
  readonly entries: readonly PidfileEntry[]
}

const PIDFILE_NAME = "child-process-trees.json"
const PIDFILE_WRITE_DELAY_MS = 250
/** Allowed gap between the recorded spawn time and the OS start time. */
const START_TIME_TOLERANCE_MS = 3_000
const EXIT_TASKKILL_TIMEOUT_MS = 3_000
const IDENTITY_QUERY_TIMEOUT_MS = 5_000

const entries = new Map<number, RegistryEntry>()
let pidfilePath: string | null = null
let pidfileTimer: NodeJS.Timeout | null = null
let exitHookInstalled = false

/**
 * Track a spawned ChildProcess. Returns the function that stops tracking it;
 * call it once the tree is known to be gone. On Windows the entry also drops
 * itself when the root exits, since its PID may be reused from then on.
 */
export function trackChildProcessTree(
  child: ChildProcess,
  label: string
): () => void {
  const pid = child.pid
  if (pid == null) return () => undefined
  const untrack = trackProcessTree({
    pid,
    label,
    processGroup: process.platform !== "win32",
    isRunning: () => isChildProcessRunning(child),
  })
  if (process.platform === "win32") child.once("exit", untrack)
  return untrack
}

/** Track any process tree, such as a PTY, by PID. */
export function trackProcessTree(tree: TrackedProcessTree): () => void {
  installExitHook()
  const entry: RegistryEntry = { ...tree, startedAt: Date.now() }
  entries.set(tree.pid, entry)
  schedulePidfileWrite()
  let tracked = true
  return () => {
    if (!tracked) return
    tracked = false
    if (entries.get(tree.pid) === entry) {
      entries.delete(tree.pid)
      schedulePidfileWrite()
    }
  }
}

export function trackedProcessTreeCount(): number {
  return entries.size
}

/**
 * Point the registry at the backend's data directory and reap the trees a
 * previous backend left behind. Never throws; reaping runs in the background
 * and only logs.
 */
export function configureChildProcessRegistry(input: {
  readonly dataDir: string
}): Promise<number> {
  installExitHook()
  const directory = path.join(input.dataDir, "run")
  pidfilePath = path.join(directory, PIDFILE_NAME)
  const previous = readPidfile(pidfilePath)
  schedulePidfileWrite()
  if (!previous || previous.backendPid === process.pid) {
    return Promise.resolve(0)
  }
  return reapStaleProcessTrees(previous).catch((error) => {
    logger.warn(
      { err: error },
      "could not reap process trees left by a previous backend"
    )
    return 0
  })
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", killTrackedTreesSynchronously)
}

/**
 * `exit` handlers must be synchronous. POSIX groups get SIGKILL; Windows
 * roots still owned by us are force-killed with one bounded taskkill. The
 * pidfile is emptied afterwards because nothing in it is ours any more.
 */
function killTrackedTreesSynchronously(): void {
  const live = [...entries.values()]
  entries.clear()
  if (pidfileTimer) {
    clearTimeout(pidfileTimer)
    pidfileTimer = null
  }
  if (process.platform === "win32") {
    const pids = live
      .filter((entry) => entry.isRunning())
      .map((entry) => entry.pid)
    if (pids.length > 0) {
      try {
        spawnSync(
          windowsTaskkillPath(),
          ["/T", "/F", ...pids.flatMap((pid) => ["/pid", String(pid)])],
          {
            env: restrictedChildEnvironment(),
            stdio: "ignore",
            windowsHide: true,
            timeout: EXIT_TASKKILL_TIMEOUT_MS,
          }
        )
      } catch {
        // Exiting anyway; the pidfile is cleared below only on success paths.
      }
    }
  } else {
    for (const entry of live) {
      try {
        if (entry.processGroup) process.kill(-entry.pid, "SIGKILL")
        else if (entry.isRunning()) process.kill(entry.pid, "SIGKILL")
      } catch {
        // Already gone.
      }
    }
  }
  if (pidfilePath) {
    try {
      writePidfileSync(pidfilePath, [])
    } catch {
      // A stale pidfile is reaped (with identity checks) at the next start.
    }
  }
}

function schedulePidfileWrite(): void {
  if (!pidfilePath || pidfileTimer) return
  pidfileTimer = setTimeout(() => {
    pidfileTimer = null
    const target = pidfilePath
    if (!target) return
    const snapshot = [...entries.values()].map(
      ({ pid, label, processGroup, startedAt }) => ({
        pid,
        label,
        processGroup,
        startedAt,
      })
    )
    void writePidfile(target, snapshot).catch((error) => {
      logger.warn({ err: error }, "could not record tracked process trees")
    })
  }, PIDFILE_WRITE_DELAY_MS)
  pidfileTimer.unref?.()
}

function pidfileContent(list: readonly PidfileEntry[]): string {
  const content: Pidfile = {
    version: 1,
    backendPid: process.pid,
    platform: process.platform,
    entries: list,
  }
  return `${JSON.stringify(content)}\n`
}

async function writePidfile(
  target: string,
  list: readonly PidfileEntry[]
): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), {
    recursive: true,
    mode: 0o700,
  })
  const temporary = `${target}.${process.pid}.tmp`
  await fs.promises.writeFile(temporary, pidfileContent(list), { mode: 0o600 })
  await fs.promises.rename(temporary, target)
}

function writePidfileSync(target: string, list: readonly PidfileEntry[]): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.writeFileSync(target, pidfileContent(list), { mode: 0o600 })
}

function readPidfile(target: string): Pidfile | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(target, "utf8")
    ) as Partial<Pidfile>
    if (
      parsed?.version !== 1 ||
      typeof parsed.backendPid !== "number" ||
      parsed.platform !== process.platform ||
      !Array.isArray(parsed.entries)
    ) {
      return null
    }
    const valid = parsed.entries.filter(
      (entry): entry is PidfileEntry =>
        Boolean(entry) &&
        Number.isSafeInteger(entry.pid) &&
        entry.pid > 1 &&
        entry.pid !== process.pid &&
        typeof entry.startedAt === "number" &&
        Number.isFinite(entry.startedAt) &&
        typeof entry.processGroup === "boolean" &&
        typeof entry.label === "string"
    )
    return { ...parsed, entries: valid } as Pidfile
  } catch {
    return null
  }
}

async function reapStaleProcessTrees(previous: Pidfile): Promise<number> {
  if (previous.entries.length === 0) return 0
  if (isProcessAlive(previous.backendPid)) {
    // The data-directory lock keeps two backends apart; if the recorded one
    // still runs, its children are its own business.
    return 0
  }
  const startTimes = await queryProcessStartTimes(
    previous.entries.map((entry) => entry.pid)
  )
  let reaped = 0
  for (const entry of previous.entries) {
    const startedAt = startTimes.get(entry.pid)
    if (
      startedAt === undefined ||
      Math.abs(startedAt - entry.startedAt) > START_TIME_TOLERANCE_MS
    ) {
      continue
    }
    try {
      if (process.platform === "win32") {
        await runWindowsTaskkill(entry.pid, true)
      } else if (entry.processGroup) {
        signalPosixProcessGroup(entry.pid, "SIGTERM")
        if (!(await waitForPosixProcessGroupExit(entry.pid, 1_000))) {
          signalPosixProcessGroup(entry.pid, "SIGKILL")
        }
      } else {
        process.kill(entry.pid, "SIGKILL")
      }
      reaped += 1
      logger.warn(
        { pid: entry.pid, label: entry.label },
        "terminated a process tree left running by a previous backend"
      )
    } catch (error) {
      logger.warn(
        { err: error, pid: entry.pid, label: entry.label },
        "could not terminate a process tree left by a previous backend"
      )
    }
  }
  return reaped
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Epoch start time (ms) of each listed process that still exists. Windows
 * asks CIM for `CreationDate`; POSIX reads elapsed time from `ps`, which has
 * one-second resolution.
 */
async function queryProcessStartTimes(
  pids: readonly number[]
): Promise<Map<number, number>> {
  const unique = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid))
  if (unique.length === 0) return new Map()
  if (process.platform === "win32") {
    const filter = unique.map((pid) => `ProcessId=${pid}`).join(" OR ")
    const script = [
      "$ErrorActionPreference='Stop'",
      `@(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress`,
    ].join("; ")
    const output = await captureOutput(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ])
    const result = new Map<number, number>()
    if (!output.trim()) return result
    const parsed = JSON.parse(output) as unknown
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      const record = row as { pid?: unknown; created?: unknown } | null
      const created =
        typeof record?.created === "string" ? Date.parse(record.created) : NaN
      if (typeof record?.pid === "number" && Number.isFinite(created)) {
        result.set(record.pid, created)
      }
    }
    return result
  }
  const ps = ["/bin/ps", "/usr/bin/ps"].find((candidate) =>
    fs.existsSync(candidate)
  )
  if (!ps) return new Map()
  const now = Date.now()
  const output = await captureOutput(ps, [
    "-o",
    "pid=,etime=",
    "-p",
    unique.join(","),
  ]).catch(() => "")
  const result = new Map<number, number>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line)
    if (!match) continue
    const elapsed = parseElapsedTime(match[2]!)
    if (elapsed !== null) result.set(Number(match[1]), now - elapsed)
  }
  return result
}

/** `ps` etime: `[[dd-]hh:]mm:ss`. */
export function parseElapsedTime(value: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value.trim())
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return (
    (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) *
      60 +
      Number(seconds)) *
    1_000
  )
}

function captureOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: restrictedChildEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // Already closing.
      }
      if (!settled) {
        settled = true
        reject(new Error(`${path.basename(command)} timed out.`))
      }
    }, IDENTITY_QUERY_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
  })
}
