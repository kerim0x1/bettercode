import { spawn, type ChildProcess } from "node:child_process"
import { restrictedChildEnvironment } from "../security/childEnvironment"
import { windowsSystemExecutable } from "../security/executablePath"

/**
 * Shared process-tree termination for the backend.
 *
 * Node has no process-group notion on Windows, so every service that owns a
 * child tree (shell, git, workspace formatters, native text generation, image
 * generation, CLI probes, PTYs, provider runtimes) ends up shelling out to
 * `taskkill /T`. Copies of that helper drifted apart in how they found
 * taskkill (a bare name, which libuv also looks up in the child's cwd), in
 * timeout handling and in what they did when the helper itself hung. This is
 * the single implementation; callers pick the shape they need:
 *
 *  - {@link runWindowsTaskkillDetailed} reports what happened without
 *    throwing, for callers that assemble a diagnostic trail (git).
 *  - {@link runWindowsTaskkill} throws a coded error on failure, for callers
 *    that treat an unconfirmed tree as a hard failure (shell, formatters).
 *  - {@link taskkillChildProcessTree} takes the ChildProcess instead of a PID
 *    and refuses once that root has exited (see below).
 *  - The POSIX process-group helpers below, for children spawned `detached`
 *    so that their PID is also their process-group ID.
 *
 * Hard limit worth knowing: `taskkill /T` only works while the ROOT PID is
 * still owned by our ChildProcess. Windows does not reuse a PID while a
 * handle to the process is open, and libuv holds that handle until it has
 * reported the exit, so `exitCode === null && signalCode === null` is the
 * proof that the PID still names our process. After that the PID may name
 * an unrelated process, and the root's former descendants (a `cmd /c npm run
 * dev` tree, say) can no longer be addressed safely. Killing them would need
 * a Job Object, which is native code this backend does not ship. Callers
 * therefore terminate while the root is alive and, when they cannot, report
 * that descendants may be orphaned rather than pretending the tree is gone.
 *
 * There is also no graceful taskkill for the processes the backend starts:
 * they are console processes without a window (`windowsHide`), and Windows
 * answers a taskkill without `/F` for those with "can only be terminated
 * forcefully". Tree termination on Windows is therefore always forced.
 */

export type TaskkillSpawn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: "ignore"
    windowsHide: boolean
    shell: false
  }
) => ChildProcess

export type TaskkillResult =
  | { status: "closed"; code: number | null; signal: NodeJS.Signals | null }
  | { status: "error"; message: string }
  | { status: "timeout" }

export interface TaskkillOptions {
  /** Injectable for tests and for services that route spawns through a seam. */
  readonly spawnProcess?: TaskkillSpawn
  /**
   * Total bound, including the wait for the helper to close after a kill —
   * unless `closeGraceMs` is set, in which case the helper is killed at
   * `timeoutMs` and given `closeGraceMs` more to report its close.
   */
  readonly timeoutMs?: number
  readonly closeGraceMs?: number
}

const DEFAULT_TASKKILL_TIMEOUT_MS = 5_000
/** Upper bound on how long we wait for a killed helper to report `close`. */
const TASKKILL_EXIT_CONFIRM_MAX_MS = 250
const PROCESS_GROUP_POLL_MS = 25

/** taskkill's exit code when no process has the given PID. */
export const TASKKILL_NO_SUCH_PROCESS_EXIT_CODE = 128

/** Absolute `%SystemRoot%\System32\taskkill.exe`; never looked up on PATH or in cwd. */
export function windowsTaskkillPath(): string {
  return windowsSystemExecutable("taskkill.exe")
}

/** Absolute path of Windows PowerShell 5.1, which every supported Windows ships. */
export function windowsPowerShellPath(): string {
  return windowsSystemExecutable("WindowsPowerShell", "v1.0", "powershell.exe")
}

/**
 * Whether `child` has not reported an exit yet, i.e. its PID is still the
 * process we started (see the header).
 */
export function isChildProcessRunning(
  child: Pick<ChildProcess, "exitCode" | "signalCode">
): boolean {
  return child.exitCode === null && child.signalCode === null
}

/**
 * Run `taskkill /pid <pid> /T [/F]` and report the outcome.
 *
 * The promise settles only on the helper's `close` (or once the post-kill
 * confirmation window elapses). Settling on `error` alone would let the
 * caller proceed while the helper is still running.
 *
 * Prefer {@link taskkillChildProcessTree}: a bare PID cannot prove that it
 * still names the process the caller started.
 */
export function runWindowsTaskkillDetailed(
  pid: number,
  force: boolean,
  options: TaskkillOptions = {}
): Promise<TaskkillResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS
  if (timeoutMs <= 0) return Promise.resolve({ status: "timeout" })
  const spawnProcess = options.spawnProcess ?? (spawn as TaskkillSpawn)

  return new Promise((resolve) => {
    let killer: ChildProcess
    try {
      killer = spawnProcess(
        windowsTaskkillPath(),
        ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])],
        {
          env: restrictedChildEnvironment(),
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        }
      )
    } catch (error) {
      resolve({ status: "error", message: errorMessage(error) })
      return
    }

    let settled = false
    let timedOut = false
    let spawnError: Error | null = null
    let killTimer: NodeJS.Timeout | null = null
    let exitConfirmationTimer: NodeJS.Timeout | null = null
    const finish = (result: TaskkillResult) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (exitConfirmationTimer) clearTimeout(exitConfirmationTimer)
      killer.removeListener("error", onError)
      killer.removeListener("close", onClose)
      resolve(result)
    }
    const onError = (error: Error) => {
      // Keep waiting for `close`; an `error` (ENOENT, EPERM) is followed by
      // it and the close event remains the decisive signal.
      spawnError = error
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish({ status: "timeout" })
        return
      }
      if (spawnError) {
        finish({ status: "error", message: spawnError.message })
        return
      }
      finish({ status: "closed", code, signal })
    }
    // Reserve a slice of the budget for the helper to acknowledge SIGKILL, so
    // the total stays within `timeoutMs` (or add an explicit close grace).
    const exitConfirmationMs =
      options.closeGraceMs !== undefined
        ? Math.max(1, Math.floor(options.closeGraceMs))
        : Math.min(
            TASKKILL_EXIT_CONFIRM_MAX_MS,
            Math.max(1, Math.floor(timeoutMs / 4))
          )
    const killAtMs =
      options.closeGraceMs !== undefined
        ? Math.max(1, timeoutMs)
        : Math.max(1, timeoutMs - exitConfirmationMs)
    killTimer = setTimeout(() => {
      timedOut = true
      try {
        killer.kill("SIGKILL")
      } catch {
        // The helper may already be closing; its close event remains decisive.
      }
      exitConfirmationTimer = setTimeout(
        () => finish({ status: "timeout" }),
        exitConfirmationMs
      )
      exitConfirmationTimer.unref?.()
    }, killAtMs)
    killTimer.unref?.()

    killer.once("error", onError)
    killer.once("close", onClose)
  })
}

/**
 * Throwing variant. Rejects with `code: "TASKKILL_TIMEOUT"` when the helper
 * had to be killed, `"TASKKILL_FAILED"` on a non-zero exit, or
 * `"TASKKILL_SPAWN_FAILED"` when the helper could not start.
 */
export async function runWindowsTaskkill(
  pid: number,
  force: boolean,
  options: TaskkillOptions = {}
): Promise<void> {
  const result = await runWindowsTaskkillDetailed(pid, force, options)
  throwForTaskkillResult(pid, result)
}

/**
 * Force-kill the Windows process tree rooted at `child`, but only while
 * `child` has not reported an exit: after that its PID may name an unrelated
 * process. Rejects with `code: "TASKKILL_ROOT_EXITED"` in that case, and with
 * the {@link runWindowsTaskkill} codes otherwise.
 */
export async function taskkillChildProcessTree(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
  options: TaskkillOptions = {}
): Promise<void> {
  const pid = child.pid
  if (pid == null || !isChildProcessRunning(child)) {
    throw Object.assign(
      new Error(
        `Process tree ${pid ?? "unknown"} can no longer be addressed safely: its root already exited.`
      ),
      { code: "TASKKILL_ROOT_EXITED", pid: pid ?? null }
    )
  }
  const result = await runWindowsTaskkillDetailed(pid, true, options)
  throwForTaskkillResult(pid, result)
}

function throwForTaskkillResult(pid: number, result: TaskkillResult): void {
  switch (result.status) {
    case "closed":
      if (result.code === 0) return
      throw Object.assign(
        new Error(
          `taskkill for process tree ${pid} exited with code ${String(
            result.code
          )}${result.signal ? ` (${result.signal})` : ""}.`
        ),
        {
          code: "TASKKILL_FAILED",
          pid,
          exitCode: result.code,
          signal: result.signal,
        }
      )
    case "timeout":
      throw Object.assign(
        new Error(`taskkill for process tree ${pid} timed out.`),
        { code: "TASKKILL_TIMEOUT", pid }
      )
    case "error":
      throw Object.assign(new Error(result.message), {
        code: "TASKKILL_SPAWN_FAILED",
        pid,
      })
  }
}

export function formatTaskkillResult(result: TaskkillResult): string {
  switch (result.status) {
    case "closed":
      return `exited with code ${result.code ?? "unknown"}${
        result.signal ? ` (${result.signal})` : ""
      }`
    case "error":
      return `failed: ${result.message}`
    case "timeout":
      return "timed out"
  }
}

/** `process.kill` reports a vanished process or group as ESRCH. */
export function isNoSuchProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ESRCH"
}

type KillProcess = (pid: number, signal: NodeJS.Signals | 0) => unknown

const defaultKillProcess: KillProcess = (pid, signal) =>
  process.kill(pid, signal)

/**
 * Signal the POSIX process group `pid`. False when the group is gone, or —
 * macOS only — when every member has exited but is not reaped yet: the
 * kernel then answers EPERM. Such a group needs no signal; whether it is gone
 * is decided by the callers' wait loop, which treats EPERM as alive until
 * Node reaps the child, so a genuine permission denial still fails closed.
 */
export function signalPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  killProcess: KillProcess = defaultKillProcess
): boolean {
  try {
    killProcess(-pid, signal)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false
    throw error
  }
}

export function isPosixProcessGroupAlive(
  pid: number,
  killProcess: KillProcess = defaultKillProcess
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

export async function waitForPosixProcessGroupExit(
  pid: number,
  timeoutMs: number,
  killProcess: KillProcess = defaultKillProcess
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    if (!isPosixProcessGroupAlive(pid, killProcess)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, remaining))
    )
  }
  return !isPosixProcessGroupAlive(pid, killProcess)
}

/**
 * Make sure the POSIX process group `pid` is gone: SIGTERM, a short grace,
 * SIGKILL, then fail with `PROCESS_GROUP_SURVIVED_ROOT_EXIT` (or `code`) if
 * it is still observable.
 */
export async function ensurePosixProcessGroupTerminated(
  pid: number,
  options: {
    readonly termGraceMs?: number
    readonly killGraceMs?: number
    readonly code?: string
    readonly killProcess?: KillProcess
  } = {}
): Promise<void> {
  const killProcess = options.killProcess ?? defaultKillProcess
  if (!isPosixProcessGroupAlive(pid, killProcess)) return
  signalPosixProcessGroup(pid, "SIGTERM", killProcess)
  if (
    await waitForPosixProcessGroupExit(
      pid,
      options.termGraceMs ?? 250,
      killProcess
    )
  ) {
    return
  }
  signalPosixProcessGroup(pid, "SIGKILL", killProcess)
  if (
    await waitForPosixProcessGroupExit(
      pid,
      options.killGraceMs ?? 500,
      killProcess
    )
  ) {
    return
  }
  throw Object.assign(
    new Error(`POSIX process group ${pid} survived root-process exit.`),
    {
      code: options.code ?? "PROCESS_GROUP_SURVIVED_ROOT_EXIT",
      pid,
    }
  )
}

/** The message of a thrown value; shared by the process-management modules. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
