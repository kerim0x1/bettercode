/**
 * Running `git` itself: admission limits per process and per workspace,
 * the bounded output pipe, timeouts, and process-tree termination on
 * Windows and POSIX. Every other file in this folder goes through `gitRun`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs"
import { restrictedChildEnvironment } from "../../security/childEnvironment"
import { resolveExecutableOnPath } from "../../security/executablePath"
import {
  errorMessage,
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

/** How much git may run at once, and how long a caller waits for a slot. */
export interface GitAdmissionLimits {
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

/** Repository-configured helpers that every git invocation overrides. */
export interface RepositoryHelperConfig {
  /** `filter.<driver>.(clean|process|required)` keys set in repository config. */
  readonly filterKeys: readonly string[]
  /** Whether repository config sets `core.sshCommand`. */
  readonly sshCommand: boolean
}

/** How git is spawned, signalled and located; replaced by tests. */
export interface GitProcessDependencies {
  readonly platform: NodeJS.Platform
  readonly spawn: typeof spawn
  readonly killProcess: (pid: number, signal: NodeJS.Signals | 0) => void
  /** Absolute path of the git executable; throws ENOENT when git is missing. */
  readonly resolveGitExecutable: () => string
  /**
   * Repository helper configuration for `cwd`. A synchronous result keeps
   * the spawn synchronous, which the lifecycle tests rely on.
   */
  readonly repositoryHelperConfig: (
    cwd: string,
    opts: GitRunOptions
  ) => RepositoryHelperConfig | Promise<RepositoryHelperConfig>
}

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

function gitShuttingDownError(): Error {
  return Object.assign(new Error("Git service is shutting down."), {
    statusCode: 503,
    code: "GIT_SHUTTING_DOWN",
  })
}

/**
 * Port of rust-backend/src/services/git.rs + rust-backend/src/git/*. Every
 * function runs `git` via execFile (no shell interpolation, safe against
 * injection through the `cwd` argument and file-list args).
 */

/**
 * Hardened git env (S5):
 *
 *  - GIT_TERMINAL_PROMPT=0 and an empty GIT_ASKPASS: no interactive
 *    credential prompts and no askpass helper, so a missing credential fails
 *    fast with "terminal prompts disabled" instead of hanging the backend or
 *    (as `GIT_ASKPASS=echo` did) sending the prompt text as the username and
 *    password. Credential helpers and the SSH agent still work.
 *  - GIT_CONFIG_NOSYSTEM=1: ignore /etc/gitconfig / system-wide git config so a
 *    poisoned shared config can't redirect remotes via `url.<base>.insteadOf`
 *    or inject `core.sshCommand`.
 *  - GIT_PROTOCOL_FROM_USER=0 + protocol.allow=user: allow only the network
 *    protocols git considers safe; refuse `ext::`, `file://` (handled at the
 *    URL validator below as well), etc.
 *
 * Built per call rather than once at import: PATH can change after startup
 * (the macOS login-shell PATH is merged in asynchronously).
 */
const HARDENED_GIT_ENV_OVERRIDES = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "Never",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_LITERAL_PATHSPECS: "1",
  PAGER: "cat",
} as const satisfies NodeJS.ProcessEnv

function gitProcessEnvironment(
  overrides?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...restrictedChildEnvironment(),
    ...overrides,
    ...HARDENED_GIT_ENV_OVERRIDES,
  }
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

/**
 * Keys the repository-helper probe asks for. `include.path` and
 * `includeIf.*.path` are listed only to learn that the config pulls in other
 * files, whose changes the cache cannot observe.
 */
const REPOSITORY_HELPER_CONFIG_PATTERN =
  "^(filter\\..*\\.(clean|process|required)|core\\.sshcommand|include\\.path|includeif\\..*\\.path)$"
const REPOSITORY_HELPER_FILTER_KEY = /^filter\..*\.(?:clean|process|required)$/i
const REPOSITORY_HELPER_INCLUDE_KEY = /^include(?:if\..*)?\.path$/i
const REPOSITORY_HELPER_PROBE_TIMEOUT_MS = 10_000
const REPOSITORY_HELPER_CACHE_MAX_AGE_MS = 60_000
const REPOSITORY_HELPER_CACHE_MAX_ENTRIES = 128
/** Environment overrides that point git at a different repository or config. */
const REPOSITORY_SELECTING_ENV_KEYS = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
] as const

interface CachedRepositoryHelperConfig {
  readonly fingerprint: string
  readonly cachedAt: number
  readonly config: RepositoryHelperConfig
}

/** Options for a {@link GitProcessService}; both default to production. */
export interface GitProcessServiceOptions {
  /** Test seam for deterministic taskkill/process-tree lifecycle coverage. */
  readonly dependencies?: Partial<GitProcessDependencies>
  /** Overrides the admission limits read from `BETTERC0DE_GIT_*`. */
  readonly admissionLimits?: Partial<GitAdmissionLimits>
}

/**
 * The git processes of one backend instance: its admission state and queue,
 * the children it is running, and the repository-helper configuration it
 * has probed. Every `gitRun` goes through one of these.
 *
 * Bootstrap creates one per backend (`BootRoot.gitProcesses`) and installs
 * it as the default with {@link setDefaultGitProcessService}, so the git
 * helpers in this folder, which their many callers reach as plain functions,
 * run through it; admission, the startup unwind and the graceful drain hold
 * the same instance directly. A test builds its own with fake dependencies
 * instead of patching module state.
 */
export class GitProcessService {
  private readonly dependencies: GitProcessDependencies
  private readonly admissionLimits: GitAdmissionLimits
  private admissionsOpen = true
  private readonly activeProcesses = new Set<ActiveGitProcess>()
  private activeAdmissions = 0
  private readonly admissionsByWorkspace = new Map<string, number>()
  private readonly admissionQueue: GitAdmissionWaiter[] = []
  private readonly helperConfigCache = new Map<
    string,
    CachedRepositoryHelperConfig
  >()
  private readonly helperConfigProbes = new Map<
    string,
    Promise<RepositoryHelperConfig>
  >()

  constructor(options: GitProcessServiceOptions = {}) {
    this.dependencies = {
      platform: process.platform,
      spawn,
      killProcess: (pid, signal) => {
        process.kill(pid, signal)
      },
      resolveGitExecutable: requireGitExecutable,
      repositoryHelperConfig: (cwd, opts) =>
        this.readRepositoryHelperConfig(cwd, opts),
      ...options.dependencies,
    }
    const limits = options.admissionLimits
    this.admissionLimits = limits
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
              limits.maxPerWorkspace ??
                defaultGitAdmissionLimits.maxPerWorkspace
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

  /** Runs `git args` in `cwd` under this instance's admission control. */
  async run(
    cwd: string,
    args: string[],
    opts: GitRunOptions = {}
  ): Promise<{ stdout: string; stderr: string }> {
    const prepared = this.argsWithoutRepositoryHelpers(cwd, args, opts)
    const safeArgs = Array.isArray(prepared) ? prepared : await prepared
    return await this.runProcess(cwd, args, opts, safeArgs)
  }

  /** Git work waiting for an admission slot. */
  queuedProcessCount(): number {
    return this.admissionQueue.length
  }

  private workspaceKey(cwd: string): string {
    const resolved = path.resolve(cwd)
    return this.dependencies.platform === "win32"
      ? resolved.toLowerCase()
      : resolved
  }

  private capacityError(
    code: "GIT_CAPACITY_EXCEEDED" | "GIT_ADMISSION_TIMEOUT",
    message: string
  ): Error {
    return Object.assign(new Error(message), {
      statusCode: 503,
      code,
      retryAfterMs: Math.min(this.admissionLimits.waitMs, 5_000),
    })
  }

  private canGrantAdmission(cwdKey: string): boolean {
    return (
      this.activeAdmissions < this.admissionLimits.maxConcurrent &&
      (this.admissionsByWorkspace.get(cwdKey) ?? 0) <
        this.admissionLimits.maxPerWorkspace
    )
  }

  private grantAdmission(cwdKey: string): () => void {
    this.activeAdmissions += 1
    this.admissionsByWorkspace.set(
      cwdKey,
      (this.admissionsByWorkspace.get(cwdKey) ?? 0) + 1
    )
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeAdmissions = Math.max(0, this.activeAdmissions - 1)
      const workspaceCount = (this.admissionsByWorkspace.get(cwdKey) ?? 1) - 1
      if (workspaceCount > 0) {
        this.admissionsByWorkspace.set(cwdKey, workspaceCount)
      } else {
        this.admissionsByWorkspace.delete(cwdKey)
      }
      this.drainAdmissionQueue()
    }
  }

  private rejectQueuedAdmissions(error: Error): void {
    for (const waiter of this.admissionQueue.splice(0)) {
      if (waiter.settled) continue
      waiter.settled = true
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private drainAdmissionQueue(): void {
    if (!this.admissionsOpen) {
      this.rejectQueuedAdmissions(gitShuttingDownError())
      return
    }
    while (
      this.admissionQueue.length > 0 &&
      this.activeAdmissions < this.admissionLimits.maxConcurrent
    ) {
      const eligibleIndex = this.admissionQueue.findIndex(
        (waiter) => !waiter.settled && this.canGrantAdmission(waiter.cwdKey)
      )
      if (eligibleIndex < 0) return
      const [waiter] = this.admissionQueue.splice(eligibleIndex, 1)
      if (!waiter || waiter.settled) continue
      waiter.settled = true
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(this.grantAdmission(waiter.cwdKey))
    }
  }

  private acquireAdmission(cwd: string): (() => void) | Promise<() => void> {
    if (!this.admissionsOpen) throw gitShuttingDownError()
    const cwdKey = this.workspaceKey(cwd)
    if (this.canGrantAdmission(cwdKey)) {
      return this.grantAdmission(cwdKey)
    }
    if (this.admissionQueue.length >= this.admissionLimits.maxQueued) {
      throw this.capacityError(
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
        const index = this.admissionQueue.indexOf(waiter)
        if (index >= 0) this.admissionQueue.splice(index, 1)
        reject(
          this.capacityError(
            "GIT_ADMISSION_TIMEOUT",
            "Timed out waiting for bounded Git process capacity."
          )
        )
      }, this.admissionLimits.waitMs)
      waiter.timer.unref?.()
      this.admissionQueue.push(waiter)
    })
  }

  private retireProcess(record: ActiveGitProcess): void {
    if (!this.activeProcesses.delete(record)) return
    record.releaseAdmission()
  }

  activeProcessCount(): number {
    return this.activeProcesses.size
  }

  resumeAdmissions(): void {
    if (this.activeProcesses.size > 0 || this.activeAdmissions > 0) {
      throw new Error(
        "Cannot reopen Git admissions while retained process resources remain."
      )
    }
    this.admissionsOpen = true
    this.drainAdmissionQueue()
  }

  /** Close admission without terminating already-running Git children. */
  beginShutdown(): void {
    this.admissionsOpen = false
    this.rejectQueuedAdmissions(gitShuttingDownError())
  }

  /**
   * Stop every retained Git child and verify that its process tree exited.
   *
   * Admissions close before the snapshot is taken, so a concurrent background
   * task cannot race a new child into the teardown. A process whose tree cannot
   * be confirmed dead deliberately remains registered and makes shutdown fail;
   * dropping it here would turn a leaked child into an invisible orphan.
   */
  async shutdownAll(
    graceMs = GIT_PROCESS_TERMINATION_TIMEOUT_MS
  ): Promise<number> {
    this.beginShutdown()
    const retained = [...this.activeProcesses]
    if (retained.length === 0) return 0
    const boundedGraceMs = Number.isFinite(graceMs)
      ? Math.max(1, Math.floor(graceMs))
      : GIT_PROCESS_TERMINATION_TIMEOUT_MS

    await Promise.all(
      retained.map((record) =>
        this.requestProcessStop(record, "shutdown", boundedGraceMs)
      )
    )

    const survivors = retained.filter((record) =>
      this.activeProcesses.has(record)
    )
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

  /**
   * Repository config can name a program: FSMonitor, clean/process filters,
   * `core.sshCommand`, and `ext::` remotes. Every git invocation, including
   * add/commit/fetch, overrides those for this process. Diff-family commands
   * also refuse external diffs and textconv.
   *
   * Which filters and whether an sshCommand exist is read with one
   * `git config` probe per repository and cached until the repository's
   * config files change (see {@link readRepositoryHelperConfig}), so steady
   * status polling spawns no extra process and never blocks the event loop.
   */
  private argsWithoutRepositoryHelpers(
    cwd: string,
    args: string[],
    opts: GitRunOptions
  ): string[] | Promise<string[]> {
    let commandIndex = 0
    while (args[commandIndex] === "-c") commandIndex += 2
    const command = args[commandIndex]
    if (!command) return args

    const prefix = args.slice(0, commandIndex)
    const build = (config: RepositoryHelperConfig): string[] => {
      const overrides = [
        "core.fsmonitor=false",
        "log.showSignature=false",
        "protocol.ext.allow=never",
        ...(config.sshCommand ? ["core.sshCommand=ssh"] : []),
        ...config.filterKeys.map(
          (key) => `${key}=${key.endsWith(".required") ? "false" : ""}`
        ),
      ].flatMap((setting) => ["-c", setting])
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
    const config = this.dependencies.repositoryHelperConfig(cwd, opts)
    return config instanceof Promise ? config.then(build) : build(config)
  }

  /** Forget cached repository helper configuration (all of it, or one cwd's). */
  invalidateRepositoryHelperConfigCache(cwd?: string): void {
    if (cwd === undefined) {
      this.helperConfigCache.clear()
      return
    }
    this.helperConfigCache.delete(this.workspaceKey(cwd))
  }

  /**
   * The repository's helper configuration, from cache when the files it was
   * read from are unchanged.
   *
   * This probe is a security control: it neutralizes filters and an
   * sshCommand that a repository (or an agent working in it) configured. The
   * cache therefore errs towards probing again. An entry is reused only when
   * the repository's git directory was located and `<common-dir>/config` and
   * `<git-dir>/config.worktree` have the same identity, size and timestamps
   * as when it was read, and never when that config includes other files.
   * Entries also expire after a minute.
   */
  private async readRepositoryHelperConfig(
    cwd: string,
    opts: GitRunOptions
  ): Promise<RepositoryHelperConfig> {
    if (
      opts.env &&
      REPOSITORY_SELECTING_ENV_KEYS.some((key) => opts.env?.[key] !== undefined)
    ) {
      return (await this.probeRepositoryHelperConfig(cwd, false, opts.env))
        .config
    }
    const key = this.workspaceKey(cwd)
    const location = await locateRepositoryConfig(cwd)
    const cached = this.helperConfigCache.get(key)
    if (
      location &&
      cached &&
      cached.fingerprint === location.fingerprint &&
      Date.now() - cached.cachedAt < REPOSITORY_HELPER_CACHE_MAX_AGE_MS
    ) {
      return cached.config
    }

    const flightKey = `${key}\0${location?.fingerprint ?? ""}`
    const inFlight = this.helperConfigProbes.get(flightKey)
    if (inFlight) return await inFlight
    const probe = this.probeRepositoryHelperConfig(
      cwd,
      location?.hasWorktreeConfig ?? false
    )
      .then((result) => {
        if (location && result.cacheable) {
          if (
            !this.helperConfigCache.has(key) &&
            this.helperConfigCache.size >= REPOSITORY_HELPER_CACHE_MAX_ENTRIES
          ) {
            const oldest = this.helperConfigCache.keys().next().value
            if (oldest !== undefined) this.helperConfigCache.delete(oldest)
          }
          this.helperConfigCache.delete(key)
          this.helperConfigCache.set(key, {
            // The fingerprint was taken before the probe ran: a config edit
            // racing the probe changes it, so the next call probes again.
            fingerprint: location.fingerprint,
            cachedAt: Date.now(),
            config: result.config,
          })
        } else {
          this.helperConfigCache.delete(key)
        }
        return result.config
      })
      .finally(() => {
        this.helperConfigProbes.delete(flightKey)
      })
    this.helperConfigProbes.set(flightKey, probe)
    return await probe
  }

  /**
   * Run the config probe through the regular admission-controlled git spawn
   * path. `--local --includes` reads the repository's config and the files it
   * includes (a bare `--local` ignores includes, which used to let a filter
   * defined in an included file slip through); `--worktree` covers
   * per-worktree config when the repository has any.
   *
   * Fails closed: an unexpected failure (timeout, capacity, crash) rejects,
   * and the git command it guards does not run without its overrides. Exit 1
   * means "no such keys"; 128 means git itself cannot read this repository,
   * so the guarded command fails the same way.
   */
  private async probeRepositoryHelperConfig(
    cwd: string,
    hasWorktreeConfig: boolean,
    env?: NodeJS.ProcessEnv
  ): Promise<{ config: RepositoryHelperConfig; cacheable: boolean }> {
    const probeScope = async (
      scope: "--local" | "--worktree"
    ): Promise<{ names: string[]; readable: boolean }> => {
      try {
        const { stdout } = await this.runProcess(
          cwd,
          [
            "config",
            scope,
            "--includes",
            "--null",
            "--name-only",
            "--get-regexp",
            REPOSITORY_HELPER_CONFIG_PATTERN,
          ],
          { env, timeoutMs: REPOSITORY_HELPER_PROBE_TIMEOUT_MS }
        )
        return { names: stdout.split("\0").filter(Boolean), readable: true }
      } catch (error) {
        const exitCode = (error as { exitCode?: unknown } | null)?.exitCode
        if (exitCode === 1) return { names: [], readable: true }
        if (exitCode === 128) return { names: [], readable: false }
        // A git too old for `--worktree` (2.20) cannot read config.worktree
        // either, so there is nothing to neutralize there.
        if (scope === "--worktree" && exitCode === 129) {
          return { names: [], readable: true }
        }
        throw error
      }
    }
    const [local, worktree] = await Promise.all([
      probeScope("--local"),
      hasWorktreeConfig
        ? probeScope("--worktree")
        : Promise.resolve({ names: [], readable: true }),
    ])
    const names = [...new Set([...local.names, ...worktree.names])]
    return {
      config: {
        filterKeys: names.filter((name) =>
          REPOSITORY_HELPER_FILTER_KEY.test(name)
        ),
        sshCommand: names.some(
          (name) => name.toLowerCase() === "core.sshcommand"
        ),
      },
      cacheable:
        local.readable &&
        worktree.readable &&
        !names.some((name) => REPOSITORY_HELPER_INCLUDE_KEY.test(name)),
    }
  }

  private async runProcess(
    cwd: string,
    args: string[],
    opts: GitRunOptions,
    spawnArgs = args
  ): Promise<{ stdout: string; stderr: string }> {
    const admission = this.acquireAdmission(cwd)
    const releaseAdmission =
      typeof admission === "function" ? admission : await admission
    if (!this.admissionsOpen) {
      releaseAdmission()
      throw gitShuttingDownError()
    }
    let admissionTransferred = false
    try {
      // Never the bare name: with the workspace as cwd, Windows would run a
      // `git.exe` committed to the repository before the one on PATH.
      const gitExecutable = this.dependencies.resolveGitExecutable()
      return await new Promise((resolve, reject) => {
        const child = this.dependencies.spawn(gitExecutable, spawnArgs, {
          cwd,
          env: gitProcessEnvironment(opts.env),
          windowsHide: true,
          detached: this.dependencies.platform !== "win32",
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
        this.activeProcesses.add(record)
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
          void this.requestProcessStop(
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
            this.retireProcess(record)
            finish(null, null)
            return
          }
          if (!record.stopReason) {
            void this.requestProcessStop(
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
          if (this.dependencies.platform !== "win32" && record.pid) {
            let treeResult: GitProcessTerminationResult
            try {
              treeResult = await this.terminatePosixProcessTree(
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
          this.retireProcess(record)
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

  private async requestProcessStop(
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

    const operation = this.terminateProcessTree(record, graceMs).then(
      (result) => {
        if (result.confirmed) {
          this.retireProcess(record)
        } else {
          record.treeUnconfirmed = true
        }
        record.onTerminationResult(result)
        return result
      }
    )
    record.terminationPromise = operation
    try {
      return await operation
    } finally {
      if (record.terminationPromise === operation) {
        record.terminationPromise = null
      }
    }
  }

  private async terminateProcessTree(
    record: ActiveGitProcess,
    graceMs: number
  ): Promise<GitProcessTerminationResult> {
    const deadline = Date.now() + Math.max(1, graceMs)
    observeSynchronousChildExit(record)
    if (this.dependencies.platform === "win32") {
      return this.terminateWindowsProcessTree(record, deadline)
    }
    return this.terminatePosixProcessTree(record, deadline)
  }

  private async terminateWindowsProcessTree(
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
        spawnProcess: this.dependencies.spawn as unknown as TaskkillSpawn,
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

  private async terminatePosixProcessTree(
    record: ActiveGitProcess,
    deadline: number
  ): Promise<GitProcessTerminationResult> {
    const details: string[] = []
    this.sendPosixSignal(record, "SIGTERM", details)
    if (
      await this.waitForPosixTreeExit(
        record,
        Math.min(2_000, remainingMs(deadline))
      )
    ) {
      return { confirmed: true, detail: details.join("; ") }
    }

    this.sendPosixSignal(record, "SIGKILL", details)
    const confirmed = await this.waitForPosixTreeExit(
      record,
      remainingMs(deadline)
    )
    return {
      confirmed,
      detail: confirmed
        ? details.join("; ")
        : `${details.join("; ")}; process group remained observable at the termination deadline`,
    }
  }

  private sendPosixSignal(
    record: ActiveGitProcess,
    signal: NodeJS.Signals,
    details: string[]
  ): void {
    if (record.pid) {
      try {
        this.dependencies.killProcess(-record.pid, signal)
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

  private async waitForPosixTreeExit(
    record: ActiveGitProcess,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (remainingMs(deadline) > 0) {
      observeSynchronousChildExit(record)
      if (record.rootExited && !this.isPosixProcessGroupAlive(record.pid)) {
        return true
      }
      const remaining = remainingMs(deadline)
      if (remaining <= 0) break
      await delay(Math.min(GIT_PROCESS_EXIT_POLL_MS, remaining))
    }
    observeSynchronousChildExit(record)
    return record.rootExited && !this.isPosixProcessGroupAlive(record.pid)
  }

  private isPosixProcessGroupAlive(pid: number | undefined): boolean {
    if (!pid) return true
    try {
      this.dependencies.killProcess(-pid, 0)
      return true
    } catch (error) {
      return !isNoSuchProcessError(error)
    }
  }
}

/**
 * The service `gitRun` uses. Bootstrap installs each backend's own instance
 * at startup (`setDefaultGitProcessService` in `createBootRoot`'s
 * admission phase); the git helpers in this folder are plain functions used
 * across the backend, and threading the service through every one of them
 * and their callers was not worth the churn.
 *
 * Code that runs git outside a backend (tests, tooling) and installed
 * nothing gets an instance created on first use, never at import.
 */
let defaultGitProcesses: GitProcessService | null = null

/**
 * Installs `service` as the one `gitRun` and every git helper use; null
 * forgets the installed one. Bootstrap calls this once per backend at
 * startup.
 */
export function setDefaultGitProcessService(
  service: GitProcessService | null
): void {
  defaultGitProcesses = service
}

/** The installed service, or one created now when none is installed. */
export function defaultGitProcessService(): GitProcessService {
  defaultGitProcesses ??= new GitProcessService()
  return defaultGitProcesses
}

export async function gitRun(
  cwd: string,
  args: string[],
  opts: GitRunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return await defaultGitProcessService().run(cwd, args, opts)
}

/**
 * Locate the repository that contains `cwd` the way git discovers it (a
 * `.git` directory, or a `.git` file with a `gitdir:` pointer, in `cwd` or
 * an ancestor; `commondir` for linked worktrees) and fingerprint its config
 * files. Null when no repository is found, which disables caching.
 */
async function locateRepositoryConfig(cwd: string): Promise<{
  readonly fingerprint: string
  readonly hasWorktreeConfig: boolean
} | null> {
  let directory = path.resolve(cwd)
  for (let depth = 0; depth < 128; depth += 1) {
    const dotGit = path.join(directory, ".git")
    const stat = await fs.promises.stat(dotGit).catch(() => null)
    if (stat) {
      let gitDir: string | null = null
      if (stat.isDirectory()) {
        gitDir = dotGit
      } else if (stat.isFile()) {
        const pointer = await fs.promises
          .readFile(dotGit, "utf8")
          .catch(() => "")
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
        if (match?.[1]) gitDir = path.resolve(directory, match[1])
      }
      if (!gitDir) return null
      const commonDirPointer = await fs.promises
        .readFile(path.join(gitDir, "commondir"), "utf8")
        .catch(() => null)
      const commonDir = commonDirPointer?.trim()
        ? path.resolve(gitDir, commonDirPointer.trim())
        : gitDir
      const configPath = path.join(commonDir, "config")
      const worktreeConfigPath = path.join(gitDir, "config.worktree")
      const [configIdentity, worktreeIdentity] = await Promise.all([
        fileIdentity(configPath),
        fileIdentity(worktreeConfigPath),
      ])
      return {
        fingerprint: [
          gitDir,
          commonDir,
          configIdentity ?? "-",
          worktreeIdentity ?? "-",
        ].join("\0"),
        hasWorktreeConfig: worktreeIdentity !== null,
      }
    }
    const parent = path.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
  return null
}

async function fileIdentity(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(filePath, { bigint: true })
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
  } catch {
    return null
  }
}

/**
 * Absolute path of the git executable: PATH (absolute entries only, never
 * the repository) first, then the standard install locations. Null when git
 * is not installed.
 */
export function locateGitExecutable(): string | null {
  const onPath = resolveExecutableOnPath("git")
  if (onPath) return onPath
  for (const candidate of knownGitInstallLocations()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Not installed here.
    }
  }
  return null
}

function requireGitExecutable(): string {
  const located = locateGitExecutable()
  if (located) return located
  throw Object.assign(
    new Error("Git was not found on PATH (spawn git ENOENT)."),
    { name: "GitCommandError", code: "ENOENT", syscall: "spawn git" }
  )
}

function knownGitInstallLocations(): string[] {
  if (process.platform === "win32") {
    const programFiles = [
      process.env.ProgramW6432,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ].filter((value): value is string => Boolean(value?.trim()))
    const localAppData = process.env.LOCALAPPDATA
    return [
      ...programFiles.map((root) =>
        path.win32.join(root, "Git", "cmd", "git.exe")
      ),
      ...(localAppData
        ? [path.win32.join(localAppData, "Programs", "Git", "cmd", "git.exe")]
        : []),
    ]
  }
  if (process.platform === "darwin") {
    return ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
  }
  return ["/usr/bin/git", "/usr/local/bin/git"]
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
