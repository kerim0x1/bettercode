/**
 * Running `git` itself: admission limits per process and per workspace,
 * the bounded output pipe, timeouts, and process-tree termination on
 * Windows and POSIX. Every other file in this folder goes through `gitRun`.
 */

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import { sanitizedChildEnvironment } from "../../security/childEnvironment"
import {
  formatTaskkillResult,
  isNoSuchProcessError,
  runWindowsTaskkillDetailed,
  type TaskkillSpawn,
} from "../process-termination"
import path from "node:path"

const DEFAULT_GIT_TIMEOUT_MS = 120_000

const GIT_OUTPUT_MAX_BYTES = 32 * 1024 * 1024

const GIT_PROCESS_TERMINATION_TIMEOUT_MS = 5_000

const WINDOWS_TASKKILL_TIMEOUT_MS = 1_000

const GIT_PROCESS_EXIT_POLL_MS = 25

const DEFAULT_MAX_CONCURRENT_GIT_PROCESSES = 8

const DEFAULT_MAX_CONCURRENT_GIT_PER_WORKSPACE = 4

const DEFAULT_MAX_QUEUED_GIT_PROCESSES = 64

const DEFAULT_GIT_ADMISSION_WAIT_MS = 30_000

type GitStopReason = "timeout" | "output" | "shutdown" | "error"

interface GitProcessTerminationResult {
  confirmed: boolean
  detail: string
}

interface ActiveGitProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly pid: number | undefined
  readonly cwd: string
  readonly args: readonly string[]
  readonly rootExitPromise: Promise<void>
  resolveRootExit: () => void
  rootExited: boolean
  stopReason: GitStopReason | null
  treeUnconfirmed: boolean
  terminationPromise: Promise<GitProcessTerminationResult> | null
  onTerminationResult: (result: GitProcessTerminationResult) => void
  releaseAdmission: () => void
}

interface GitAdmissionLimits {
  readonly maxConcurrent: number
  readonly maxPerWorkspace: number
  readonly maxQueued: number
  readonly waitMs: number
}

interface GitAdmissionWaiter {
  readonly cwdKey: string
  readonly resolve: (release: () => void) => void
  readonly reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  settled: boolean
}

interface GitProcessDependencies {
  readonly platform: NodeJS.Platform
  readonly spawn: typeof spawn
  readonly killProcess: (pid: number, signal: NodeJS.Signals | 0) => void
}

const defaultGitProcessDependencies: GitProcessDependencies = {
  platform: process.platform,
  spawn,
  killProcess: (pid, signal) => {
    process.kill(pid, signal)
  },
}

let gitProcessDependencies = defaultGitProcessDependencies

let gitProcessAdmissionsOpen = true

const activeGitProcesses = new Set<ActiveGitProcess>()

let activeGitAdmissions = 0

const activeGitAdmissionsByWorkspace = new Map<string, number>()

const gitAdmissionQueue: GitAdmissionWaiter[] = []

function boundedEnvironmentInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback
}

const defaultGitAdmissionLimits: GitAdmissionLimits = {
  maxConcurrent: boundedEnvironmentInteger(
    process.env.BETTERC0DE_GIT_MAX_CONCURRENCY,
    DEFAULT_MAX_CONCURRENT_GIT_PROCESSES,
    1,
    64
  ),
  maxPerWorkspace: boundedEnvironmentInteger(
    process.env.BETTERC0DE_GIT_MAX_PER_WORKSPACE,
    DEFAULT_MAX_CONCURRENT_GIT_PER_WORKSPACE,
    1,
    32
  ),
  maxQueued: boundedEnvironmentInteger(
    process.env.BETTERC0DE_GIT_MAX_QUEUE,
    DEFAULT_MAX_QUEUED_GIT_PROCESSES,
    0,
    512
  ),
  waitMs: boundedEnvironmentInteger(
    process.env.BETTERC0DE_GIT_ADMISSION_WAIT_MS,
    DEFAULT_GIT_ADMISSION_WAIT_MS,
    100,
    120_000
  ),
}

let gitAdmissionLimits = defaultGitAdmissionLimits

function gitWorkspaceKey(cwd: string): string {
  const resolved = path.resolve(cwd)
  return gitProcessDependencies.platform === "win32"
    ? resolved.toLowerCase()
    : resolved
}

function gitCapacityError(
  code: "GIT_CAPACITY_EXCEEDED" | "GIT_ADMISSION_TIMEOUT",
  message: string
): Error {
  return Object.assign(new Error(message), {
    statusCode: 503,
    code,
    retryAfterMs: Math.min(gitAdmissionLimits.waitMs, 5_000),
  })
}

function gitShuttingDownError(): Error {
  return Object.assign(new Error("Git service is shutting down."), {
    statusCode: 503,
    code: "GIT_SHUTTING_DOWN",
  })
}

function canGrantGitAdmission(cwdKey: string): boolean {
  return (
    activeGitAdmissions < gitAdmissionLimits.maxConcurrent &&
    (activeGitAdmissionsByWorkspace.get(cwdKey) ?? 0) <
      gitAdmissionLimits.maxPerWorkspace
  )
}

function grantGitAdmission(cwdKey: string): () => void {
  activeGitAdmissions += 1
  activeGitAdmissionsByWorkspace.set(
    cwdKey,
    (activeGitAdmissionsByWorkspace.get(cwdKey) ?? 0) + 1
  )
  let released = false
  return () => {
    if (released) return
    released = true
    activeGitAdmissions = Math.max(0, activeGitAdmissions - 1)
    const workspaceCount = (activeGitAdmissionsByWorkspace.get(cwdKey) ?? 1) - 1
    if (workspaceCount > 0) {
      activeGitAdmissionsByWorkspace.set(cwdKey, workspaceCount)
    } else {
      activeGitAdmissionsByWorkspace.delete(cwdKey)
    }
    drainGitAdmissionQueue()
  }
}

function rejectQueuedGitAdmissions(error: Error): void {
  for (const waiter of gitAdmissionQueue.splice(0)) {
    if (waiter.settled) continue
    waiter.settled = true
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.reject(error)
  }
}

function drainGitAdmissionQueue(): void {
  if (!gitProcessAdmissionsOpen) {
    rejectQueuedGitAdmissions(gitShuttingDownError())
    return
  }
  while (
    gitAdmissionQueue.length > 0 &&
    activeGitAdmissions < gitAdmissionLimits.maxConcurrent
  ) {
    const eligibleIndex = gitAdmissionQueue.findIndex(
      (waiter) => !waiter.settled && canGrantGitAdmission(waiter.cwdKey)
    )
    if (eligibleIndex < 0) return
    const [waiter] = gitAdmissionQueue.splice(eligibleIndex, 1)
    if (!waiter || waiter.settled) continue
    waiter.settled = true
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.resolve(grantGitAdmission(waiter.cwdKey))
  }
}

function acquireGitAdmission(cwd: string): (() => void) | Promise<() => void> {
  if (!gitProcessAdmissionsOpen) throw gitShuttingDownError()
  const cwdKey = gitWorkspaceKey(cwd)
  if (canGrantGitAdmission(cwdKey)) {
    return grantGitAdmission(cwdKey)
  }
  if (gitAdmissionQueue.length >= gitAdmissionLimits.maxQueued) {
    throw gitCapacityError(
      "GIT_CAPACITY_EXCEEDED",
      "Git process capacity is exhausted; retry after current work completes."
    )
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: GitAdmissionWaiter = {
      cwdKey,
      resolve,
      reject,
      timer: null,
      settled: false,
    }
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return
      waiter.settled = true
      const index = gitAdmissionQueue.indexOf(waiter)
      if (index >= 0) gitAdmissionQueue.splice(index, 1)
      reject(
        gitCapacityError(
          "GIT_ADMISSION_TIMEOUT",
          "Timed out waiting for bounded Git process capacity."
        )
      )
    }, gitAdmissionLimits.waitMs)
    waiter.timer.unref?.()
    gitAdmissionQueue.push(waiter)
  })
}

function retireGitProcess(record: ActiveGitProcess): void {
  if (!activeGitProcesses.delete(record)) return
  record.releaseAdmission()
}

export function activeGitProcessCount(): number {
  return activeGitProcesses.size
}

/** Test-only observability; no production caller needs the queue depth. */
export function __queuedGitProcessCountForTests(): number {
  return gitAdmissionQueue.length
}

export function resumeGitProcessAdmissions(): void {
  if (activeGitProcesses.size > 0 || activeGitAdmissions > 0) {
    throw new Error(
      "Cannot reopen Git admissions while retained process resources remain."
    )
  }
  gitProcessAdmissionsOpen = true
  drainGitAdmissionQueue()
}

/** Close admission without terminating already-running Git children. */
export function beginGitProcessShutdown(): void {
  gitProcessAdmissionsOpen = false
  rejectQueuedGitAdmissions(gitShuttingDownError())
}

/**
 * Stop every retained Git child and verify that its process tree exited.
 *
 * Admissions close before the snapshot is taken, so a concurrent background
 * task cannot race a new child into the teardown. A process whose tree cannot
 * be confirmed dead deliberately remains registered and makes shutdown fail;
 * dropping it here would turn a leaked child into an invisible orphan.
 */
export async function shutdownAllGitProcesses(
  graceMs = GIT_PROCESS_TERMINATION_TIMEOUT_MS
): Promise<number> {
  beginGitProcessShutdown()
  const retained = [...activeGitProcesses]
  if (retained.length === 0) return 0
  const boundedGraceMs = Number.isFinite(graceMs)
    ? Math.max(1, Math.floor(graceMs))
    : GIT_PROCESS_TERMINATION_TIMEOUT_MS

  await Promise.all(
    retained.map((record) =>
      requestGitProcessStop(record, "shutdown", boundedGraceMs)
    )
  )

  const survivors = retained.filter((record) => activeGitProcesses.has(record))
  if (survivors.length > 0) {
    throw Object.assign(
      new Error(
        `${survivors.length} Git process tree(s) could not be confirmed stopped during shutdown.`
      ),
      {
        code: "GIT_SHUTDOWN_INCOMPLETE",
        processes: survivors.map((record) => ({
          pid: record.pid ?? null,
          cwd: record.cwd,
          gitArgs: [...record.args],
          rootExited: record.rootExited,
          treeUnconfirmed: record.treeUnconfirmed,
        })),
      }
    )
  }
  return retained.length
}

/** Test seam for deterministic taskkill/process-tree lifecycle coverage. */
export function __setGitProcessDependenciesForTests(
  overrides: Partial<GitProcessDependencies> | null
): void {
  gitProcessDependencies = overrides
    ? { ...defaultGitProcessDependencies, ...overrides }
    : defaultGitProcessDependencies
}

export function __setGitAdmissionLimitsForTests(
  limits: Partial<GitAdmissionLimits> | null
): void {
  if (
    activeGitProcesses.size > 0 ||
    activeGitAdmissions > 0 ||
    gitAdmissionQueue.length > 0
  ) {
    throw new Error(
      "Cannot change Git admission limits while work is active or queued."
    )
  }
  gitAdmissionLimits = limits
    ? {
        maxConcurrent: Math.max(
          1,
          Math.floor(
            limits.maxConcurrent ?? defaultGitAdmissionLimits.maxConcurrent
          )
        ),
        maxPerWorkspace: Math.max(
          1,
          Math.floor(
            limits.maxPerWorkspace ?? defaultGitAdmissionLimits.maxPerWorkspace
          )
        ),
        maxQueued: Math.max(
          0,
          Math.floor(limits.maxQueued ?? defaultGitAdmissionLimits.maxQueued)
        ),
        waitMs: Math.max(
          1,
          Math.floor(limits.waitMs ?? defaultGitAdmissionLimits.waitMs)
        ),
      }
    : defaultGitAdmissionLimits
}

/**
 * Port of rust-backend/src/services/git.rs + rust-backend/src/git/*. Every
 * function runs `git` via execFile (no shell interpolation, safe against
 * injection through the `cwd` argument and file-list args).
 */

/**
 * Hardened git env (S5):
 *
 *  - GIT_TERMINAL_PROMPT=0 / GIT_ASKPASS=echo: no interactive credential prompts;
 *    a missing credential fails fast instead of hanging the backend forever.
 *  - GIT_CONFIG_NOSYSTEM=1: ignore /etc/gitconfig / system-wide git config so a
 *    poisoned shared config can't redirect remotes via `url.<base>.insteadOf`
 *    or inject `core.sshCommand`.
 *  - GIT_PROTOCOL_FROM_USER=0 + protocol.allow=user: allow only the network
 *    protocols git considers safe; refuse `ext::`, `file://` (handled at the
 *    URL validator below as well), etc.
 */
const HARDENED_GIT_ENV: NodeJS.ProcessEnv = {
  ...sanitizedChildEnvironment(),
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  GCM_INTERACTIVE: "Never",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_LITERAL_PATHSPECS: "1",
  PAGER: "cat",
}

const PROTECTED_GIT_ENV_KEYS = [
  "GIT_TERMINAL_PROMPT",
  "GIT_ASKPASS",
  "GCM_INTERACTIVE",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_EDITOR",
  "GIT_PAGER",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_LITERAL_PATHSPECS",
  "PAGER",
] as const

function gitProcessEnvironment(
  overrides?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...HARDENED_GIT_ENV, ...overrides }
  for (const key of PROTECTED_GIT_ENV_KEYS) env[key] = HARDENED_GIT_ENV[key]
  return env
}

interface GitRunOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  input?: string | Buffer
}

const DIFF_FAMILY_GIT_COMMANDS = new Set([
  "diff",
  "diff-tree",
  "diff-index",
  "diff-files",
  "log",
  "show",
])

export async function gitRun(
  cwd: string,
  args: string[],
  opts: GitRunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const safeArgs = gitArgsWithoutRepositoryHelpers(cwd, args, opts)
  return await runGitProcess(cwd, args, opts, safeArgs)
}

/**
 * Repository config can name a program: FSMonitor, clean/process filters,
 * `core.sshCommand`, and `ext::` remotes. Every git invocation, including
 * add/commit/fetch, overrides those for this process. Diff-family commands
 * also refuse external diffs and textconv. The lookup is a direct config
 * read so it does not take a Git admission slot or run those helpers.
 */
function gitArgsWithoutRepositoryHelpers(
  cwd: string,
  args: string[],
  opts: GitRunOptions
): string[] {
  let commandIndex = 0
  while (args[commandIndex] === "-c") commandIndex += 2
  const command = args[commandIndex]
  if (!command) return args

  const prefix = args.slice(0, commandIndex)
  const filterKeys = localGitConfigList(
    cwd,
    [
      ...prefix,
      "config",
      "--local",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process|required)$",
    ],
    opts
  )
  const localSshCommand = localGitConfigList(
    cwd,
    [...prefix, "config", "--local", "--get", "core.sshCommand"],
    opts
  )
    .join("")
    .trim()
  const overrides = [
    "core.fsmonitor=false",
    "log.showSignature=false",
    "protocol.ext.allow=never",
    ...(localSshCommand ? ["core.sshCommand=ssh"] : []),
    ...filterKeys.map(
      (key) => `${key}=${key.endsWith(".required") ? "false" : ""}`
    ),
  ].flatMap((config) => ["-c", config])
  return [
    ...prefix,
    ...overrides,
    command,
    ...(DIFF_FAMILY_GIT_COMMANDS.has(command)
      ? ["--no-ext-diff", "--no-textconv"]
      : []),
    ...args.slice(commandIndex + 1),
  ]
}

function localGitConfigList(
  cwd: string,
  args: string[],
  opts: GitRunOptions
): string[] {
  const result = spawnSync("git", args, {
    cwd,
    env: gitProcessEnvironment(opts.env),
    encoding: "utf8",
    windowsHide: true,
    timeout: Math.min(opts.timeoutMs ?? 10_000, 10_000),
  })
  if (result.status === 0) {
    return [...new Set((result.stdout ?? "").split("\0").filter(Boolean))]
  }
  if (
    result.status === 1 ||
    result.status === 128 ||
    result.error !== undefined
  ) {
    return []
  }
  const detail = (result.stderr || result.stdout || "").trim()
  throw Object.assign(new Error(detail || "git config probe failed"), {
    code: result.status,
  })
}

async function runGitProcess(
  cwd: string,
  args: string[],
  opts: GitRunOptions,
  spawnArgs = args
): Promise<{ stdout: string; stderr: string }> {
  const admission = acquireGitAdmission(cwd)
  const releaseAdmission =
    typeof admission === "function" ? admission : await admission
  if (!gitProcessAdmissionsOpen) {
    releaseAdmission()
    throw gitShuttingDownError()
  }
  let admissionTransferred = false
  try {
    return await new Promise((resolve, reject) => {
      const child = gitProcessDependencies.spawn("git", spawnArgs, {
        cwd,
        env: gitProcessEnvironment(opts.env),
        windowsHide: true,
        detached: gitProcessDependencies.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let timedOut = false
      let outputExceeded = false
      let spawnError: Error | null = null
      let timeoutTimer: NodeJS.Timeout | null = null
      let closeCode: number | string | null = null
      let closeSignal: NodeJS.Signals | null = null
      let resolveRootExit!: () => void
      const rootExitPromise = new Promise<void>((resolveExit) => {
        resolveRootExit = resolveExit
      })
      const record: ActiveGitProcess = {
        child,
        pid: child.pid,
        cwd,
        args: [...args],
        rootExitPromise,
        resolveRootExit,
        rootExited: false,
        stopReason: null,
        treeUnconfirmed: false,
        terminationPromise: null,
        onTerminationResult: () => {},
        releaseAdmission,
      }
      activeGitProcesses.add(record)
      admissionTransferred = true

      const outputText = (chunks: Buffer[]) =>
        Buffer.concat(chunks).toString("utf8")
      const finish = (
        code: number | string | null,
        signal: NodeJS.Signals | null,
        terminationResult?: GitProcessTerminationResult
      ) => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        child.stdout.removeListener("data", onStdoutData)
        child.stderr.removeListener("data", onStderrData)
        child.stdin.removeListener("error", onStdinError)
        const stdoutText = outputText(stdout)
        const stderrText = outputText(stderr)
        if (
          code === 0 &&
          !timedOut &&
          !outputExceeded &&
          !spawnError &&
          record.stopReason === null &&
          (!terminationResult || terminationResult.confirmed)
        ) {
          resolve({ stdout: stdoutText, stderr: stderrText })
          return
        }
        const commandReason = timedOut
          ? `git ${args[0] ?? "command"} timed out`
          : outputExceeded
            ? `git ${args[0] ?? "command"} exceeded the output limit`
            : record.stopReason === "shutdown"
              ? `git ${args[0] ?? "command"} was stopped during shutdown`
              : spawnError?.message
        const survivorReason =
          terminationResult && !terminationResult.confirmed
            ? `Git process tree termination could not be confirmed: ${terminationResult.detail}`
            : null
        const detail = [
          stderrText.trim(),
          stdoutText.trim(),
          commandReason,
          survivorReason,
        ]
          .filter(Boolean)
          .join("\n")
        const survivor = Boolean(
          terminationResult && !terminationResult.confirmed
        )
        reject(
          Object.assign(
            new Error(detail || `git ${args[0] ?? "command"} failed`),
            {
              name: survivor ? "GitProcessSurvivorError" : "GitCommandError",
              code: survivor ? "GIT_PROCESS_SURVIVOR" : code,
              exitCode: code,
              killed: record.stopReason !== null,
              signal,
              stdout: stdoutText,
              stderr: stderrText,
              gitArgs: [...args],
              survivor,
            }
          )
        )
      }
      record.onTerminationResult = (result) => {
        if (!result.confirmed) record.treeUnconfirmed = true
        finish(closeCode, closeSignal ?? "SIGKILL", result)
      }

      const stop = (reason: "timeout" | "output") => {
        if (settled) return
        timedOut ||= reason === "timeout"
        outputExceeded ||= reason === "output"
        child.stdout.pause()
        child.stderr.pause()
        child.stdin.destroy()
        void requestGitProcessStop(
          record,
          reason,
          GIT_PROCESS_TERMINATION_TIMEOUT_MS
        )
      }
      const append = (
        target: Buffer[],
        chunk: Buffer,
        stream: "stdout" | "stderr"
      ) => {
        if (record.stopReason) return
        if (stream === "stdout") stdoutBytes += chunk.byteLength
        else stderrBytes += chunk.byteLength
        if (stdoutBytes + stderrBytes > GIT_OUTPUT_MAX_BYTES) {
          stop("output")
          return
        }
        target.push(chunk)
      }

      const onStdoutData = (chunk: Buffer) => append(stdout, chunk, "stdout")
      const onStderrData = (chunk: Buffer) => append(stderr, chunk, "stderr")
      const onStdinError = () => {
        // A fast-failing git process can close stdin before the write completes;
        // the close event carries the authoritative command failure.
      }
      const markRootExited = () => {
        if (record.rootExited) return
        record.rootExited = true
        record.resolveRootExit()
      }
      child.stdout.on("data", onStdoutData)
      child.stderr.on("data", onStderrData)
      child.once("exit", markRootExited)
      child.once("error", (error) => {
        spawnError = error
        if (!record.pid) {
          markRootExited()
          retireGitProcess(record)
          finish(null, null)
          return
        }
        if (!record.stopReason) {
          void requestGitProcessStop(
            record,
            "error",
            GIT_PROCESS_TERMINATION_TIMEOUT_MS
          )
        }
      })
      child.once("close", async (code, signal) => {
        closeCode = code
        closeSignal = signal
        markRootExited()
        if (record.stopReason) return
        if (gitProcessDependencies.platform !== "win32" && record.pid) {
          let treeResult: GitProcessTerminationResult
          try {
            treeResult = await terminatePosixGitProcessTree(
              record,
              Date.now() + GIT_PROCESS_TERMINATION_TIMEOUT_MS
            )
          } catch (error) {
            treeResult = {
              confirmed: false,
              detail: `normal-exit process-group finalization failed: ${errorMessage(error)}`,
            }
          }
          if (!treeResult.confirmed) {
            record.treeUnconfirmed = true
            finish(code, signal, treeResult)
            return
          }
        }
        retireGitProcess(record)
        finish(code, signal)
      })
      child.stdin.on("error", onStdinError)

      timeoutTimer = setTimeout(
        () => stop("timeout"),
        opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
      )
      timeoutTimer.unref?.()
      child.stdin.end(opts.input)
    })
  } finally {
    if (!admissionTransferred) releaseAdmission()
  }
}

async function requestGitProcessStop(
  record: ActiveGitProcess,
  reason: GitStopReason,
  graceMs: number
): Promise<GitProcessTerminationResult> {
  if (record.stopReason === null || record.stopReason === "shutdown") {
    record.stopReason = reason
  }
  record.child.stdout.pause()
  record.child.stderr.pause()
  record.child.stdin.destroy()
  if (record.terminationPromise) return record.terminationPromise

  const operation = terminateGitProcessTree(record, graceMs).then((result) => {
    if (result.confirmed) {
      retireGitProcess(record)
    } else {
      record.treeUnconfirmed = true
    }
    record.onTerminationResult(result)
    return result
  })
  record.terminationPromise = operation
  try {
    return await operation
  } finally {
    if (record.terminationPromise === operation) {
      record.terminationPromise = null
    }
  }
}

async function terminateGitProcessTree(
  record: ActiveGitProcess,
  graceMs: number
): Promise<GitProcessTerminationResult> {
  const deadline = Date.now() + Math.max(1, graceMs)
  observeSynchronousChildExit(record)
  if (gitProcessDependencies.platform === "win32") {
    return terminateWindowsGitProcessTree(record, deadline)
  }
  return terminatePosixGitProcessTree(record, deadline)
}

async function terminateWindowsGitProcessTree(
  record: ActiveGitProcess,
  deadline: number
): Promise<GitProcessTerminationResult> {
  if (record.rootExited) {
    return {
      confirmed: false,
      detail:
        "the root process exited before Windows process-tree termination was confirmed; its descendants can no longer be addressed safely",
    }
  }
  if (!record.pid) {
    try {
      record.child.kill("SIGKILL")
    } catch {
      // The missing PID already prevents process-tree verification.
    }
    await waitForRootExit(record, remainingMs(deadline))
    return {
      confirmed: false,
      detail:
        "the Git child has no PID, so its Windows process tree cannot be verified",
    }
  }

  const details: string[] = []
  let taskkillSucceeded = false
  for (const force of [false, true]) {
    if (remainingMs(deadline) <= 0 || record.rootExited) break
    const taskkill = await runWindowsTaskkillDetailed(record.pid, force, {
      timeoutMs: Math.min(WINDOWS_TASKKILL_TIMEOUT_MS, remainingMs(deadline)),
      spawnProcess: gitProcessDependencies.spawn as unknown as TaskkillSpawn,
    })
    details.push(
      `${force ? "forced " : ""}taskkill ${formatTaskkillResult(taskkill)}`
    )
    taskkillSucceeded ||= taskkill.status === "closed" && taskkill.code === 0

    const waitMs = force
      ? remainingMs(deadline)
      : Math.min(1_000, remainingMs(deadline))
    if (taskkillSucceeded && (await waitForRootExit(record, waitMs))) {
      return {
        confirmed: true,
        detail: details.join("; "),
      }
    }
  }

  if (!record.rootExited && remainingMs(deadline) > 0) {
    try {
      record.child.kill("SIGKILL")
      details.push("direct SIGKILL fallback sent")
    } catch (error) {
      details.push(`direct SIGKILL fallback failed: ${errorMessage(error)}`)
    }
    await waitForRootExit(record, remainingMs(deadline))
  }

  if (taskkillSucceeded && record.rootExited) {
    return { confirmed: true, detail: details.join("; ") }
  }
  return {
    confirmed: false,
    detail:
      details.join("; ") ||
      "the Windows process tree did not exit before the termination deadline",
  }
}

async function terminatePosixGitProcessTree(
  record: ActiveGitProcess,
  deadline: number
): Promise<GitProcessTerminationResult> {
  const details: string[] = []
  sendPosixGitSignal(record, "SIGTERM", details)
  if (
    await waitForPosixGitTreeExit(
      record,
      Math.min(2_000, remainingMs(deadline))
    )
  ) {
    return { confirmed: true, detail: details.join("; ") }
  }

  sendPosixGitSignal(record, "SIGKILL", details)
  const confirmed = await waitForPosixGitTreeExit(record, remainingMs(deadline))
  return {
    confirmed,
    detail: confirmed
      ? details.join("; ")
      : `${details.join("; ")}; process group remained observable at the termination deadline`,
  }
}

function sendPosixGitSignal(
  record: ActiveGitProcess,
  signal: NodeJS.Signals,
  details: string[]
): void {
  if (record.pid) {
    try {
      gitProcessDependencies.killProcess(-record.pid, signal)
      details.push(`${signal} sent to process group ${record.pid}`)
      return
    } catch (error) {
      if (isNoSuchProcessError(error)) {
        details.push(`process group ${record.pid} was already absent`)
        return
      }
      details.push(
        `${signal} to process group ${record.pid} failed: ${errorMessage(error)}`
      )
    }
  }
  try {
    record.child.kill(signal)
    details.push(`${signal} sent to the direct Git child`)
  } catch (error) {
    details.push(`direct ${signal} failed: ${errorMessage(error)}`)
  }
}

async function waitForRootExit(
  record: ActiveGitProcess,
  timeoutMs: number
): Promise<boolean> {
  observeSynchronousChildExit(record)
  if (record.rootExited) return true
  if (timeoutMs <= 0) return false
  return await new Promise<boolean>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      observeSynchronousChildExit(record)
      resolve(exited || record.rootExited)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    void record.rootExitPromise.then(() => finish(true))
  })
}

async function waitForPosixGitTreeExit(
  record: ActiveGitProcess,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (remainingMs(deadline) > 0) {
    observeSynchronousChildExit(record)
    if (record.rootExited && !isPosixProcessGroupAlive(record.pid)) {
      return true
    }
    const remaining = remainingMs(deadline)
    if (remaining <= 0) break
    await delay(Math.min(GIT_PROCESS_EXIT_POLL_MS, remaining))
  }
  observeSynchronousChildExit(record)
  return record.rootExited && !isPosixProcessGroupAlive(record.pid)
}

function isPosixProcessGroupAlive(pid: number | undefined): boolean {
  if (!pid) return true
  try {
    gitProcessDependencies.killProcess(-pid, 0)
    return true
  } catch (error) {
    return !isNoSuchProcessError(error)
  }
}

function observeSynchronousChildExit(record: ActiveGitProcess): void {
  if (
    !record.rootExited &&
    (record.child.exitCode !== null || record.child.signalCode !== null)
  ) {
    record.rootExited = true
    record.resolveRootExit()
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isMissingRevisionError(error: unknown): boolean {
  const code = (error as { code?: number | string } | null)?.code
  return code === 1 || code === "1"
}

export function isGitOutputLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as {
    message?: unknown
    gitArgs?: unknown
    survivor?: unknown
  }
  return (
    candidate.survivor !== true &&
    typeof candidate.message === "string" &&
    candidate.message.includes("exceeded the output limit") &&
    Array.isArray(candidate.gitArgs) &&
    candidate.gitArgs[0] === "diff"
  )
}
