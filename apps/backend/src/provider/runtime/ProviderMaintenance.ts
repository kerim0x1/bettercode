import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import { isSensitiveProviderFieldName } from "@betterc0de/schema"
import {
  isSensitiveChildEnvironmentKey,
  isUnsafeChildEnvironmentKey,
  sanitizedChildEnvironment,
} from "../../security/childEnvironment"
import {
  buildWindowsCmdArgs,
  requiresWindowsCmdWrapper,
  resolveComSpec,
} from "../../security/windowsCommandLine"
import { terminateProviderChildProcessTree } from "./ChildProcessTermination"

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1000
const LATEST_VERSION_TIMEOUT_MS = 4_000
export const PROVIDER_UPDATE_TIMEOUT_MS = 5 * 60_000
export const PROVIDER_UPDATE_OUTPUT_MAX_CHARS = 10_000
const UPDATE_TREE_KILL_GRACE_MS = 250
const UPDATE_ACTION_MESSAGE =
  "Install the update now or review provider settings."

export interface ProviderMaintenanceCommandAction {
  readonly command: string
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly lockKey: string
}

export interface ProviderMaintenanceCapabilities {
  readonly provider: string
  readonly packageName: string | null
  readonly update: ProviderMaintenanceCommandAction | null
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: string
  readonly npmPackageName: string
  readonly homebrewFormula: string | null
  readonly nativeUpdate: {
    readonly executable: string
    readonly args: ReadonlyArray<string>
    readonly lockKey: string
    readonly isCommandPath: (commandPath: string) => boolean
  } | null
}

export interface ProviderVersionAdvisory {
  readonly status: "unknown" | "current" | "behind_latest"
  readonly currentVersion: string | null
  readonly latestVersion: string | null
  readonly updateCommand: string | null
  readonly canUpdate: boolean
  readonly checkedAt: string | null
  readonly message: string | null
}

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export interface ProviderMaintenanceCommandRunnerInput {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly maxOutputChars?: number
}

interface LatestVersionCacheEntry {
  readonly expiresAt: number
  readonly version: string | null
}

const latestVersionCache = new Map<string, LatestVersionCacheEntry>()

export function clearLatestProviderVersionCacheForTests(): void {
  latestVersionCache.clear()
}

export const CODEX_MAINTENANCE_DEFINITION: PackageManagedProviderMaintenanceDefinition =
  {
    provider: "codex",
    npmPackageName: "@openai/codex",
    homebrewFormula: "codex",
    nativeUpdate: null,
  }

export const CLAUDE_MAINTENANCE_DEFINITION: PackageManagedProviderMaintenanceDefinition =
  {
    provider: "claude",
    npmPackageName: "@anthropic-ai/claude-code",
    homebrewFormula: "claude-code",
    nativeUpdate: {
      executable: "claude",
      args: ["update"],
      lockKey: "claude-native",
      isCommandPath: isClaudeNativeCommandPath,
    },
  }

export const GROK_CLI_MAINTENANCE_DEFINITION: PackageManagedProviderMaintenanceDefinition =
  {
    provider: "grok-cli",
    npmPackageName: "@xai-official/grok",
    homebrewFormula: null,
    nativeUpdate: null,
  }

export const OPENCODE_CLI_MAINTENANCE_DEFINITION: PackageManagedProviderMaintenanceDefinition =
  {
    provider: "opencode-cli",
    npmPackageName: "opencode-ai",
    homebrewFormula: "sst/tap/opencode",
    nativeUpdate: {
      executable: "opencode",
      args: ["upgrade"],
      lockKey: "opencode-native",
      isCommandPath: (commandPath) => /(^|[\\/])opencode(\.exe)?$/i.test(commandPath),
    },
  }

export function resolveProviderMaintenanceCapabilities(input: {
  readonly driver: string
  readonly binaryPath?: string | null
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}): ProviderMaintenanceCapabilities {
  const driver = normalizeDriver(input.driver)
  if (driver === "codex") {
    return resolvePackageManagedProviderMaintenance(
      CODEX_MAINTENANCE_DEFINITION,
      input
    )
  }
  if (driver === "claude") {
    return resolvePackageManagedProviderMaintenance(
      CLAUDE_MAINTENANCE_DEFINITION,
      input
    )
  }
  if (driver === "cursor") {
    return makeProviderMaintenanceCapabilities({
      provider: "cursor",
      packageName: null,
      updateExecutable: "agent",
      updateArgs: ["update"],
      updateLockKey: "cursor-agent",
    })
  }
  if (driver === "grok-cli") {
    return resolvePackageManagedProviderMaintenance(
      GROK_CLI_MAINTENANCE_DEFINITION,
      input
    )
  }
  if (driver === "opencode-cli") {
    return resolvePackageManagedProviderMaintenance(
      OPENCODE_CLI_MAINTENANCE_DEFINITION,
      input
    )
  }
  if (driver === "betterc0de") {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: "betterc0de",
      packageName: null,
    })
  }
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: driver,
    packageName: null,
  })
}

export function resolvePackageManagedProviderMaintenance(
  definition: PackageManagedProviderMaintenanceDefinition,
  options: {
    readonly binaryPath?: string | null
    readonly env?: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform
    readonly realCommandPath?: string | null
  } = {}
): ProviderMaintenanceCapabilities {
  const binaryPath = nonEmptyString(options.binaryPath)
  if (!binaryPath)
    return makeNpmGlobalProviderMaintenanceCapabilities(definition)

  const resolvedCommandPath =
    resolveCommandPath(binaryPath, options) ??
    (hasPathSeparator(binaryPath) ? binaryPath : null)
  const commandPaths = [
    ...(resolvedCommandPath ? [resolvedCommandPath] : []),
    ...(options.realCommandPath ? [options.realCommandPath] : []),
  ]

  if (commandPaths.length > 0) {
    const nativeUpdate = definition.nativeUpdate
    if (
      nativeUpdate &&
      commandPaths.some((commandPath) =>
        nativeUpdate.isCommandPath(commandPath)
      )
    ) {
      return makeProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName: definition.npmPackageName,
        updateExecutable: nativeUpdate.executable,
        updateArgs: nativeUpdate.args,
        updateLockKey: nativeUpdate.lockKey,
      })
    }
    if (commandPaths.some(isVitePlusGlobalCommandPath)) {
      return makeProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName: definition.npmPackageName,
        updateExecutable: "vp",
        updateArgs: ["i", "-g", definition.npmPackageName],
        updateLockKey: "vite-plus-global",
      })
    }
    if (commandPaths.some(isBunGlobalCommandPath)) {
      return makeProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName: definition.npmPackageName,
        updateExecutable: "bun",
        updateArgs: ["i", "-g", `${definition.npmPackageName}@latest`],
        updateLockKey: "bun-global",
      })
    }
    if (commandPaths.some(isPnpmGlobalCommandPath)) {
      return makeProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName: definition.npmPackageName,
        updateExecutable: "pnpm",
        updateArgs: ["add", "-g", `${definition.npmPackageName}@latest`],
        updateLockKey: "pnpm-global",
      })
    }
    if (commandPaths.some(isNpmGlobalCommandPath)) {
      return makeNpmGlobalProviderMaintenanceCapabilities(definition)
    }
    if (commandPaths.some(isHomebrewCommandPath)) {
      return definition.homebrewFormula
        ? makeProviderMaintenanceCapabilities({
            provider: definition.provider,
            packageName: definition.npmPackageName,
            updateExecutable: "brew",
            updateArgs: ["upgrade", definition.homebrewFormula],
            updateLockKey: "homebrew",
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: definition.provider,
            packageName: definition.npmPackageName,
          })
    }
  }

  if (!hasPathSeparator(binaryPath)) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition)
  }

  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  })
}

export function createProviderVersionAdvisory(input: {
  readonly driver: string
  readonly currentVersion: string | null
  readonly latestVersion?: string | null
  readonly checkedAt?: string | null
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities
}): ProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: normalizeDriver(input.driver),
      packageName: null,
    })
  const latestVersion = input.latestVersion ?? null
  const status = advisoryStatus(input.currentVersion, latestVersion)
  return {
    status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: status === "behind_latest" ? UPDATE_ACTION_MESSAGE : null,
  }
}

export async function resolveLatestProviderVersion(
  capabilities: ProviderMaintenanceCapabilities
): Promise<string | null> {
  if (!capabilities.packageName) return null
  const cached = latestVersionCache.get(capabilities.packageName)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.version

  const version = await fetchNpmLatestVersion(capabilities.packageName)
  latestVersionCache.set(capabilities.packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  })
  return version
}

export async function runProviderMaintenanceCommand(
  input: ProviderMaintenanceCommandRunnerInput
): Promise<ProviderMaintenanceCommandResult> {
  const timeoutMs = input.timeoutMs ?? PROVIDER_UPDATE_TIMEOUT_MS
  const maxOutputChars =
    input.maxOutputChars ?? PROVIDER_UPDATE_OUTPUT_MAX_CHARS

  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false

    let child: ReturnType<typeof spawn>
    try {
      const useCmd = requiresWindowsCmdWrapper(input.executable)
      child = spawn(
        useCmd ? resolveComSpec() : input.executable,
        useCmd ? buildWindowsCmdArgs(input.executable, input.args) : [...input.args],
        {
          env: maintenanceCommandEnvironment(input.env),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // POSIX tree-kill signals the process group, which requires the
          // child to be the group leader. Windows addresses the tree by PID.
          detached: process.platform !== "win32",
          ...(useCmd ? { windowsVerbatimArguments: true } : {}),
        }
      )
    } catch (error) {
      const appended = appendOutput(
        stderr,
        error instanceof Error ? error.message : String(error),
        maxOutputChars
      )
      resolve({
        stdout,
        stderr: appended.text,
        exitCode: null,
        timedOut,
        stdoutTruncated,
        stderrTruncated: appended.truncated,
      })
      return
    }

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      void (async () => {
        try {
          await terminateProviderChildProcessTree(child)
        } catch {
          // A surviving grandchild must not keep the update lock.
        }
        if (settled) return
        await new Promise<void>((resolve) => {
          const grace = setTimeout(resolve, UPDATE_TREE_KILL_GRACE_MS)
          grace.unref?.()
        })
        if (settled) return
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish({ exitCode: null })
      })()
    }, timeoutMs)
    timer.unref?.()

    const finish = (result: {
      readonly exitCode: number | null
      readonly stderrAppend?: string
    }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result.stderrAppend) {
        const appended = appendOutput(
          stderr,
          result.stderrAppend,
          maxOutputChars
        )
        stderr = appended.text
        stderrTruncated = stderrTruncated || appended.truncated
      }
      resolve({
        stdout,
        stderr,
        exitCode: result.exitCode,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      })
    }

    child.stdout?.on("data", (chunk) => {
      const appended = appendOutput(stdout, String(chunk), maxOutputChars)
      stdout = appended.text
      stdoutTruncated = stdoutTruncated || appended.truncated
    })
    child.stderr?.on("data", (chunk) => {
      const appended = appendOutput(stderr, String(chunk), maxOutputChars)
      stderr = appended.text
      stderrTruncated = stderrTruncated || appended.truncated
    })
    child.on("error", (error) => {
      finish({ exitCode: null, stderrAppend: error.message })
    })
    child.on("close", (code) => {
      finish({ exitCode: typeof code === "number" ? code : null })
    })
  })
}

function makeProviderMaintenanceCapabilities(input: {
  readonly provider: string
  readonly packageName: string | null
  readonly updateExecutable: string | null
  readonly updateArgs: ReadonlyArray<string>
  readonly updateLockKey: string | null
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable && input.updateLockKey
      ? {
          command: [input.updateExecutable, ...input.updateArgs].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
        }
      : null
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
  }
}

/** Update commands must not inherit provider credentials or the parent environment. */
export function isProviderMaintenanceEnvironmentKey(
  name: string,
  sensitive = false
): boolean {
  if (sensitive || !name.trim()) return false
  return (
    !isUnsafeChildEnvironmentKey(name) &&
    !isSensitiveChildEnvironmentKey(name) &&
    !isSensitiveProviderFieldName(name)
  )
}

function maintenanceCommandEnvironment(
  env: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv {
  const base = sanitizedChildEnvironment()
  if (!env) return base
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!isProviderMaintenanceEnvironmentKey(name)) continue
    base[name] = value
  }
  return base
}

function appendOutput(
  current: string,
  chunk: string,
  maxChars: number
): { readonly text: string; readonly truncated: boolean } {
  if (current.length >= maxChars) return { text: current, truncated: true }
  const next = current + chunk
  if (next.length <= maxChars) return { text: next, truncated: false }
  return { text: next.slice(0, maxChars), truncated: true }
}

function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: string
  readonly packageName: string | null
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  })
}

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "npm",
    updateArgs: ["install", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: "npm-global",
  })
}

function advisoryStatus(
  currentVersion: string | null,
  latestVersion: string | null
): ProviderVersionAdvisory["status"] {
  if (!currentVersion || !latestVersion) return "unknown"
  return compareSemverVersions(currentVersion, latestVersion) < 0
    ? "behind_latest"
    : "current"
}

function compareSemverVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function parseVersion(value: string): number[] {
  const numeric = value.match(/\d+(?:\.\d+)*/)?.[0] ?? ""
  return numeric.split(".").map((part) => Number.parseInt(part, 10) || 0)
}

async function fetchNpmLatestVersion(
  packageName: string
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LATEST_VERSION_TIMEOUT_MS)
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      {
        headers: { accept: "application/json" },
        signal: controller.signal,
      }
    )
    if (!response.ok) return null
    const payload = (await response.json().catch(() => null)) as {
      version?: unknown
    } | null
    return nonEmptyString(payload?.version)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// PATH lookups spawn `where`/`which` — without a cache, listInstances
// re-spawned one per instance on EVERY frontend poll (30s × several
// mounted hooks). Cache per binary name for 5 minutes; installs don't
// move that fast.
const COMMAND_PATH_CACHE_TTL_MS = 5 * 60 * 1000
const commandPathCache = new Map<
  string,
  { readonly ts: number; readonly resolved: string | null }
>()

function resolveCommandPath(
  binaryPath: string,
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform
  }
): string | null {
  if (hasPathSeparator(binaryPath)) {
    return fs.existsSync(binaryPath) ? realpathOrSelf(binaryPath) : binaryPath
  }
  const isWin = (options.platform ?? process.platform) === "win32"
  // Key on everything that can change the lookup result: name, platform
  // override (tests), and the PATH the child would search.
  const envPath = options.env
    ? (options.env.PATH ?? options.env.Path ?? "")
    : ""
  const cacheKey = `${binaryPath}\0${options.platform ?? ""}\0${envPath}`
  const hit = commandPathCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < COMMAND_PATH_CACHE_TTL_MS) {
    return hit.resolved
  }
  const command = isWin ? "where" : "which"
  const result = spawnSync(command, [binaryPath], {
    encoding: "utf8",
    env: options.env ?? process.env,
    timeout: 2_000,
  })
  const resolved =
    result.status !== 0
      ? null
      : (result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? null)
  const canonical = resolved ? realpathOrSelf(resolved) : null
  commandPathCache.set(cacheKey, { ts: Date.now(), resolved: canonical })
  return canonical
}

function realpathOrSelf(filePath: string): string {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return filePath
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\")
}

function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase()
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/")
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/")
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  return /\/(?:\.local\/share|library|local\/share|appdata\/local)\/pnpm\/|\/pnpm\/global\//.test(normalizeCommandPath(commandPath))
}

function isNpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath)
  return (
    normalized.includes("/node_modules/.bin/") ||
    normalized.includes("/lib/node_modules/") ||
    normalized.includes("/npm/node_modules/")
  )
}

function isHomebrewCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath)
  return (
    normalized.includes("/opt/homebrew/cellar/") ||
    normalized.includes("/usr/local/cellar/") ||
    normalized.includes("/homebrew/cellar/") ||
    normalized.includes("/opt/homebrew/caskroom/") ||
    normalized.includes("/usr/local/caskroom/") ||
    normalized.includes("/homebrew/caskroom/") ||
    normalized.startsWith("/opt/homebrew/bin/") ||
    normalized.startsWith("/usr/local/bin/")
  )
}

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath)
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  )
}

function normalizeDriver(driver: string): string {
  const normalized = driver
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  if (normalized === "claudeagent" || normalized === "claudecli") {
    return "claude"
  }
  if (normalized === "codexcli") return "codex"
  if (
    normalized === "grokcli" ||
    normalized === "grokagent" ||
    normalized === "grokacp" ||
    normalized === "grokbuild"
  ) {
    return "grok-cli"
  }
  if (
    normalized === "bettercode" ||
    normalized === "betterc0decli" ||
    normalized === "bettercodecli" ||
    normalized === "BetterC0de" ||
    normalized === "BetterC0decli"
  ) {
    return "betterc0de"
  }
  if (
    normalized === "opencode" ||
    normalized === "opencodecli"
  ) {
    return "opencode-cli"
  }
  return normalized || driver
}
