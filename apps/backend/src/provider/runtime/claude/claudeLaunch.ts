import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  isAbsoluteExecutablePath,
  resolveExecutableOnPath,
} from "../../../security/executablePath"
import {
  buildWindowsCmdArgs,
  requiresWindowsCmdWrapper,
  resolveComSpec,
} from "../../../security/windowsCommandLine"

/**
 * How Claude Code is launched for Agent SDK queries.
 *
 * The SDK treats any `pathToClaudeCodeExecutable` that does not end in `.js`
 * as a native binary and spawns it directly. On Windows an npm install
 * resolves to `%APPDATA%\npm\claude.cmd`, and Node refuses to spawn a
 * `.cmd`/`.bat` without a shell (EINVAL since the CVE-2024-27980 fix), so every
 * turn failed while the cmd-wrapped `--version` probe reported Claude as
 * installed. Turns and probes now share one launch path:
 *
 *  1. An npm/pnpm `.cmd` shim is resolved to the script or binary it starts,
 *     so the SDK runs `node cli.js` or the real `.exe` without cmd.exe.
 *  2. Whatever is still a shim is launched through cmd.exe with the shared
 *     safe argument builder.
 *  3. A bare `claude` is resolved to an absolute path, never left for the
 *     spawn to look up relative to the workspace.
 */

export interface ClaudeSdkExecutable {
  /** Value for the SDK's `pathToClaudeCodeExecutable`. */
  readonly pathToClaudeCodeExecutable: string
  /** Node runtime for a `.js` entry point (the SDK default is bare `node`). */
  readonly executable?: string
}

export interface ClaudeLaunchEnvironment {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly homeDir?: string
  /** Test seam for PATH lookups. */
  readonly resolveOnPath?: (name: string) => string | null
}

const MAX_SHIM_BYTES = 64 * 1024
const SHIM_TARGET_PATTERN = /"%~?dp0%?\\([^"\r\n]+?)"/gi
// The Agent SDK runs these through `node`; anything else is spawned as a
// native binary (`Fx()` in the SDK bundle).
const SDK_SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"]

/** Whether the Agent SDK launches this path with node rather than directly. */
export function isClaudeSdkScriptPath(target: string): boolean {
  const lower = target.toLowerCase()
  return SDK_SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export async function resolveClaudeSdkExecutable(
  binaryPath: string,
  environment: ClaudeLaunchEnvironment = {}
): Promise<ClaudeSdkExecutable> {
  const platform = environment.platform ?? process.platform
  const trimmed = binaryPath.trim()
  const resolveOnPath =
    environment.resolveOnPath ??
    ((name: string) =>
      resolveExecutableOnPath(name, {
        platform,
        allowScripts: platform === "win32",
      }))
  const located = isBareCommandName(trimmed)
    ? (resolveOnPath(trimmed) ??
      (await firstExistingFile(
        knownClaudeInstallPaths(trimmed, platform, environment)
      )) ??
      trimmed)
    : trimmed
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(located)) {
    return { pathToClaudeCodeExecutable: located }
  }
  const target = await readWindowsShimTarget(located)
  if (!target) return { pathToClaudeCodeExecutable: located }
  if (!isClaudeSdkScriptPath(target)) {
    return { pathToClaudeCodeExecutable: target }
  }
  // npm shims prefer a node.exe installed next to them over PATH.
  const bundledNode = path.join(path.dirname(located), "node.exe")
  const runtime = (await isFile(bundledNode))
    ? bundledNode
    : resolveOnPath("node")
  return {
    pathToClaudeCodeExecutable: target,
    ...(runtime && /\.exe$/i.test(runtime) ? { executable: runtime } : {}),
  }
}

/**
 * The script or binary an npm (`"%dp0%\…"`) or pnpm (`"%~dp0\…"`) cmd shim
 * starts. Returns null for anything that does not look like such a shim.
 */
export async function readWindowsShimTarget(
  shimPath: string
): Promise<string | null> {
  let text: string
  try {
    const handle = await fs.promises.open(shimPath, "r")
    try {
      const buffer = Buffer.alloc(MAX_SHIM_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, MAX_SHIM_BYTES, 0)
      text = buffer.subarray(0, bytesRead).toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  // Shims are Windows files; the platform path API keeps this testable.
  const directory = path.dirname(shimPath)
  let target: string | null = null
  for (const match of text.matchAll(SHIM_TARGET_PATTERN)) {
    const relative = match[1]
    if (!relative || /%/.test(relative)) continue
    if (/(?:^|\\)node\.exe$/i.test(relative)) continue
    if (!/\.(?:js|mjs|exe)$/i.test(relative)) continue
    target = path.resolve(directory, relative.split("\\").join(path.sep))
  }
  return target && (await isFile(target)) ? target : null
}

export interface ClaudeSpawnCommand {
  readonly command: string
  readonly args: string[]
  readonly windowsVerbatimArguments: boolean
}

/**
 * The actual spawn for a command the SDK asks for. Absolute `.exe` files and
 * POSIX commands start directly; a Windows bare name is resolved on PATH
 * first, and a `.cmd`/`.bat` goes through cmd.exe with the shared quoting.
 */
export function claudeSpawnCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly platform?: NodeJS.Platform
    readonly resolveOnPath?: (name: string) => string | null
  } = {}
): ClaudeSpawnCommand {
  const platform = options.platform ?? process.platform
  if (platform !== "win32") {
    return { command, args: [...args], windowsVerbatimArguments: false }
  }
  let target = command
  if (isBareCommandName(command)) {
    const resolved = (
      options.resolveOnPath ??
      ((name: string) =>
        resolveExecutableOnPath(name, { platform, allowScripts: true }))
    )(command)
    // An unresolved bare name fails as ENOENT; it is never handed to cmd.exe,
    // which would search the workspace directory first.
    if (!resolved) {
      return { command, args: [...args], windowsVerbatimArguments: false }
    }
    target = resolved
  }
  if (!requiresWindowsCmdWrapper(target, platform)) {
    return { command: target, args: [...args], windowsVerbatimArguments: false }
  }
  try {
    return {
      command: resolveComSpec(),
      args: buildWindowsCmdArgs(target, args),
      windowsVerbatimArguments: true,
    }
  } catch (error) {
    throw Object.assign(
      new Error(
        `Claude Code at ${target} is a command shim that cannot receive the Agent SDK arguments. ` +
          "Point BetterC0de at claude.exe or at Claude Code's cli.js instead.",
        { cause: error }
      ),
      { code: "CLAUDE_SHIM_UNSUPPORTED" }
    )
  }
}

function isBareCommandName(value: string): boolean {
  return (
    value.length > 0 &&
    !/[\\/]/.test(value) &&
    !isAbsoluteExecutablePath(value) &&
    !/^[a-zA-Z]:/.test(value)
  )
}

function knownClaudeInstallPaths(
  bin: string,
  platform: NodeJS.Platform,
  environment: ClaudeLaunchEnvironment
): string[] {
  const env = environment.env ?? process.env
  const home = environment.homeDir ?? os.homedir()
  if (platform === "win32") {
    const userProfile = env.USERPROFILE || home
    const localAppData =
      env.LOCALAPPDATA || path.win32.join(userProfile, "AppData", "Local")
    const appData =
      env.APPDATA || path.win32.join(userProfile, "AppData", "Roaming")
    return [
      // Native installer.
      path.win32.join(userProfile, ".local", "bin", `${bin}.exe`),
      path.win32.join(localAppData, "Programs", "Anthropic", bin, `${bin}.exe`),
      path.win32.join(appData, "npm", `${bin}.cmd`),
    ]
  }
  return [
    path.posix.join(home, ".local", "bin", bin),
    path.posix.join(home, ".claude", "local", bin),
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
  ]
}

async function firstExistingFile(
  candidates: ReadonlyArray<string>
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }
  return null
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(candidate)).isFile()
  } catch {
    return false
  }
}
