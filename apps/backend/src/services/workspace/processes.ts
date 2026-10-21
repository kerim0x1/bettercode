import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { logger } from "../../observability/logger"
import { trackChildProcessTree } from "../child-process-registry"
import {
  ensurePosixProcessGroupTerminated,
  errorMessage,
  runWindowsTaskkill,
} from "../process-termination"
import {
  sameWorkspacePathIdentity,
  workspacePathChanged,
  workspacePathIdentity,
  type WorkspaceDirectoryIdentity,
  type WorkspacePathIdentity,
} from "./files"

export async function assertFormatterStagingDirectoriesUnchanged(
  chain: readonly WorkspaceDirectoryIdentity[]
): Promise<void> {
  for (const expected of chain) {
    const stat = await fs.lstat(expected.path)
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !sameWorkspacePathIdentity(expected, workspacePathIdentity(stat))
    ) {
      throw workspacePathChanged(
        "formatter staging directory changed during validation"
      )
    }
  }
}

const MAX_ACTIVE_PROJECT_FORMAT_OPERATIONS = 4

const MAX_ACTIVE_PROJECT_FORMAT_OPERATIONS_PER_WORKSPACE = 2

const MAX_QUEUED_PROJECT_FORMAT_OPERATIONS = 32

const MAX_QUEUED_PROJECT_FORMAT_OPERATIONS_PER_WORKSPACE = 8

const MAX_PROJECT_FORMAT_QUEUE_WAIT_MS = 30_000

const WORKSPACE_PROCESS_TERMINATION_TIMEOUT_MS = 7_000

const MAX_ACTIVE_WORKSPACE_PROCESSES = 4

const MAX_QUEUED_WORKSPACE_PROCESSES = 32

const MAX_WORKSPACE_PROCESS_QUEUE_WAIT_MS = 30_000

type WorkspaceProcessStopReason =
  | "timeout"
  | "output"
  | "file-output"
  | "staging-change"
  | "abort"
  | "shutdown"
  | "spawn-error"

interface ActiveWorkspaceProcess {
  readonly child: ChildProcess
  readonly pid: number | undefined
  readonly label: string
  readonly rootExit: Promise<void>
  readonly settled: Promise<void>
  resolveRootExit: () => void
  resolveSettled: () => void
  rootExited: boolean
  settledResult: boolean
  treeUnconfirmed: boolean
  stopReason: WorkspaceProcessStopReason | null
  termination: Promise<void> | null
  stop: (reason: WorkspaceProcessStopReason) => Promise<void>
  /** Drops the tree from the crash-cleanup registry once it is gone. */
  untrackTree: () => void
}

/**
 * Why a bounded command produced no real exit code. Callers used to
 * string-match `stderr` for "queue is full" and friends; this is the typed
 * form of the same information.
 */
export type WorkspaceProcessFailureKind =
  | "queue-full"
  | "queue-timeout"
  | "aborted"
  | "shutdown"
  | "spawn-error"

export interface BoundedWorkspaceCommandResult {
  readonly exitCode: number | null
  readonly signal?: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** Present whenever the command did not run to a real exit. */
  readonly failure?: { readonly kind: WorkspaceProcessFailureKind }
  readonly timedOut: boolean
  readonly outputExceeded: boolean
  readonly fileOutputExceeded?: boolean
  readonly watchedFileError?: string
  readonly treeError?: string
}

interface WorkspaceProcessReservation {
  commit(): void
  release(): void
}

interface QueuedWorkspaceProcess {
  readonly signal?: AbortSignal
  readonly resolve: (reservation: WorkspaceProcessReservation) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  abortListener: (() => void) | null
  settled: boolean
}

export interface ProjectFormatterOperationReservation {
  release(): void
}

interface QueuedProjectFormatterOperation {
  readonly workspaceKey: string
  readonly resolve: (reservation: ProjectFormatterOperationReservation) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  settled: boolean
}

/**
 * The formatter and project-config helper processes of one backend instance:
 * the processes it runs and their admission queue, the formatter operations
 * per workspace and theirs, and whether it admits new work.
 *
 * Bootstrap creates one per backend (`BootRoot.workspaceProcesses`) and
 * installs it as the default with {@link setDefaultWorkspaceProcessService},
 * so the formatter and project-config helpers, which reach it through
 * {@link runBoundedWorkspaceCommand} and
 * {@link reserveProjectFormatterOperation}, run through it; admission, the
 * startup unwind and the graceful drain hold the same instance directly. A
 * test builds its own instead of resetting module state.
 */
export class WorkspaceProcessService {
  private readonly activeProcesses = new Set<ActiveWorkspaceProcess>()
  private admissionsOpen = true
  private processReservations = 0
  private readonly processQueue: QueuedWorkspaceProcess[] = []
  private readonly formatterOperationsByWorkspace = new Map<string, number>()
  private readonly formatterQueue: QueuedProjectFormatterOperation[] = []
  private activeFormatterOperations = 0

  private createProjectFormatterOperationReservation(
    workspaceKey: string
  ): ProjectFormatterOperationReservation {
    this.activeFormatterOperations += 1
    this.formatterOperationsByWorkspace.set(
      workspaceKey,
      (this.formatterOperationsByWorkspace.get(workspaceKey) ?? 0) + 1
    )
    let held = true
    return {
      release: () => {
        if (!held) return
        held = false
        this.activeFormatterOperations -= 1
        const remaining =
          (this.formatterOperationsByWorkspace.get(workspaceKey) ?? 1) - 1
        if (remaining > 0) {
          this.formatterOperationsByWorkspace.set(workspaceKey, remaining)
        } else {
          this.formatterOperationsByWorkspace.delete(workspaceKey)
        }
        this.drainProjectFormatterOperationQueue()
      },
    }
  }

  private drainProjectFormatterOperationQueue(): void {
    if (!this.admissionsOpen) {
      const error = projectFormatterAdmissionError(
        "PROJECT_FORMATTER_SHUTTING_DOWN",
        "Project formatter service is shutting down."
      )
      for (const waiter of this.formatterQueue.splice(0)) {
        rejectQueuedProjectFormatterOperation(waiter, error)
      }
      return
    }

    while (
      this.activeFormatterOperations < MAX_ACTIVE_PROJECT_FORMAT_OPERATIONS &&
      this.formatterQueue.length > 0
    ) {
      const index = this.formatterQueue.findIndex(
        (waiter) =>
          !waiter.settled &&
          (this.formatterOperationsByWorkspace.get(waiter.workspaceKey) ?? 0) <
            MAX_ACTIVE_PROJECT_FORMAT_OPERATIONS_PER_WORKSPACE
      )
      if (index < 0) return
      const [waiter] = this.formatterQueue.splice(index, 1)
      if (!waiter || waiter.settled) continue
      waiter.settled = true
      cleanupQueuedProjectFormatterOperation(waiter)
      waiter.resolve(
        this.createProjectFormatterOperationReservation(waiter.workspaceKey)
      )
    }
  }

  async reserveFormatterOperation(
    root: string
  ): Promise<ProjectFormatterOperationReservation> {
    if (!this.admissionsOpen) {
      throw projectFormatterAdmissionError(
        "PROJECT_FORMATTER_SHUTTING_DOWN",
        "Project formatter service is shutting down."
      )
    }
    const workspaceKey = projectFormatterWorkspaceKey(root)
    const activeForWorkspace =
      this.formatterOperationsByWorkspace.get(workspaceKey) ?? 0
    if (
      this.activeFormatterOperations < MAX_ACTIVE_PROJECT_FORMAT_OPERATIONS &&
      activeForWorkspace < MAX_ACTIVE_PROJECT_FORMAT_OPERATIONS_PER_WORKSPACE
    ) {
      return this.createProjectFormatterOperationReservation(workspaceKey)
    }

    const queuedForWorkspace = this.formatterQueue.reduce(
      (count, waiter) =>
        count + Number(!waiter.settled && waiter.workspaceKey === workspaceKey),
      0
    )
    if (
      this.formatterQueue.length >= MAX_QUEUED_PROJECT_FORMAT_OPERATIONS ||
      queuedForWorkspace >= MAX_QUEUED_PROJECT_FORMAT_OPERATIONS_PER_WORKSPACE
    ) {
      throw projectFormatterAdmissionError(
        "PROJECT_FORMATTER_OVERLOADED",
        "Project formatter queue is full."
      )
    }

    return await new Promise<ProjectFormatterOperationReservation>(
      (resolve, reject) => {
        const waiter: QueuedProjectFormatterOperation = {
          workspaceKey,
          resolve,
          reject,
          timer: null,
          settled: false,
        }
        waiter.timer = setTimeout(() => {
          const index = this.formatterQueue.indexOf(waiter)
          if (index >= 0) this.formatterQueue.splice(index, 1)
          rejectQueuedProjectFormatterOperation(
            waiter,
            projectFormatterAdmissionError(
              "PROJECT_FORMATTER_QUEUE_TIMEOUT",
              "Project formatter request timed out while queued."
            )
          )
          this.drainProjectFormatterOperationQueue()
        }, MAX_PROJECT_FORMAT_QUEUE_WAIT_MS)
        waiter.timer.unref?.()
        this.formatterQueue.push(waiter)
      }
    )
  }

  /** Admitted and queued formatter operations, in all or in one workspace. */
  formatterAdmissionCounts(root?: string): {
    readonly active: number
    readonly queued: number
  } {
    if (!root) {
      return {
        active: this.activeFormatterOperations,
        queued: this.formatterQueue.length,
      }
    }
    const workspaceKey = projectFormatterWorkspaceKey(root)
    return {
      active: this.formatterOperationsByWorkspace.get(workspaceKey) ?? 0,
      queued: this.formatterQueue.filter(
        (waiter) => !waiter.settled && waiter.workspaceKey === workspaceKey
      ).length,
    }
  }

  private createWorkspaceProcessReservation(): WorkspaceProcessReservation {
    this.processReservations += 1
    let held = true
    return {
      commit: () => {
        if (!held) return
        held = false
        this.processReservations -= 1
      },
      release: () => {
        if (!held) return
        held = false
        this.processReservations -= 1
        this.drainWorkspaceProcessQueue()
      },
    }
  }

  private drainWorkspaceProcessQueue(): void {
    if (!this.admissionsOpen) {
      const error = workspaceAdmissionError(
        "WORKSPACE_PROCESS_SHUTTING_DOWN",
        "Workspace process service is shutting down."
      )
      for (const waiter of this.processQueue.splice(0)) {
        rejectQueuedWorkspaceProcess(waiter, error)
      }
      return
    }
    while (
      this.processQueue.length > 0 &&
      this.activeProcesses.size + this.processReservations <
        MAX_ACTIVE_WORKSPACE_PROCESSES
    ) {
      const waiter = this.processQueue.shift()!
      if (waiter.settled) continue
      if (waiter.signal?.aborted) {
        rejectQueuedWorkspaceProcess(
          waiter,
          workspaceAdmissionError(
            "WORKSPACE_PROCESS_ABORTED",
            "Workspace process request was aborted while queued."
          )
        )
        continue
      }
      waiter.settled = true
      cleanupQueuedWorkspaceProcess(waiter)
      waiter.resolve(this.createWorkspaceProcessReservation())
    }
  }

  private async reserveWorkspaceProcess(
    signal: AbortSignal | undefined,
    waitMs: number
  ): Promise<WorkspaceProcessReservation> {
    if (!this.admissionsOpen) {
      throw workspaceAdmissionError(
        "WORKSPACE_PROCESS_SHUTTING_DOWN",
        "Workspace process service is shutting down."
      )
    }
    if (signal?.aborted) {
      throw workspaceAdmissionError(
        "WORKSPACE_PROCESS_ABORTED",
        "Workspace process request was aborted."
      )
    }
    if (
      this.activeProcesses.size + this.processReservations <
      MAX_ACTIVE_WORKSPACE_PROCESSES
    ) {
      return this.createWorkspaceProcessReservation()
    }
    if (this.processQueue.length >= MAX_QUEUED_WORKSPACE_PROCESSES) {
      throw workspaceAdmissionError(
        "WORKSPACE_PROCESS_OVERLOADED",
        `Workspace process queue is full (${MAX_QUEUED_WORKSPACE_PROCESSES} waiting).`
      )
    }
    return await new Promise<WorkspaceProcessReservation>((resolve, reject) => {
      const waiter: QueuedWorkspaceProcess = {
        signal,
        resolve,
        reject,
        timer: null,
        abortListener: null,
        settled: false,
      }
      waiter.timer = setTimeout(
        () => {
          const index = this.processQueue.indexOf(waiter)
          if (index >= 0) this.processQueue.splice(index, 1)
          rejectQueuedWorkspaceProcess(
            waiter,
            workspaceAdmissionError(
              "WORKSPACE_PROCESS_QUEUE_TIMEOUT",
              "Workspace process request timed out while queued."
            )
          )
        },
        Math.max(1, waitMs)
      )
      waiter.timer.unref?.()
      if (signal) {
        waiter.abortListener = () => {
          const index = this.processQueue.indexOf(waiter)
          if (index >= 0) this.processQueue.splice(index, 1)
          rejectQueuedWorkspaceProcess(
            waiter,
            workspaceAdmissionError(
              "WORKSPACE_PROCESS_ABORTED",
              "Workspace process request was aborted while queued."
            )
          )
        }
        signal.addEventListener("abort", waiter.abortListener, { once: true })
      }
      this.processQueue.push(waiter)
    })
  }

  private removeActiveWorkspaceProcess(record: ActiveWorkspaceProcess): void {
    if (this.activeProcesses.delete(record)) {
      record.untrackTree()
      this.drainWorkspaceProcessQueue()
    }
  }

  activeProcessCount(): number {
    return this.activeProcesses.size
  }

  queuedProcessCount(): number {
    return this.processQueue.length
  }

  beginShutdown(): void {
    this.admissionsOpen = false
    this.drainWorkspaceProcessQueue()
    this.drainProjectFormatterOperationQueue()
  }

  resumeAdmissions(): void {
    if (
      this.activeProcesses.size > 0 ||
      this.processReservations > 0 ||
      this.processQueue.length > 0 ||
      this.activeFormatterOperations > 0 ||
      this.formatterQueue.length > 0
    ) {
      throw new Error(
        "Cannot reopen workspace process admission while a formatter operation or config helper remains retained."
      )
    }
    this.admissionsOpen = true
  }

  async shutdownAll(
    timeoutMs = WORKSPACE_PROCESS_TERMINATION_TIMEOUT_MS
  ): Promise<number> {
    this.beginShutdown()
    const processes = [...this.activeProcesses]
    if (processes.length === 0) return 0
    const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs))

    await Promise.allSettled(
      processes.map(async (record) => {
        await waitForWorkspacePromise(
          record.stop("shutdown"),
          Math.max(1, deadline - Date.now()),
          `${record.label} process-tree termination exceeded the shutdown deadline`
        )
        await waitForWorkspacePromise(
          record.settled,
          Math.max(1, deadline - Date.now()),
          `${record.label} did not settle after process-tree termination`
        )
      })
    )

    const survivors = processes.filter((record) =>
      this.activeProcesses.has(record)
    )
    if (survivors.length > 0) {
      throw Object.assign(
        new Error(
          `${survivors.length} workspace formatter/config process tree(s) could not be confirmed stopped.`
        ),
        {
          code: "WORKSPACE_PROCESS_SHUTDOWN_INCOMPLETE",
          processes: survivors.map((record) => ({
            label: record.label,
            pid: record.pid ?? null,
            rootExited: record.rootExited,
            stopReason: record.stopReason,
          })),
        }
      )
    }
    return processes.length
  }

  async runBoundedCommand(input: {
    command: string
    args: string[]
    /** Required when `args` is a pre-built cmd.exe line (see windowsCommandLine.ts). */
    windowsVerbatimArguments?: boolean
    cwd?: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    outputLimitBytes: number
    label: string
    signal?: AbortSignal
    beforeSpawn?: () => Promise<void>
    watchedFile?: {
      readonly path: string
      readonly maxBytes: number
      readonly expectedIdentity: WorkspacePathIdentity
      readonly parentChain: readonly WorkspaceDirectoryIdentity[]
    }
  }): Promise<BoundedWorkspaceCommandResult> {
    let reservation: WorkspaceProcessReservation
    try {
      reservation = await this.reserveWorkspaceProcess(
        input.signal,
        Math.min(
          MAX_WORKSPACE_PROCESS_QUEUE_WAIT_MS,
          Math.max(1, input.timeoutMs)
        )
      )
    } catch (error) {
      return {
        exitCode: null,
        stdout: "",
        stderr: errorMessage(error),
        timedOut: false,
        outputExceeded: false,
        failure: { kind: failureKindFromAdmissionError(error) },
      }
    }
    if (!this.admissionsOpen || input.signal?.aborted) {
      reservation.release()
      return {
        exitCode: null,
        stdout: "",
        stderr: input.signal?.aborted
          ? "Workspace process request was aborted."
          : "Workspace process service is shutting down.",
        timedOut: false,
        outputExceeded: false,
        failure: { kind: input.signal?.aborted ? "aborted" : "shutdown" },
      }
    }
    try {
      await input.beforeSpawn?.()
    } catch (error) {
      reservation.release()
      throw error
    }
    // Filesystem validation can yield while shutdown closes admission or the
    // caller cancels. Recheck immediately before the synchronous spawn.
    if (!this.admissionsOpen || input.signal?.aborted) {
      reservation.release()
      return {
        exitCode: null,
        stdout: "",
        stderr: input.signal?.aborted
          ? "Workspace process request was aborted."
          : "Workspace process service is shutting down.",
        timedOut: false,
        outputExceeded: false,
        failure: { kind: input.signal?.aborted ? "aborted" : "shutdown" },
      }
    }

    return await new Promise<BoundedWorkspaceCommandResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(input.command, input.args, {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          env: input.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: input.windowsVerbatimArguments === true,
          detached: process.platform !== "win32",
        })
      } catch (error) {
        reservation.release()
        resolve({
          exitCode: null,
          stdout: "",
          stderr: errorMessage(error),
          timedOut: false,
          outputExceeded: false,
          failure: { kind: "spawn-error" },
        })
        return
      }

      let resolveRootExit!: () => void
      let resolveProcessSettled!: () => void
      const rootExit = new Promise<void>((resolveExit) => {
        resolveRootExit = resolveExit
      })
      const processSettled = new Promise<void>((resolveSettled) => {
        resolveProcessSettled = resolveSettled
      })
      const record: ActiveWorkspaceProcess = {
        child,
        pid: child.pid,
        label: input.label,
        rootExit,
        settled: processSettled,
        resolveRootExit,
        resolveSettled: resolveProcessSettled,
        rootExited: false,
        settledResult: false,
        treeUnconfirmed: false,
        stopReason: null,
        termination: null,
        stop: async () => undefined,
        untrackTree: trackChildProcessTree(child, input.label),
      }
      record.stop = async (reason) => {
        if (!record.stopReason || record.stopReason === "shutdown") {
          record.stopReason = reason
        }
        if (record.termination) return await record.termination
        const operation = terminateWorkspaceProcessTree(
          record,
          WORKSPACE_PROCESS_TERMINATION_TIMEOUT_MS
        )
        record.termination = operation
        try {
          await operation
          record.treeUnconfirmed = false
          if (record.settledResult || record.rootExited) {
            this.removeActiveWorkspaceProcess(record)
          }
        } finally {
          if (record.termination === operation) record.termination = null
        }
      }
      this.activeProcesses.add(record)
      reservation.commit()

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let timedOut = false
      let outputExceeded = false
      let fileOutputExceeded = false
      let watchedFileError: string | null = null
      let watchedFileCheckRunning = false
      let watchedFileTimer: ReturnType<typeof setInterval> | null = null
      let spawnError: Error | null = null
      let settled = false
      let abortListener: (() => void) | null = null

      const markRootExited = () => {
        if (record.rootExited) return
        record.rootExited = true
        record.resolveRootExit()
      }
      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        treeError?: unknown
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (watchedFileTimer) clearInterval(watchedFileTimer)
        watchedFileTimer = null
        child.stdout?.removeListener("data", onStdout)
        child.stderr?.removeListener("data", onStderr)
        if (abortListener) {
          input.signal?.removeEventListener("abort", abortListener)
          abortListener = null
        }
        const unsafeTree = treeError ? errorMessage(treeError) : undefined
        record.settledResult = true
        record.treeUnconfirmed = Boolean(unsafeTree)
        if (!unsafeTree) this.removeActiveWorkspaceProcess(record)
        record.resolveSettled()
        const failureKind: WorkspaceProcessFailureKind | null = spawnError
          ? "spawn-error"
          : record.stopReason === "abort"
            ? "aborted"
            : record.stopReason === "shutdown"
              ? "shutdown"
              : null
        resolve({
          exitCode,
          signal,
          ...(failureKind ? { failure: { kind: failureKind } } : {}),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: [
            Buffer.concat(stderr).toString("utf8"),
            spawnError?.message,
            record.stopReason === "abort"
              ? "Workspace process request was aborted."
              : record.stopReason === "shutdown"
                ? "Workspace process service is shutting down."
                : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          timedOut,
          outputExceeded,
          ...(fileOutputExceeded ? { fileOutputExceeded: true } : {}),
          ...(watchedFileError ? { watchedFileError } : {}),
          ...(unsafeTree ? { treeError: unsafeTree } : {}),
        })
      }
      const stop = (reason: WorkspaceProcessStopReason) => {
        if (reason === "timeout") timedOut = true
        if (reason === "output") outputExceeded = true
        child.stdout?.pause()
        child.stderr?.pause()
        void record.stop(reason).catch((error) => finish(null, null, error))
      }
      const checkWatchedFile = async () => {
        if (
          !input.watchedFile ||
          settled ||
          record.stopReason ||
          watchedFileCheckRunning
        ) {
          return
        }
        watchedFileCheckRunning = true
        try {
          await assertFormatterStagingDirectoriesUnchanged(
            input.watchedFile.parentChain
          )
          const stat = await fs.lstat(input.watchedFile.path)
          if (settled || record.stopReason) return
          if (stat.isSymbolicLink() || !stat.isFile()) {
            watchedFileError =
              "Formatter staging path changed during execution."
            stop("staging-change")
            return
          }
          if (
            !sameWorkspacePathIdentity(
              input.watchedFile.expectedIdentity,
              workspacePathIdentity(stat)
            )
          ) {
            watchedFileError =
              "Formatter staging path changed during execution."
            stop("staging-change")
            return
          }
          if (stat.size > input.watchedFile.maxBytes) {
            fileOutputExceeded = true
            stop("file-output")
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return
          if (settled || record.stopReason) return
          watchedFileError = "Formatter staging path changed during execution."
          stop("staging-change")
        } finally {
          watchedFileCheckRunning = false
        }
      }
      const append = (target: Buffer[], chunk: Buffer) => {
        if (record.stopReason) return
        const remaining = input.outputLimitBytes - outputBytes
        if (remaining <= 0) {
          stop("output")
          return
        }
        if (chunk.byteLength > remaining) {
          target.push(chunk.subarray(0, remaining))
          outputBytes += remaining
          stop("output")
          return
        }
        target.push(chunk)
        outputBytes += chunk.byteLength
      }
      const onStdout = (chunk: Buffer | string) =>
        append(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const onStderr = (chunk: Buffer | string) =>
        append(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))

      child.stdout?.on("data", onStdout)
      child.stderr?.on("data", onStderr)
      child.once("exit", markRootExited)
      child.once("error", (error) => {
        spawnError = error
        if (!record.pid) {
          markRootExited()
          finish(null, null)
          return
        }
        stop("spawn-error")
      })
      child.once("close", async (exitCode, signal) => {
        markRootExited()
        try {
          if (record.stopReason) {
            await record.termination
          } else if (process.platform !== "win32" && record.pid) {
            await ensurePosixProcessGroupTerminated(record.pid)
          }
          finish(exitCode, signal)
        } catch (error) {
          finish(exitCode, signal, error)
        }
      })

      const timeout = setTimeout(
        () => stop("timeout"),
        Math.max(1, input.timeoutMs)
      )
      timeout.unref?.()
      if (input.watchedFile) {
        watchedFileTimer = setInterval(() => {
          void checkWatchedFile()
        }, 25)
        watchedFileTimer.unref?.()
        void checkWatchedFile()
      }
      if (input.signal) {
        abortListener = () => stop("abort")
        input.signal.addEventListener("abort", abortListener, { once: true })
        if (input.signal.aborted) abortListener()
      }
    })
  }
}

/**
 * The service the workspace helpers use. Bootstrap installs each backend's
 * own instance at startup (`setDefaultWorkspaceProcessService` in
 * `reopenResourceAdmissions`); the formatter and project-config helpers are
 * plain functions with many callers, so they keep reading this one slot
 * instead of taking the service as a parameter. Code that runs them outside
 * a backend (tests, tooling) and installed nothing gets an instance created
 * on first use, never at import.
 */
let defaultWorkspaceProcesses: WorkspaceProcessService | null = null

/**
 * Installs `service` as the one the workspace helpers use; null forgets
 * the installed one. Bootstrap calls this once per backend at startup.
 */
export function setDefaultWorkspaceProcessService(
  service: WorkspaceProcessService | null
): void {
  defaultWorkspaceProcesses = service
}

/** The installed service, or one created now when none is installed. */
export function defaultWorkspaceProcessService(): WorkspaceProcessService {
  defaultWorkspaceProcesses ??= new WorkspaceProcessService()
  return defaultWorkspaceProcesses
}

/** Runs a formatter or config helper under the default service's admission. */
export async function runBoundedWorkspaceCommand(
  input: Parameters<WorkspaceProcessService["runBoundedCommand"]>[0]
): Promise<BoundedWorkspaceCommandResult> {
  return await defaultWorkspaceProcessService().runBoundedCommand(input)
}

/** Reserves a formatter operation slot from the default service. */
export async function reserveProjectFormatterOperation(
  root: string
): Promise<ProjectFormatterOperationReservation> {
  return await defaultWorkspaceProcessService().reserveFormatterOperation(root)
}

function workspaceAdmissionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function failureKindFromAdmissionError(
  error: unknown
): WorkspaceProcessFailureKind {
  switch ((error as { code?: unknown } | null)?.code) {
    case "WORKSPACE_PROCESS_OVERLOADED":
      return "queue-full"
    case "WORKSPACE_PROCESS_QUEUE_TIMEOUT":
      return "queue-timeout"
    case "WORKSPACE_PROCESS_ABORTED":
      return "aborted"
    case "WORKSPACE_PROCESS_SHUTTING_DOWN":
      return "shutdown"
    default:
      return "spawn-error"
  }
}

function projectFormatterAdmissionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, statusCode: 503 })
}

function projectFormatterWorkspaceKey(root: string): string {
  const resolved = path.resolve(root)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function cleanupQueuedProjectFormatterOperation(
  waiter: QueuedProjectFormatterOperation
): void {
  if (waiter.timer) clearTimeout(waiter.timer)
  waiter.timer = null
}

function rejectQueuedProjectFormatterOperation(
  waiter: QueuedProjectFormatterOperation,
  error: Error
): void {
  if (waiter.settled) return
  waiter.settled = true
  cleanupQueuedProjectFormatterOperation(waiter)
  waiter.reject(error)
}

function cleanupQueuedWorkspaceProcess(waiter: QueuedWorkspaceProcess): void {
  if (waiter.timer) clearTimeout(waiter.timer)
  waiter.timer = null
  if (waiter.abortListener) {
    waiter.signal?.removeEventListener("abort", waiter.abortListener)
  }
  waiter.abortListener = null
}

function rejectQueuedWorkspaceProcess(
  waiter: QueuedWorkspaceProcess,
  error: Error
): void {
  if (waiter.settled) return
  waiter.settled = true
  cleanupQueuedWorkspaceProcess(waiter)
  waiter.reject(error)
}

async function terminateWorkspaceProcessTree(
  record: ActiveWorkspaceProcess,
  timeoutMs: number
): Promise<void> {
  const pid = record.pid
  if (pid == null) {
    if (!record.rootExited) record.child.kill("SIGKILL")
    await waitForWorkspacePromise(
      record.rootExit,
      timeoutMs,
      `${record.label} root process did not exit`
    )
    throw new Error(
      `${record.label} had no PID, so descendant termination could not be verified.`
    )
  }

  if (process.platform === "win32") {
    if (record.rootExited) {
      if (record.treeUnconfirmed) {
        throw new Error(
          `${record.label} root exited before its Windows process tree could be confirmed.`
        )
      }
      // `taskkill /T` needs a live root PID. Once the root is gone its
      // descendants (a formatter that spawned a daemon, say) cannot be
      // addressed without a Job Object, which is native code this backend
      // does not ship. Say so rather than report a clean stop.
      logger.warn(
        { label: record.label, pid, reason: record.stopReason },
        "workspace process root already exited before tree termination; descendants may be orphaned on Windows"
      )
      return
    }
    let softStopSucceeded = false
    try {
      await runWindowsTaskkill(pid, false, {
        timeoutMs: Math.min(2_000, timeoutMs),
      })
      softStopSucceeded = true
    } catch {
      // Escalate below while the root PID is still owned by this child.
    }
    if (softStopSucceeded && !record.rootExited) {
      try {
        await waitForWorkspacePromise(
          record.rootExit,
          Math.min(1_000, Math.max(1, timeoutMs - 2_000)),
          `${record.label} ignored graceful Windows tree termination`
        )
      } catch {
        // Force the same still-owned process tree below.
      }
    }
    if (!record.rootExited) {
      await runWindowsTaskkill(pid, true, {
        timeoutMs: Math.max(1, timeoutMs - 3_000),
      })
    }
  } else {
    await ensurePosixProcessGroupTerminated(pid)
  }

  await waitForWorkspacePromise(
    record.rootExit,
    timeoutMs,
    `${record.label} root process did not exit after tree termination`
  )
}

async function waitForWorkspacePromise(
  promise: Promise<void>,
  timeoutMs: number,
  message: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error(message), {
                code: "WORKSPACE_PROCESS_SETTLEMENT_TIMEOUT",
              })
            ),
          Math.max(1, timeoutMs)
        )
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export { errorMessage }
