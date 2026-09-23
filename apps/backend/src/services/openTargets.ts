/**
 * "Open in <tool>" — detection + launch for external editors/tools.
 *
 * Detects which tools are actually installed (Codex-desktop-style: VS
 * Code, Cursor, Zed, Antigravity, GitHub Desktop, File Explorer,
 * Terminal, Git Bash, WSL, Android Studio) and launches the project
 * folder in the chosen one. Replaces the old blind
 * `spawn(editorId, [path])` in services/git, which had no id→binary
 * mapping (literal `vscode` never resolves on Windows), no error
 * handler (ENOENT emitted an unhandled 'error' on the detached child),
 * and no way to know what exists.
 *
 * Detection NEVER spawns the target apps or a shell. Known absolute install
 * paths and bounded PATH candidates are checked through asynchronous
 * filesystem APIs. Results cache for 5 minutes; explicit refreshes are
 * single-flighted, deadline-bounded, and rate-limited.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { logger } from "../observability/logger"
import { sanitizedChildEnvironment } from "../security/childEnvironment"

import {
  buildWindowsCmdArgs,
  quoteWindowsCmdArg,
} from "../security/windowsCommandLine"
export type OpenTargetGroup = "editor" | "tool" | "system"

export interface OpenTargetStatus {
  id: string
  label: string
  group: OpenTargetGroup
  available: boolean
}

export interface LaunchInvocation {
  command: string
  args: string[]
  /** Some launcher wrappers acknowledge only when their short-lived process
   * exits successfully; long-running GUI applications acknowledge on spawn. */
  acknowledgement?: "spawn" | "exit"
  wrappedScript?: {
    command: string
    args: string[]
  }
  relatedExecutables?: string[]
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    detached: true
    stdio: "ignore"
    windowsHide: boolean
    windowsVerbatimArguments?: boolean
  }
}

interface LaunchContext {
  binaryPath: string | null
  projectPath: string
  /** Resolve another target's binary from the same detection pass —
   *  lets WSL prefer Windows Terminal when it exists. */
  resolve: (id: string) => string | null
}

interface OpenTargetDef {
  id: string
  label: string
  group: OpenTargetGroup
  platforms: readonly NodeJS.Platform[]
  /** Listed on matching platforms even when no binary resolved
   *  (Explorer, Terminal — the launch spec has a safe fallback). */
  alwaysAvailable?: boolean | ((platform: NodeJS.Platform) => boolean)
  /** Absolute install-location candidates. Called lazily so env vars
   *  are read at detection time, not import time. */
  knownPaths?: () => string[]
  /** Basenames for the batched PATH lookup when knownPaths miss. */
  pathNames?: string[]
  /** Launching opens an interactive shell on the host (a terminal window),
   *  not just an application: gated by the remote terminal grant. */
  opensShell?: boolean
  buildLaunch: (ctx: LaunchContext) => LaunchInvocation
}

const IS_WIN = process.platform === "win32"

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
}
function programFiles(): string {
  return process.env.ProgramFiles ?? "C:\\Program Files"
}
function programFilesX86(): string | null {
  return process.env["ProgramFiles(x86)"] ?? null
}
function winDir(): string {
  return process.env.WINDIR ?? "C:\\Windows"
}
function comSpec(): string {
  const configured = process.env.ComSpec?.trim()
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(winDir(), "System32", "cmd.exe")
}

/** Caret-escape a value for `cmd /d /s /c "..."` (copy of cli/detect.ts). */
export { quoteWindowsCmdArg }

/**
 * Since the Node fix for CVE-2024-27980, direct `.cmd`/`.bat` spawning can
 * throw EINVAL. Rewrite these invocations through an absolute ComSpec path
 * with explicit caret-quoting and verbatim args. Non-script commands pass
 * through untouched; the generic shell-spawn option is never enabled.
 */
export function wrapWindowsScriptInvocation(
  inv: LaunchInvocation
): LaunchInvocation {
  if (!/\.(cmd|bat)$/i.test(inv.command)) return inv
  return {
    command: comSpec(),
    args: buildWindowsCmdArgs(inv.command, inv.args),
    acknowledgement: "exit",
    wrappedScript: {
      command: inv.command,
      args: [...inv.args],
    },
    options: { ...inv.options, windowsVerbatimArguments: true },
  }
}

const DETACHED: LaunchInvocation["options"] = {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: sanitizedChildEnvironment(),
}

/** Plain `binary <projectPath>` — the common GUI-editor case. */
function directLaunch(ctx: LaunchContext): LaunchInvocation {
  return {
    command: ctx.binaryPath ?? "",
    args: [ctx.projectPath],
    acknowledgement: "spawn",
    options: { ...DETACHED },
  }
}

/** `cmd /c start "" <program...>` with the project path carried in cwd —
 *  the path never appears on the command line, so no quoting hazards.
 *  windowsHide false: these launch visible console windows on purpose. */
function cmdStartLaunch(
  projectPath: string,
  program: string[]
): LaunchInvocation {
  return {
    command: comSpec(),
    args: ["/d", "/s", "/c", "start", "", ...program],
    acknowledgement: "exit",
    relatedExecutables: program.length > 0 ? [program[0]!] : [],
    options: { ...DETACHED, cwd: projectPath, windowsHide: false },
  }
}

const TARGETS: readonly OpenTargetDef[] = [
  {
    id: "vscode",
    label: "VS Code",
    group: "editor",
    platforms: ["win32", "darwin", "linux"],
    knownPaths: () =>
      IS_WIN
        ? [
            path.join(
              localAppData(),
              "Programs",
              "Microsoft VS Code",
              "Code.exe"
            ),
            path.join(programFiles(), "Microsoft VS Code", "Code.exe"),
          ]
        : ["/usr/local/bin/code", "/usr/bin/code", "/opt/homebrew/bin/code"],
    pathNames: ["code"],
    buildLaunch: directLaunch,
  },
  {
    id: "cursor",
    label: "Cursor",
    group: "editor",
    platforms: ["win32", "darwin", "linux"],
    knownPaths: () =>
      IS_WIN
        ? [path.join(localAppData(), "Programs", "cursor", "Cursor.exe")]
        : [],
    pathNames: ["cursor"],
    buildLaunch: directLaunch,
  },
  {
    id: "zed",
    label: "Zed",
    group: "editor",
    platforms: ["win32", "darwin", "linux"],
    knownPaths: () =>
      IS_WIN ? [path.join(localAppData(), "Zed", "Zed.exe")] : [],
    pathNames: ["zed"],
    buildLaunch: directLaunch,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    group: "editor",
    platforms: ["win32", "darwin", "linux"],
    knownPaths: () =>
      IS_WIN
        ? [
            path.join(
              localAppData(),
              "Programs",
              "Antigravity",
              "Antigravity.exe"
            ),
          ]
        : [],
    pathNames: ["antigravity"],
    buildLaunch: directLaunch,
  },
  {
    id: "android-studio",
    label: "Android Studio",
    group: "editor",
    platforms: ["win32"],
    knownPaths: () => [
      path.join(
        localAppData(),
        "Programs",
        "Android Studio",
        "bin",
        "studio64.exe"
      ),
      path.join(
        programFiles(),
        "Android",
        "Android Studio",
        "bin",
        "studio64.exe"
      ),
    ],
    buildLaunch: directLaunch,
  },
  {
    id: "github-desktop",
    label: "GitHub Desktop",
    group: "tool",
    platforms: ["win32"],
    knownPaths: () => [
      // bin\github.bat FIRST — it is the documented CLI that opens the
      // repo at a path; the exe stub takes no folder argument.
      path.join(localAppData(), "GitHubDesktop", "bin", "github.bat"),
      path.join(localAppData(), "GitHubDesktop", "GitHubDesktop.exe"),
    ],
    buildLaunch: (ctx) =>
      /\.bat$/i.test(ctx.binaryPath ?? "")
        ? {
            command: ctx.binaryPath ?? "",
            args: [ctx.projectPath],
            acknowledgement: "spawn",
            options: { ...DETACHED },
          }
        : {
            // Exe stub without the .bat: launch without args (opens the
            // last repo) — degraded but not broken.
            command: ctx.binaryPath ?? "",
            args: [],
            acknowledgement: "spawn",
            options: { ...DETACHED },
          },
  },
  {
    id: "git-bash",
    label: "Git Bash",
    group: "tool",
    platforms: ["win32"],
    opensShell: true,
    knownPaths: () => {
      const x86 = programFilesX86()
      return [
        path.join(programFiles(), "Git", "git-bash.exe"),
        ...(x86 ? [path.join(x86, "Git", "git-bash.exe")] : []),
        path.join(localAppData(), "Programs", "Git", "git-bash.exe"),
      ]
    },
    buildLaunch: (ctx) => ({
      command: ctx.binaryPath ?? "",
      // Single argv element — spaces in the path stay intact.
      args: [`--cd=${ctx.projectPath}`],
      acknowledgement: "spawn",
      options: { ...DETACHED, windowsHide: false },
    }),
  },
  {
    id: "wsl",
    label: "WSL",
    group: "tool",
    platforms: ["win32"],
    opensShell: true,
    knownPaths: () => [path.join(winDir(), "System32", "wsl.exe")],
    buildLaunch: (ctx) => {
      const wt = ctx.resolve("terminal")
      if (wt) {
        return {
          command: wt,
          args: ["-d", ctx.projectPath, "wsl"],
          acknowledgement: "spawn",
          options: { ...DETACHED, windowsHide: false },
        }
      }
      // `wsl` inherits cwd and maps it to /mnt/... — path stays out of
      // the command line entirely.
      return cmdStartLaunch(ctx.projectPath, [
        ctx.binaryPath ?? path.join(winDir(), "System32", "wsl.exe"),
      ])
    },
  },
  {
    id: "explorer",
    label: "File Explorer",
    group: "system",
    platforms: ["win32", "darwin", "linux"],
    alwaysAvailable: (platform) =>
      platform === "win32" || platform === "darwin",
    knownPaths: () =>
      process.platform === "win32"
        ? [path.join(winDir(), "explorer.exe")]
        : process.platform === "darwin"
          ? ["/usr/bin/open"]
          : ["/usr/bin/xdg-open"],
    pathNames: process.platform === "linux" ? ["xdg-open"] : [],
    buildLaunch: (ctx) => ({
      command:
        ctx.binaryPath ??
        (process.platform === "win32"
          ? path.join(winDir(), "explorer.exe")
          : "/usr/bin/open"),
      args: [ctx.projectPath],
      acknowledgement: "exit",
      options: { ...DETACHED },
    }),
  },
  {
    id: "terminal",
    label: "Terminal",
    group: "system",
    platforms: ["win32", "darwin"],
    opensShell: true,
    alwaysAvailable: (platform) =>
      platform === "win32" || platform === "darwin",
    knownPaths: () =>
      IS_WIN
        ? [
            // WindowsApps execution alias: an async access check sees it and
            // CreateProcess launches it, even when it is a reparse point.
            path.join(localAppData(), "Microsoft", "WindowsApps", "wt.exe"),
          ]
        : [],
    pathNames: IS_WIN ? ["wt"] : [],
    buildLaunch: (ctx) => {
      if (process.platform === "darwin") {
        return {
          command: "/usr/bin/open",
          args: ["-a", "Terminal", ctx.projectPath],
          acknowledgement: "exit",
          options: { ...DETACHED },
        }
      }
      if (ctx.binaryPath) {
        return {
          command: ctx.binaryPath,
          args: ["-d", ctx.projectPath],
          acknowledgement: "spawn",
          options: { ...DETACHED, windowsHide: false },
        }
      }
      // No Windows Terminal — plain cmd window in the project dir.
      return cmdStartLaunch(ctx.projectPath, [comSpec()])
    },
  },
]

/** Every launch target id, on any platform. The HTTP route validates
 *  against this set before doing any filesystem work. */
export const TARGET_IDS: ReadonlySet<string> = new Set(
  TARGETS.map((def) => def.id)
)

/** Targets whose launch is an interactive shell on the host. */
export const SHELL_TARGET_IDS: ReadonlySet<string> = new Set(
  TARGETS.filter((def) => def.opensShell === true).map((def) => def.id)
)

// ── Detection ────────────────────────────────────────────────────────

export interface DetectDeps {
  pathExists: (p: string, signal: AbortSignal) => Promise<boolean>
  /** Batched PATH lookup: basenames in, lowercased basename-sans-ext →
   *  absolute path out. No shell or subprocess is used. */
  lookupPathNames: (
    names: string[],
    signal: AbortSignal
  ) => Promise<Map<string, string>>
  platform: NodeJS.Platform
  now?: () => number
  deadlineMs?: number
}

function detectionAbortError(): Error {
  return Object.assign(new Error("open-target detection deadline exceeded"), {
    name: "AbortError",
  })
}

function throwIfDetectionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : detectionAbortError()
  }
}

async function abortableDetection<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  throwIfDetectionAborted(signal)
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(
        signal.reason instanceof Error ? signal.reason : detectionAbortError()
      )
    }
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

async function defaultPathExists(
  candidate: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    await abortableDetection(
      fs.promises.access(candidate, fs.constants.F_OK),
      signal
    )
    return true
  } catch (error) {
    if (signal.aborted) throw error
    return false
  }
}

async function isUsablePathExecutable(
  candidate: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const stat = await abortableDetection(fs.promises.stat(candidate), signal)
    if (!stat.isFile()) return false
    if (!IS_WIN) {
      await abortableDetection(
        fs.promises.access(candidate, fs.constants.X_OK),
        signal
      )
    }
    return true
  } catch (error) {
    if (signal.aborted) throw error
    return false
  }
}

async function defaultLookupPathNames(
  names: string[],
  signal: AbortSignal
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (names.length === 0) return out
  try {
    if (IS_WIN) {
      const directories = (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
        .filter((entry) => path.isAbsolute(entry))
        .slice(0, 256)
      const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((entry) => entry.trim())
        .filter((entry) => /^\.[A-Za-z0-9]+$/.test(entry))
        .slice(0, 16)
      for (const name of [...new Set(names)].slice(0, 32)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) continue
        const candidateExtensions = path.extname(name) ? [""] : extensions
        findWindows: for (const directory of directories) {
          for (const extension of candidateExtensions) {
            throwIfDetectionAborted(signal)
            const candidate = path.join(directory, `${name}${extension}`)
            if (await isUsablePathExecutable(candidate, signal)) {
              out.set(name.toLowerCase(), candidate)
              break findWindows
            }
          }
        }
      }
    } else {
      const directories = (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => path.isAbsolute(entry))
        .slice(0, 256)
      for (const name of [...new Set(names)].slice(0, 32)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) continue
        for (const directory of directories) {
          throwIfDetectionAborted(signal)
          const candidate = path.join(directory, name)
          if (await isUsablePathExecutable(candidate, signal)) {
            out.set(name.toLowerCase(), candidate)
            break
          }
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw error
    /* PATH lookup is best-effort */
  }
  return out
}

const DEFAULT_DEPS: DetectDeps = {
  pathExists: defaultPathExists,
  lookupPathNames: defaultLookupPathNames,
  platform: process.platform,
}

const CACHE_TTL_MS = 5 * 60 * 1000
const REFRESH_RATE_LIMIT_MS = 30 * 1000
const DETECTION_DEADLINE_MS = 2 * 1000

interface DetectionState {
  cache: { ts: number; resolved: Map<string, string | null> } | null
  inFlight: Promise<Map<string, string | null>> | null
  lastExplicitRefreshAt: number | null
}

const detectionStates = new WeakMap<DetectDeps, DetectionState>()

function detectionStateFor(deps: DetectDeps): DetectionState {
  const existing = detectionStates.get(deps)
  if (existing) return existing
  const created: DetectionState = {
    cache: null,
    inFlight: null,
    lastExplicitRefreshAt: null,
  }
  detectionStates.set(deps, created)
  return created
}

function detectionNow(deps: DetectDeps): number {
  return deps.now?.() ?? Date.now()
}

function isAlwaysAvailable(
  def: OpenTargetDef,
  platform: NodeJS.Platform
): boolean {
  return typeof def.alwaysAvailable === "function"
    ? def.alwaysAvailable(platform)
    : def.alwaysAvailable === true
}

function unresolvedTargets(platform: NodeJS.Platform): Map<string, null> {
  return new Map(
    TARGETS.filter((def) => def.platforms.includes(platform)).map((def) => [
      def.id,
      null,
    ])
  )
}

async function runDetection(
  deps: DetectDeps,
  signal: AbortSignal
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>()
  const pending: Array<{ id: string; names: string[] }> = []

  for (const def of TARGETS) {
    if (!def.platforms.includes(deps.platform)) continue
    resolved.set(def.id, null)
    const known = def.knownPaths?.() ?? []
    let hit: string | null = null
    for (const candidate of known) {
      try {
        if (
          await abortableDetection(deps.pathExists(candidate, signal), signal)
        ) {
          hit = candidate
          break
        }
      } catch {
        if (signal.aborted) return resolved
      }
    }
    if (hit) {
      resolved.set(def.id, hit)
    } else if (def.pathNames && def.pathNames.length > 0) {
      pending.push({ id: def.id, names: def.pathNames })
    }
  }

  if (pending.length > 0) {
    let found: Map<string, string>
    try {
      found = await abortableDetection(
        deps.lookupPathNames(
          pending.flatMap((entry) => entry.names),
          signal
        ),
        signal
      )
    } catch {
      return resolved
    }
    for (const entry of pending) {
      for (const name of entry.names) {
        const p = found.get(name.toLowerCase())
        if (p) {
          resolved.set(entry.id, p)
          break
        }
      }
    }
  }
  return resolved
}

async function runDetectionWithDeadline(
  deps: DetectDeps
): Promise<Map<string, string | null>> {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(detectionAbortError()),
    Math.max(1, deps.deadlineMs ?? DETECTION_DEADLINE_MS)
  )
  deadline.unref?.()
  try {
    return await runDetection(deps, controller.signal)
  } finally {
    clearTimeout(deadline)
    controller.abort(detectionAbortError())
  }
}

function beginDetection(
  deps: DetectDeps,
  state: DetectionState
): Promise<Map<string, string | null>> {
  const flight = runDetectionWithDeadline(deps)
    .catch(() => unresolvedTargets(deps.platform))
    .then((resolved) => {
      state.cache = { ts: detectionNow(deps), resolved }
      return resolved
    })
    .finally(() => {
      if (state.inFlight === flight) state.inFlight = null
    })
  state.inFlight = flight
  return flight
}

async function resolvedTargets(
  opts: { refresh?: boolean } = {},
  deps: DetectDeps = DEFAULT_DEPS
): Promise<Map<string, string | null>> {
  const state = detectionStateFor(deps)
  const now = detectionNow(deps)
  if (!opts.refresh && state.cache && now - state.cache.ts < CACHE_TTL_MS) {
    return state.cache.resolved
  }
  if (opts.refresh && state.inFlight) return await state.inFlight
  if (
    opts.refresh &&
    state.cache &&
    state.lastExplicitRefreshAt !== null &&
    now - state.lastExplicitRefreshAt < REFRESH_RATE_LIMIT_MS
  ) {
    return state.cache.resolved
  }
  if (opts.refresh) state.lastExplicitRefreshAt = now
  if (state.inFlight) return await state.inFlight
  return await beginDetection(deps, state)
}

export async function detectOpenTargets(
  opts: { refresh?: boolean } = {},
  deps: DetectDeps = DEFAULT_DEPS
): Promise<OpenTargetStatus[]> {
  const resolved = await resolvedTargets(opts, deps)
  return TARGETS.filter((def) => def.platforms.includes(deps.platform)).map(
    (def) => ({
      id: def.id,
      label: def.label,
      group: def.group,
      available:
        isAlwaysAvailable(def, deps.platform) || resolved.get(def.id) != null,
    })
  )
}

// ── Launch ───────────────────────────────────────────────────────────

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

/** Exported for tests — builds the final spawn spec without spawning. */
export async function buildLaunchInvocation(
  targetId: string,
  projectPath: string,
  deps: DetectDeps = DEFAULT_DEPS
): Promise<LaunchInvocation> {
  const id = targetId
  const def = TARGETS.find((entry) => entry.id === id)
  if (!def || !def.platforms.includes(deps.platform)) {
    throw httpError(400, `unknown open target: ${targetId}`)
  }
  const resolved = await resolvedTargets({}, deps)
  const binaryPath = resolved.get(id) ?? null
  if (!binaryPath && !isAlwaysAvailable(def, deps.platform)) {
    throw httpError(400, `${def.label} is not installed`)
  }
  const invocation = def.buildLaunch({
    binaryPath,
    projectPath,
    resolve: (otherId) => resolved.get(otherId) ?? null,
  })
  return wrapWindowsScriptInvocation(invocation)
}

function sameFileEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function canonicalExecutable(executable: string): Promise<string> {
  if (!path.isAbsolute(executable) || executable.includes("\u0000")) {
    throw new Error("launcher executable must be an absolute path")
  }
  const initial = await fs.promises.stat(executable)
  const canonical = await fs.promises.realpath(executable)
  const opened = await fs.promises.stat(canonical)
  if (
    !initial.isFile() ||
    !opened.isFile() ||
    !sameFileEntry(initial, opened)
  ) {
    throw new Error("launcher executable changed during validation")
  }
  if (process.platform !== "win32") {
    await fs.promises.access(canonical, fs.constants.X_OK)
  }
  const finalEntry = await fs.promises.stat(canonical)
  if (!sameFileEntry(opened, finalEntry) || !finalEntry.isFile()) {
    throw new Error("launcher executable changed immediately before spawn")
  }
  return canonical
}

async function canonicalProjectDirectory(projectPath: string): Promise<string> {
  const resolved = path.resolve(projectPath)
  const initial = await fs.promises.stat(resolved)
  const canonical = await fs.promises.realpath(resolved)
  const opened = await fs.promises.stat(canonical)
  if (
    !initial.isDirectory() ||
    !opened.isDirectory() ||
    !sameFileEntry(initial, opened)
  ) {
    throw new Error("project path changed during validation")
  }
  return canonical
}

async function revalidateLaunchInvocation(
  invocation: LaunchInvocation,
  projectPath: string
): Promise<LaunchInvocation> {
  const related = new Map<string, string>()
  for (const executable of invocation.relatedExecutables ?? []) {
    related.set(executable, await canonicalExecutable(executable))
  }
  const command = await canonicalExecutable(invocation.command)
  let args = invocation.args.map((arg) => related.get(arg) ?? arg)

  let wrappedScript = invocation.wrappedScript
  if (wrappedScript) {
    const scriptCommand = await canonicalExecutable(wrappedScript.command)
    wrappedScript = {
      command: scriptCommand,
      args: [...wrappedScript.args],
    }
    args = buildWindowsCmdArgs(scriptCommand, wrappedScript.args)
  }

  if (invocation.options.cwd) {
    const canonicalCwd = await canonicalProjectDirectory(invocation.options.cwd)
    if (canonicalCwd !== projectPath) {
      throw new Error("launcher cwd no longer matches the validated project")
    }
  }
  return {
    ...invocation,
    command,
    args,
    ...(wrappedScript ? { wrappedScript } : {}),
    options: {
      ...invocation.options,
      ...(invocation.options.cwd ? { cwd: projectPath } : {}),
      env: sanitizedChildEnvironment(),
    },
  }
}

export async function launchOpenTarget(
  targetId: string,
  projectPath: string
): Promise<{ ok: true }> {
  let canonicalProject: string
  try {
    canonicalProject = await canonicalProjectDirectory(projectPath)
  } catch (error) {
    throw httpError(
      400,
      `path is not a stable directory: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  let inv: LaunchInvocation
  try {
    inv = await revalidateLaunchInvocation(
      await buildLaunchInvocation(targetId, canonicalProject),
      canonicalProject
    )
  } catch (error) {
    if ((error as { statusCode?: unknown })?.statusCode === 400) throw error
    throw httpError(
      500,
      `launcher validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(inv.command, inv.args, inv.options)
  } catch (error) {
    throw httpError(
      500,
      `failed to open target: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  return await new Promise<{ ok: true }>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error)
        reject(httpError(500, `failed to open target: ${error.message}`))
      else {
        if (child.exitCode === null && child.signalCode === null) child.unref()
        resolve({ ok: true })
      }
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Best effort after a missing spawn acknowledgement.
      }
      finish(new Error("launcher did not acknowledge process start"))
    }, 10_000)
    timer.unref?.()
    child.once("spawn", () => {
      if ((inv.acknowledgement ?? "spawn") === "spawn") finish()
    })
    child.once("close", (code, signal) => {
      if ((inv.acknowledgement ?? "spawn") !== "exit") return
      if (code === 0) {
        finish()
      } else {
        finish(
          new Error(
            `launcher exited with code ${code ?? "null"}${
              signal ? ` (${signal})` : ""
            }`
          )
        )
      }
    })
    child.once("error", (err) => {
      logger.warn({ targetId, err: String(err) }, "open-target spawn failed")
      finish(err)
    })
  })
}
