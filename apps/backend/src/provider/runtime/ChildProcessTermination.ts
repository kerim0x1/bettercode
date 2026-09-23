import { spawn, type ChildProcess } from "node:child_process"
import { sanitizedChildEnvironment } from "../../security/childEnvironment"

const DEFAULT_TERM_GRACE_MS = 500
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_TASKKILL_TIMEOUT_MS = 3_000
const DEFAULT_TASKKILL_CLOSE_GRACE_MS = 1_000
const PROCESS_GROUP_POLL_MS = 25

type TaskkillSpawner = (
  command: string,
  args: string[],
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly stdio: "ignore"
    readonly windowsHide: boolean
  }
) => ChildProcess

export interface ProviderChildProcessTerminationOptions {
  readonly platform?: NodeJS.Platform
  readonly termGraceMs?: number
  readonly killGraceMs?: number
  readonly taskkillTimeoutMs?: number
  readonly taskkillCloseGraceMs?: number
  readonly spawnTaskkill?: TaskkillSpawner
  readonly killProcess?: typeof process.kill
}

/**
 * Terminates a provider-owned process tree and only resolves after its exit can
 * be confirmed. POSIX callers must spawn the child detached so its PID is also
 * the process-group ID. Windows uses taskkill /T /F while the root PID is still
 * addressable.
 */
export async function terminateProviderChildProcessTree(
  child: ChildProcess,
  options: ProviderChildProcessTerminationOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  const termGraceMs = boundedDelay(options.termGraceMs, DEFAULT_TERM_GRACE_MS)
  const killGraceMs = boundedDelay(options.killGraceMs, DEFAULT_KILL_GRACE_MS)

  if (platform === "win32") {
    await terminateWindowsProviderProcessTree(child, {
      killGraceMs,
      taskkillTimeoutMs: boundedDelay(
        options.taskkillTimeoutMs,
        DEFAULT_TASKKILL_TIMEOUT_MS
      ),
      taskkillCloseGraceMs: boundedDelay(
        options.taskkillCloseGraceMs,
        DEFAULT_TASKKILL_CLOSE_GRACE_MS
      ),
      spawnTaskkill: options.spawnTaskkill,
    })
    return
  }

  await terminatePosixProviderProcessTree(child, {
    termGraceMs,
    killGraceMs,
    killProcess: options.killProcess ?? process.kill.bind(process),
  })
}

async function terminateWindowsProviderProcessTree(
  child: ChildProcess,
  options: {
    readonly killGraceMs: number
    readonly taskkillTimeoutMs: number
    readonly taskkillCloseGraceMs: number
    readonly spawnTaskkill?: TaskkillSpawner
  }
): Promise<void> {
  if (childHasExited(child)) {
    // Once a Windows root has exited, its descendants cannot be addressed
    // safely without an OS job object. Never taskkill a PID that may be reused.
    return
  }

  const pid = child.pid
  if (pid == null) {
    await terminateRootProcess(child, options.killGraceMs)
    return
  }

  await runProviderWindowsTaskkill(pid, {
    spawnTaskkill: options.spawnTaskkill,
    timeoutMs: options.taskkillTimeoutMs,
    closeGraceMs: options.taskkillCloseGraceMs,
  })

  if (await waitForChildExit(child, options.killGraceMs)) return
  throw codedError(
    `Provider process tree ${pid} did not report an exit after taskkill succeeded.`,
    "PROVIDER_PROCESS_TREE_ROOT_SURVIVED",
    { pid }
  )
}

async function terminatePosixProviderProcessTree(
  child: ChildProcess,
  options: {
    readonly termGraceMs: number
    readonly killGraceMs: number
    readonly killProcess: typeof process.kill
  }
): Promise<void> {
  const pid = child.pid
  if (pid == null) {
    if (!childHasExited(child)) {
      await terminateRootProcess(child, options.killGraceMs)
    }
    return
  }

  if (!isPosixProcessGroupAlive(pid, options.killProcess)) {
    if (!childHasExited(child)) {
      // This is a defensive fallback for a caller that failed to spawn the
      // process detached. Provider runtime callers use detached process groups.
      await terminateRootProcess(child, options.killGraceMs)
    }
    return
  }

  signalPosixProcessGroup(pid, "SIGTERM", options.killProcess)
  if (
    await waitForPosixProcessGroupExit(
      pid,
      options.termGraceMs,
      options.killProcess
    )
  ) {
    return
  }

  signalPosixProcessGroup(pid, "SIGKILL", options.killProcess)
  if (
    await waitForPosixProcessGroupExit(
      pid,
      options.killGraceMs,
      options.killProcess
    )
  ) {
    return
  }

  throw codedError(
    `Provider process group ${pid} survived SIGKILL.`,
    "PROVIDER_PROCESS_GROUP_SURVIVED_SIGKILL",
    { pid }
  )
}

async function terminateRootProcess(
  child: ChildProcess,
  killGraceMs: number
): Promise<void> {
  if (childHasExited(child)) return
  try {
    child.kill("SIGKILL")
  } catch (error) {
    if (!isNoSuchProcessError(error)) throw error
  }
  if (await waitForChildExit(child, killGraceMs)) return
  throw codedError(
    "Provider child process survived SIGKILL.",
    "PROVIDER_ROOT_PROCESS_SURVIVED"
  )
}

export async function runProviderWindowsTaskkill(
  pid: number,
  options: {
    readonly spawnTaskkill?: TaskkillSpawner
    readonly timeoutMs?: number
    readonly closeGraceMs?: number
  } = {}
): Promise<void> {
  const spawnTaskkill = options.spawnTaskkill ?? (spawn as TaskkillSpawner)
  const timeoutMs = boundedDelay(options.timeoutMs, DEFAULT_TASKKILL_TIMEOUT_MS)
  const closeGraceMs = boundedDelay(
    options.closeGraceMs,
    DEFAULT_TASKKILL_CLOSE_GRACE_MS
  )
  let killer: ChildProcess
  try {
    killer = spawnTaskkill("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      env: sanitizedChildEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    })
  } catch (error) {
    throw codedError(
      `Failed to start taskkill for provider process tree ${pid}: ${errorMessage(
        error
      )}`,
      "PROVIDER_TASKKILL_SPAWN_FAILED",
      { pid, cause: error }
    )
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let spawnError: Error | null = null
    let timeoutError: Error | null = null
    let closeDeadline: NodeJS.Timeout | null = null

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (closeDeadline) clearTimeout(closeDeadline)
      killer.off("error", onError)
      killer.off("close", onClose)
      if (error) reject(error)
      else resolve()
    }
    const onError = (error: Error) => {
      spawnError = error
      // Node normally follows "error" with "close". Keep waiting so the
      // helper lifecycle is never dropped at the error event.
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (spawnError) {
        finish(
          codedError(
            `taskkill for provider process tree ${pid} failed: ${spawnError.message}`,
            "PROVIDER_TASKKILL_SPAWN_FAILED",
            { pid, cause: spawnError }
          )
        )
        return
      }
      if (timeoutError) {
        finish(timeoutError)
        return
      }
      if (code === 0) {
        finish()
        return
      }
      finish(
        codedError(
          `taskkill for provider process tree ${pid} exited with code ${String(
            code
          )}${signal ? ` (${signal})` : ""}.`,
          "PROVIDER_TASKKILL_FAILED",
          { pid, exitCode: code, signal }
        )
      )
    }
    const timeout = setTimeout(() => {
      timeoutError = codedError(
        `taskkill for provider process tree ${pid} timed out.`,
        "PROVIDER_TASKKILL_TIMEOUT",
        { pid }
      )
      try {
        killer.kill("SIGKILL")
      } catch {
        // The helper may already be entering its close event.
      }
      closeDeadline = setTimeout(() => {
        finish(timeoutError ?? undefined)
      }, closeGraceMs)
      closeDeadline.unref?.()
    }, timeoutMs)
    timeout.unref?.()

    killer.once("error", onError)
    killer.once("close", onClose)
  })
}

/**
 * One process observed under a Windows root, pinned by its creation time so a
 * later kill cannot hit a reused PID.
 */
export interface WindowsProcessRecord {
  readonly pid: number
  /** ISO creation time from Win32_Process; null when the OS did not report one. */
  readonly createdAt: string | null
}

type PowerShellSpawner = (
  command: string,
  args: string[],
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly stdio: ["ignore", "pipe", "ignore"]
    readonly windowsHide: boolean
  }
) => ChildProcess

export interface WindowsProcessQueryOptions {
  readonly spawnPowerShell?: PowerShellSpawner
  readonly timeoutMs?: number
}

const DEFAULT_POWERSHELL_QUERY_TIMEOUT_MS = 5_000
const MAX_POWERSHELL_OUTPUT_BYTES = 256 * 1024

/**
 * Lists the direct children of `pid` on Windows. Used before a root process
 * is killed on its own: for a non-`.exe` command the root is a cmd.exe shim,
 * and killing it orphans the real agent, so the caller records the children
 * first and finishes them on a retry. Rejects when the listing cannot be
 * trusted (helper missing, timed out, unparsable) — an unknown tree must stay
 * unconfirmed rather than be reported empty.
 */
export async function listWindowsChildProcesses(
  pid: number,
  options: WindowsProcessQueryOptions = {}
): Promise<WindowsProcessRecord[]> {
  const rows = await runWindowsProcessQuery(
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Math.floor(pid)}'`,
    options
  )
  return rows
}

/**
 * True while a process with `record.pid` exists and (when the record carries
 * one) still has the same creation time; false once it is gone or the PID
 * belongs to a newer process, which must not be killed.
 */
export async function windowsProcessStillMatches(
  record: WindowsProcessRecord,
  options: WindowsProcessQueryOptions = {}
): Promise<boolean> {
  const rows = await runWindowsProcessQuery(
    `Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.floor(record.pid)}'`,
    options
  )
  const row = rows.find((candidate) => candidate.pid === record.pid)
  if (!row) return false
  if (!record.createdAt || !row.createdAt) {
    throw codedError(
      `Provider process ${record.pid} has no confirmed creation time.`,
      "PROVIDER_PROCESS_IDENTITY_UNCONFIRMED",
      { pid: record.pid }
    )
  }
  return row.createdAt === record.createdAt
}

async function runWindowsProcessQuery(
  cimQuery: string,
  options: WindowsProcessQueryOptions
): Promise<WindowsProcessRecord[]> {
  const spawnPowerShell =
    options.spawnPowerShell ?? (spawn as unknown as PowerShellSpawner)
  const timeoutMs = boundedDelay(
    options.timeoutMs,
    DEFAULT_POWERSHELL_QUERY_TIMEOUT_MS
  )
  // `-InputObject @(...)` serialises a single row as an array too; the parser
  // below still accepts a bare object in case a host unrolls it.
  const script = [
    "$ErrorActionPreference='Stop'",
    `$rows = @(${cimQuery} | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } } })`,
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("; ")
  let helper: ChildProcess
  try {
    helper = spawnPowerShell(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        env: sanitizedChildEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
    )
  } catch (error) {
    throw codedError(
      `Failed to start the Windows process query: ${errorMessage(error)}`,
      "PROVIDER_PROCESS_QUERY_SPAWN_FAILED",
      { cause: error }
    )
  }

  const output = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    let spawnError: Error | null = null
    let outputLimitError: Error | null = null
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      helper.off("error", onError)
      helper.off("close", onClose)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks, bytes).toString("utf8"))
    }
    const onError = (error: Error) => {
      spawnError = error
    }
    const onClose = (code: number | null) => {
      if (outputLimitError) {
        finish(outputLimitError)
        return
      }
      if (spawnError) {
        finish(
          codedError(
            `Windows process query failed: ${spawnError.message}`,
            "PROVIDER_PROCESS_QUERY_SPAWN_FAILED",
            { cause: spawnError }
          )
        )
        return
      }
      if (code !== 0) {
        finish(
          codedError(
            `Windows process query exited with code ${String(code)}.`,
            "PROVIDER_PROCESS_QUERY_FAILED",
            { exitCode: code }
          )
        )
        return
      }
      finish()
    }
    const timer = setTimeout(() => {
      try {
        helper.kill("SIGKILL")
      } catch {
        // Already closing.
      }
      finish(
        outputLimitError ??
          codedError(
            "Windows process query timed out.",
            "PROVIDER_PROCESS_QUERY_TIMEOUT"
          )
      )
    }, timeoutMs)
    timer.unref?.()
    helper.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled || outputLimitError) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")
      if (bytes + buffer.byteLength > MAX_POWERSHELL_OUTPUT_BYTES) {
        outputLimitError = codedError(
          "Windows process query exceeded its output limit.",
          "PROVIDER_PROCESS_QUERY_OUTPUT_LIMIT"
        )
        chunks.length = 0
        bytes = 0
        try {
          helper.kill("SIGKILL")
        } catch {
          // Keep waiting for close or the existing deadline.
        }
        return
      }
      chunks.push(buffer)
      bytes += buffer.byteLength
    })
    helper.once("error", onError)
    helper.once("close", onClose)
  })

  return parseWindowsProcessRows(output)
}

export function parseWindowsProcessRows(
  output: string
): WindowsProcessRecord[] {
  const trimmed = output.trim()
  if (trimmed.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw codedError(
      "Windows process query returned unparsable output.",
      "PROVIDER_PROCESS_QUERY_UNPARSABLE",
      { cause: error }
    )
  }
  const rows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]
  const records: WindowsProcessRecord[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const record = row as { pid?: unknown; created?: unknown }
    const pid =
      typeof record.pid === "number"
        ? record.pid
        : typeof record.pid === "string"
          ? Number(record.pid)
          : Number.NaN
    if (!Number.isInteger(pid) || pid <= 0) continue
    records.push({
      pid,
      createdAt: typeof record.created === "string" ? record.created : null,
    })
  }
  return records
}

function signalPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  killProcess: typeof process.kill
): boolean {
  try {
    killProcess(-pid, signal)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    // macOS refuses to signal a process group whose members have all exited
    // but are not reaped yet (zombies) with EPERM; Linux reports success.
    // Such a group needs no signal. Whether it is gone is decided by the
    // callers' wait loop, which still treats EPERM as alive until Node
    // reaps the child, so a genuine permission denial still fails closed.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false
    throw error
  }
}

function isPosixProcessGroupAlive(
  pid: number,
  killProcess: typeof process.kill
): boolean {
  try {
    killProcess(-pid, 0)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true
    throw error
  }
}

async function waitForPosixProcessGroupExit(
  pid: number,
  timeoutMs: number,
  killProcess: typeof process.kill
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPosixProcessGroupAlive(pid, killProcess)) return true
    await delay(Math.min(PROCESS_GROUP_POLL_MS, deadline - Date.now()))
  }
  return !isPosixProcessGroupAlive(pid, killProcess)
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve(childHasExited(child))
    }, timeoutMs)
    timer.unref?.()
    child.once("exit", onExit)
  })
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, ms))
    timer.unref?.()
  })
}

function boundedDelay(value: number | undefined, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.floor(value as number))
    : fallback
}

function isNoSuchProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codedError(
  message: string,
  code: string,
  details: Record<string, unknown> = {}
): Error {
  return Object.assign(new Error(message), { code, ...details })
}
