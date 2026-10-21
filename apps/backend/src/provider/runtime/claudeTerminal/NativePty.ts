import { createRequire } from "node:module"
import { type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import type { IPty } from "node-pty"
import { isUnsafeChildEnvironmentKey } from "../../../security/childEnvironment"
import {
  isAbsoluteExecutablePath,
  resolveExecutableOnPath,
} from "../../../security/executablePath"
import {
  ensurePosixProcessGroupTerminated,
  runWindowsTaskkillDetailed,
  signalPosixProcessGroup,
  TASKKILL_NO_SUCH_PROCESS_EXIT_CODE,
  waitForPosixProcessGroupExit,
  type TaskkillSpawn,
} from "../../../services/process-termination"

const requireNodeModule = createRequire(__filename)

export interface NativePtyRunOptions {
  readonly command: string
  readonly args: string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly cols?: number
  readonly rows?: number
  readonly onData?: (data: string) => void
}

export interface NativePtyExit {
  readonly exitCode: number | null
  readonly signal?: number | string | null
}

export interface NativePtyHandle {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void | Promise<void>
  waitForExit(): Promise<NativePtyExit>
}

export interface NativePtyProbe {
  readonly available: boolean
  readonly message?: string
}

type NodePtyModule = typeof import("node-pty")
type NodePtyModuleImport = NodePtyModule & {
  readonly default?: NodePtyModule
}
interface NodePtyPackageLocation {
  readonly packageDir: string
  readonly modulePath: string
  readonly moduleUrl: string
}

let cachedNodePty: NodePtyModule | null = null
let cachedNodePtyError: string | null = null
let nodePtyProbePromise: Promise<NativePtyProbe> | null = null
let nodePtyPackagePromise: Promise<NodePtyPackageLocation> | null = null

export async function probeNativePtySupport(): Promise<NativePtyProbe> {
  if (cachedNodePty) return { available: true }
  if (cachedNodePtyError) {
    return { available: false, message: "node-pty could not be loaded" }
  }
  if (!nodePtyProbePromise) {
    nodePtyProbePromise = prepareNodePtyPackageAsync()
      .then((location) => probeNodePtyInWorker(location.moduleUrl))
      .catch(() => ({
        available: false,
        message: "node-pty could not be loaded",
      }))
  }
  return nodePtyProbePromise
}

export function spawnNativePty(options: NativePtyRunOptions): NativePtyHandle {
  const pty = loadNodePty()
  const command = resolvePtyCommand(options.command, options.args, options.env)
  return spawnLoadedNativePty(pty, command, options)
}

export async function spawnNativePtyAsync(
  options: NativePtyRunOptions
): Promise<NativePtyHandle> {
  const [location, command] = await Promise.all([
    prepareNodePtyPackageAsync(),
    prepareNativePtyCommand(options.command, options.args, options.env),
  ])
  const pty = loadResolvedNodePty(location.modulePath)
  return spawnLoadedNativePty(pty, command, options)
}

function spawnLoadedNativePty(
  pty: NodePtyModule,
  command: { readonly command: string; readonly args: string[] },
  options: NativePtyRunOptions
): NativePtyHandle {
  // The caller decides how wide the environment is: the integrated terminal
  // passes the shell allowlist, the Claude Terminal driver the provider
  // environment. Only loader-injection names are stripped here; adding the
  // backend's own environment back would undo the terminal's allowlist.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined && !isUnsafeChildEnvironmentKey(key))
      env[key] = value
  }
  const proc: IPty = pty.spawn(command.command, command.args, {
    cwd: options.cwd,
    env: {
      ...env,
      TERM: options.env.TERM ?? "xterm-256color",
      COLORTERM: options.env.COLORTERM ?? "truecolor",
    },
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
  })

  const dataDisposable = proc.onData((data) => options.onData?.(data))
  let rootExited = false
  /** A termination reached the whole tree (see `windowsTreeTermination`). */
  let treeReached = false
  let terminationTail = Promise.resolve()
  const terminationErrors: Error[] = []
  const queueTermination = (signal?: string): Promise<void> => {
    const operation = terminationTail.then(() =>
      terminateNativePtyProcessTree(
        proc,
        proc.pid,
        (signal ?? "SIGTERM") as NodeJS.Signals,
        rootExited,
        treeReached
      )
    )
    void operation.catch(() => undefined)
    terminationTail = operation.then(
      () => {
        treeReached = true
        terminationErrors.length = 0
      },
      (error) => {
        terminationErrors.push(asError(error))
      }
    )
    return operation
  }
  let exitDisposable: { dispose(): void } | null = null
  const exitPromise = new Promise<NativePtyExit>((resolve, reject) => {
    exitDisposable = proc.onExit((event) => {
      rootExited = true
      dataDisposable.dispose()
      exitDisposable?.dispose()
      void terminationTail
        .then(async () => {
          if (process.platform !== "win32") {
            await ensureNativePtyPosixProcessGroupTerminated(proc.pid)
          } else if (terminationErrors.length > 0) {
            throw Object.assign(
              new Error(
                `Windows PTY process-tree termination failed: ${terminationErrors
                  .map((error) => error.message)
                  .join("; ")}`
              ),
              {
                code: "NATIVE_PTY_TREE_TERMINATION_FAILED",
                pid: proc.pid,
                causes: [...terminationErrors],
              }
            )
          }
        })
        .then(
          () => resolve({ exitCode: event.exitCode, signal: event.signal }),
          reject
        )
    })
  })

  return {
    pid: proc.pid,
    write(data) {
      proc.write(data)
    },
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    kill(signal) {
      return queueTermination(signal)
    },
    waitForExit() {
      return exitPromise
    },
  }
}

/** taskkill's exit code when it finds no process with the PID. */
const TASKKILL_NO_SUCH_PROCESS = TASKKILL_NO_SUCH_PROCESS_EXIT_CODE

/**
 * What a termination request does to a Windows PTY's process tree, given
 * the requests before it. `taskkill /T` reaches the tree only while its
 * root runs; once the root exited, its PID may name another process.
 *
 * - `run`: taskkill the tree.
 * - `skip`: an earlier request reached the whole tree and this one adds
 *   nothing: another graceful request, or any request once the root
 *   exited. Terminations overlap (a device's close and the desktop's
 *   teardown of its terminals, a teardown and the app quitting); the
 *   later one must not count a tree that already ended as lost.
 * - `unaddressable`: the root exited before any request reached the tree;
 *   what became of its descendants cannot be checked.
 */
export function windowsTreeTermination(request: {
  readonly signal: NodeJS.Signals
  readonly rootExited: boolean
  readonly treeReached: boolean
}): "run" | "skip" | "unaddressable" {
  if (
    request.treeReached &&
    (request.rootExited || request.signal !== "SIGKILL")
  )
    return "skip"
  return request.rootExited ? "unaddressable" : "run"
}

/**
 * A taskkill that found no process with the root's PID after an earlier
 * request reached the whole tree: the tree ended in between (its root
 * exits before Windows reports it), not escaped.
 */
export function windowsTreeEndedMeanwhile(
  error: unknown,
  treeReached: boolean
): boolean {
  const failure = error as { code?: unknown; exitCode?: unknown } | null
  return (
    treeReached &&
    failure?.code === "NATIVE_PTY_TASKKILL_FAILED" &&
    failure.exitCode === TASKKILL_NO_SUCH_PROCESS
  )
}

async function terminateNativePtyProcessTree(
  proc: IPty,
  pid: number,
  signal: NodeJS.Signals,
  rootExited: boolean,
  treeReached: boolean
): Promise<void> {
  if (process.platform === "win32") {
    const next = windowsTreeTermination({ signal, rootExited, treeReached })
    if (next === "skip") return
    if (next === "unaddressable") {
      throw Object.assign(
        new Error(
          `Cannot safely address Windows PTY tree ${pid} after its root exited.`
        ),
        {
          code: "NATIVE_PTY_ROOT_EXITED_BEFORE_TREE_KILL",
          pid,
        }
      )
    }
    try {
      // Always forced: Windows refuses a graceful taskkill for console
      // processes without a window, which is every process under ConPTY.
      await runNativePtyWindowsTaskkill(pid, true)
      return
    } catch (error) {
      if (windowsTreeEndedMeanwhile(error, treeReached)) return
      if (!rootExited) {
        try {
          proc.kill(signal)
        } catch {
          // Keep the taskkill error because it represents an unverified tree.
        }
      }
      throw error
    }
  }

  const signalled = signalPosixProcessGroup(pid, signal)
  if (!signalled && !rootExited) proc.kill(signal)
  if (signal === "SIGKILL" && !(await waitForPosixProcessGroupExit(pid, 500))) {
    throw Object.assign(
      new Error(`PTY process group ${pid} survived SIGKILL.`),
      {
        code: "NATIVE_PTY_GROUP_SURVIVED_SIGKILL",
        pid,
      }
    )
  }
}

export async function ensureNativePtyPosixProcessGroupTerminated(
  pid: number
): Promise<void> {
  await ensurePosixProcessGroupTerminated(pid, {
    code: "NATIVE_PTY_GROUP_SURVIVED_ROOT_EXIT",
  })
}

type NativePtyTaskkillSpawn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: "ignore"
    windowsHide: boolean
  }
) => ChildProcess

/**
 * `taskkill /T` through the shared helper (absolute System32 path, settles
 * on the helper's close), reported with the PTY's own error codes.
 */
export async function runNativePtyWindowsTaskkill(
  pid: number,
  force: boolean,
  options: {
    readonly spawnProcess?: NativePtyTaskkillSpawn
    readonly timeoutMs?: number
  } = {}
): Promise<void> {
  const result = await runWindowsTaskkillDetailed(pid, force, {
    spawnProcess: options.spawnProcess as TaskkillSpawn | undefined,
    timeoutMs: Math.max(1, options.timeoutMs ?? 5_000),
    closeGraceMs: 1_000,
  })
  switch (result.status) {
    case "closed":
      if (result.code === 0) return
      throw Object.assign(
        new Error(
          `taskkill for PTY process tree ${pid} exited with code ${String(
            result.code
          )}${result.signal ? ` (${result.signal})` : ""}.`
        ),
        {
          code: "NATIVE_PTY_TASKKILL_FAILED",
          pid,
          exitCode: result.code,
          signal: result.signal,
        }
      )
    case "timeout":
      throw Object.assign(
        new Error(`taskkill for PTY process tree ${pid} timed out.`),
        { code: "NATIVE_PTY_TASKKILL_TIMEOUT", pid }
      )
    case "error":
      throw Object.assign(new Error(result.message), {
        code: "NATIVE_PTY_TASKKILL_SPAWN_FAILED",
        pid,
      })
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function resolvePtyCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return resolveWindowsPtyCommand(command, args, env)
  }
  const executablePath = resolveExecutablePath(command, environmentPath(env))
  if (!executablePath) return { command, args }
  return applyShebang(executablePath, readShebang(executablePath), args)
}

export async function prepareNativePtyCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ command: string; args: string[] }> {
  if (process.platform === "win32") {
    return resolveWindowsPtyCommand(command, args, env)
  }
  const executablePath = await resolveExecutablePathAsync(
    command,
    environmentPath(env)
  )
  if (!executablePath) return { command, args }
  return applyShebang(
    executablePath,
    await readShebangAsync(executablePath),
    args
  )
}

function applyShebang(
  executablePath: string,
  shebang: string | null,
  args: string[]
): { command: string; args: string[] } {
  if (!shebang) return { command: executablePath, args }
  const shebangParts = splitShebang(shebang)
  if (shebangParts.length === 0) return { command: executablePath, args }
  const [interpreter, ...interpreterArgs] = shebangParts
  if (!interpreter) return { command: executablePath, args }
  return {
    command: interpreter,
    args: [...interpreterArgs, executablePath, ...args],
  }
}

/**
 * node-pty starts the command with `CreateProcess` and no application name,
 * which searches the backend's own directories before PATH, so a bare name
 * is resolved to an absolute file first. A `.cmd`/`.bat` target is refused:
 * Windows would run it through cmd.exe, which re-parses every argument (a
 * prompt containing `&` runs a second command) and cuts each one at its
 * first line break.
 */
function resolveWindowsPtyCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { command: string; args: string[] } {
  const resolved = isAbsoluteExecutablePath(command, "win32")
    ? command
    : resolveExecutableOnPath(command, {
        pathValue: environmentPath(env),
        allowScripts: true,
      })
  if (resolved && /\.(?:cmd|bat)$/i.test(resolved)) {
    throw Object.assign(
      new Error(
        `${path.win32.basename(resolved)} is a batch shim, which a terminal session cannot start safely. Configure the program's .exe instead.`
      ),
      { code: "NATIVE_PTY_BATCH_SHIM_REFUSED", statusCode: 400 }
    )
  }
  return { command: resolved ?? command, args }
}

function environmentPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH" && value !== undefined) return value
  }
  return process.env.PATH
}

/**
 * POSIX lookup of a bare command on absolute PATH entries only: an empty or
 * relative entry would resolve against the PTY's cwd, the workspace.
 */
function pathSearchDirectories(pathValue: string | undefined): string[] {
  return (pathValue ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry))
}

function resolveExecutablePath(
  command: string,
  pathValue: string | undefined
): string | null {
  if (command.includes(path.sep) || path.isAbsolute(command)) {
    return command
  }
  for (const entry of pathSearchDirectories(pathValue)) {
    const candidate = path.join(entry, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Try next PATH entry.
    }
  }
  return null
}

async function resolveExecutablePathAsync(
  command: string,
  pathValue: string | undefined
): Promise<string | null> {
  if (command.includes(path.sep) || path.isAbsolute(command)) {
    return command
  }
  for (const entry of pathSearchDirectories(pathValue)) {
    const candidate = path.join(entry, command)
    try {
      await fs.promises.access(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Try next PATH entry.
    }
  }
  return null
}

function readShebang(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r")
    try {
      const buffer = Buffer.alloc(256)
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
      const header = buffer.subarray(0, bytesRead).toString("utf8")
      if (!header.startsWith("#!")) return null
      return header.slice(2).split(/\r?\n/, 1)[0]?.trim() || null
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

async function readShebangAsync(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(filePath, "r")
    const buffer = Buffer.alloc(256)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const header = buffer.subarray(0, bytesRead).toString("utf8")
    if (!header.startsWith("#!")) return null
    return header.slice(2).split(/\r?\n/, 1)[0]?.trim() || null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function splitShebang(value: string): string[] {
  const parts = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return parts.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1)
    }
    return part
  })
}

function loadNodePty(): NodePtyModule {
  if (cachedNodePty) return cachedNodePty
  if (cachedNodePtyError) throw new Error(cachedNodePtyError)
  try {
    ensureNodePtySpawnHelpersExecutable()
    cachedNodePty = requireNodeModule("node-pty") as NodePtyModule
    return cachedNodePty
  } catch (error) {
    cachedNodePtyError =
      error instanceof Error ? error.message : "node-pty could not be loaded"
    throw new Error(cachedNodePtyError)
  }
}

function loadResolvedNodePty(modulePath: string): NodePtyModule {
  if (cachedNodePty) return cachedNodePty
  if (cachedNodePtyError) throw new Error(cachedNodePtyError)
  try {
    cachedNodePty = normalizeNodePtyImport(requireNodeModule(modulePath))
    return cachedNodePty
  } catch (error) {
    cachedNodePtyError =
      error instanceof Error ? error.message : "node-pty could not be loaded"
    throw new Error(cachedNodePtyError)
  }
}

function normalizeNodePtyImport(imported: unknown): NodePtyModule {
  const namespace = imported as NodePtyModuleImport | null
  if (namespace && typeof namespace.spawn === "function") return namespace
  if (namespace?.default && typeof namespace.default.spawn === "function") {
    return namespace.default
  }
  throw new Error("node-pty did not expose a spawn function")
}

async function probeNodePtyInWorker(
  moduleUrl: string
): Promise<NativePtyProbe> {
  const worker = new Worker(
    [
      'void import("node:worker_threads").then(async ({ parentPort, workerData }) => {',
      "  try {",
      "    const imported = await import(workerData.moduleUrl)",
      "    const candidate = typeof imported?.spawn === 'function'",
      "      ? imported",
      "      : imported?.default",
      "    parentPort?.postMessage({ available: typeof candidate?.spawn === 'function' })",
      "  } catch {",
      "    parentPort?.postMessage({ available: false })",
      "  }",
      "})",
    ].join("\n"),
    {
      eval: true,
      workerData: { moduleUrl },
    }
  )
  worker.unref()

  return await new Promise<NativePtyProbe>((resolve) => {
    let settled = false
    const finish = (available: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void worker.terminate().catch(() => undefined)
      resolve(
        available
          ? { available: true }
          : { available: false, message: "node-pty could not be loaded" }
      )
    }
    const timeout = setTimeout(() => finish(false), 5_000)
    timeout.unref?.()
    worker.once("message", (message: unknown) => {
      finish(
        typeof message === "object" &&
          message !== null &&
          (message as { readonly available?: unknown }).available === true
      )
    })
    worker.once("error", () => finish(false))
    worker.once("exit", (code) => {
      if (code !== 0) finish(false)
    })
  })
}

function ensureNodePtySpawnHelpersExecutable(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") return
  let packageDir: string
  try {
    packageDir = path.dirname(
      requireNodeModule.resolve("node-pty/package.json")
    )
  } catch {
    return
  }
  const prebuildsDir = path.join(packageDir, "prebuilds")
  let platformDirs: string[]
  try {
    platformDirs = fs.readdirSync(prebuildsDir)
  } catch {
    return
  }
  for (const directory of platformDirs) {
    const helperPath = path.join(prebuildsDir, directory, "spawn-helper")
    try {
      const stat = fs.statSync(helperPath)
      if (stat.isFile() && (stat.mode & 0o111) === 0) {
        fs.chmodSync(helperPath, stat.mode | 0o755)
      }
    } catch {
      // Some package variants do not ship a spawn-helper for every platform.
    }
  }
}

async function ensureNodePtySpawnHelpersExecutableAsync(
  packageDir: string
): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return
  const prebuildsDir = path.join(packageDir, "prebuilds")
  let platformDirs: fs.Dirent[]
  try {
    platformDirs = await fs.promises.readdir(prebuildsDir, {
      withFileTypes: true,
    })
  } catch {
    return
  }
  await Promise.all(
    platformDirs
      .filter((entry) => entry.isDirectory())
      .map(async (directory) => {
        const helperPath = path.join(
          prebuildsDir,
          directory.name,
          "spawn-helper"
        )
        try {
          const stat = await fs.promises.stat(helperPath)
          if (stat.isFile() && (stat.mode & 0o111) === 0) {
            await fs.promises.chmod(helperPath, stat.mode | 0o755)
          }
        } catch {
          // Some package variants do not ship a helper for every platform.
        }
      })
  )
}

function prepareNodePtyPackageAsync(): Promise<NodePtyPackageLocation> {
  if (!nodePtyPackagePromise) {
    nodePtyPackagePromise = locateNodePtyPackageAsync().then(
      async (location) => {
        await ensureNodePtySpawnHelpersExecutableAsync(location.packageDir)
        return location
      }
    )
  }
  return nodePtyPackagePromise
}

async function locateNodePtyPackageAsync(): Promise<NodePtyPackageLocation> {
  for (const candidate of nodePtyPackageDirectoryCandidates()) {
    let packageDir: string
    let packageJson: unknown
    try {
      packageDir = await fs.promises.realpath(candidate)
      packageJson = JSON.parse(
        await fs.promises.readFile(
          path.join(packageDir, "package.json"),
          "utf8"
        )
      )
    } catch {
      continue
    }
    const main =
      typeof packageJson === "object" &&
      packageJson !== null &&
      typeof (packageJson as { readonly main?: unknown }).main === "string"
        ? (packageJson as { readonly main: string }).main
        : "index.js"
    const modulePath = path.resolve(packageDir, main)
    const relativeModulePath = path.relative(packageDir, modulePath)
    if (
      relativeModulePath === "" ||
      relativeModulePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeModulePath)
    ) {
      continue
    }
    try {
      await fs.promises.access(modulePath, fs.constants.R_OK)
    } catch {
      continue
    }
    return {
      packageDir,
      modulePath,
      moduleUrl: pathToFileURL(modulePath).href,
    }
  }
  throw new Error("node-pty package could not be resolved")
}

function nodePtyPackageDirectoryCandidates(): string[] {
  const moduleSearchDirectories =
    typeof module !== "undefined" && Array.isArray(module.paths)
      ? module.paths
      : []
  const nodePathDirectories = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
  const ancestorDirectories: string[] = []
  let current = path.resolve(__dirname)
  while (true) {
    ancestorDirectories.push(path.join(current, "node_modules"))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return Array.from(
    new Set([
      ...moduleSearchDirectories,
      ...ancestorDirectories,
      ...nodePathDirectories,
    ])
  ).map((directory) => path.join(directory, "node-pty"))
}
