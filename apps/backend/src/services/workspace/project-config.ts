import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { sanitizedShellEnvironment } from "../../security/childEnvironment"
import {
  isPathInside,
  NO_FOLLOW_FLAG,
  safeResolveInside,
  sameWorkspacePathIdentity,
  workspacePathChanged,
  workspacePathIdentity,
} from "./files"
import { runBoundedWorkspaceCommand } from "./processes"

export interface BoundedUtf8File {
  readonly text: string
  readonly bytesRead: number
  readonly truncated: boolean
}

export async function readBoundedUtf8File(
  absolutePath: string,
  maxBytes: number,
  options: { truncate?: boolean } = {}
): Promise<BoundedUtf8File> {
  const before = await fs.lstat(absolutePath)
  if (before.isSymbolicLink()) {
    throw Object.assign(new Error("refusing to read a symbolic link"), {
      code: "ELOOP",
    })
  }
  if (!before.isFile()) {
    throw Object.assign(new Error("not a regular file"), { code: "EINVAL" })
  }
  if (!options.truncate && before.size > maxBytes) {
    throw Object.assign(new Error(`file exceeds the ${maxBytes}-byte limit`), {
      code: "EFBIG",
    })
  }

  const handle = await fs.open(
    absolutePath,
    fsSync.constants.O_RDONLY | NO_FOLLOW_FLAG
  )
  let buffer: Buffer
  let total = 0
  let truncated = before.size > maxBytes
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      !sameWorkspacePathIdentity(
        workspacePathIdentity(before),
        workspacePathIdentity(opened)
      )
    ) {
      throw workspacePathChanged("file changed while it was being opened")
    }

    buffer = Buffer.allocUnsafe(maxBytes + 1)
    while (total < buffer.byteLength) {
      const read = await handle.read(
        buffer,
        total,
        buffer.byteLength - total,
        total
      )
      if (read.bytesRead === 0) break
      total += read.bytesRead
    }
    truncated ||= total > maxBytes
    if (!options.truncate && truncated) {
      throw Object.assign(
        new Error(`file exceeds the ${maxBytes}-byte limit`),
        { code: "EFBIG" }
      )
    }
  } finally {
    await handle.close()
  }

  const after = await fs.lstat(absolutePath)
  if (
    after.isSymbolicLink() ||
    !sameWorkspacePathIdentity(
      workspacePathIdentity(before),
      workspacePathIdentity(after)
    )
  ) {
    throw workspacePathChanged("file changed while it was being read")
  }

  const payload = buffer!.subarray(0, Math.min(total, maxBytes))
  const decoder = new StringDecoder("utf8")
  const text = decoder.write(payload) + (truncated ? "" : decoder.end())
  return {
    text,
    bytesRead: payload.byteLength,
    truncated,
  }
}

const PROJECT_CONFIG_MAX_FILE_BYTES = 512 * 1024

const PROJECT_CONFIG_MAX_FILES = 64

const PROJECT_CONFIG_MAX_TOTAL_BYTES = 4 * 1024 * 1024

const PROJECT_CONFIG_MAX_EXPANDED_BYTES = 2 * 1024 * 1024

const PROJECT_TUI_CONFIG_MAX_FILE_BYTES = 256 * 1024

const PROJECT_TUI_CONFIG_MAX_FILES = 32

const PROJECT_TUI_CONFIG_MAX_TOTAL_BYTES = 2 * 1024 * 1024

const PROJECT_FILE_VARIABLE_MAX_BYTES = 64 * 1024

const PROJECT_FILE_VARIABLE_MAX_COUNT = 32

export const BetterC0de_PROJECT_CONFIG_FILES = [
  "betterc0de.json",
  "betterc0de.jsonc",
  ".betterc0de/betterc0de.json",
  ".betterc0de/betterc0de.jsonc",
  "BetterC0de.json",
  "BetterC0de.jsonc",
  ".BetterC0de/BetterC0de.json",
  ".BetterC0de/BetterC0de.jsonc",
]

export const BetterC0de_GLOBAL_CONFIG_FILES = [
  "config.json",
  "betterc0de.json",
  "betterc0de.jsonc",
  "BetterC0de.json",
  "BetterC0de.jsonc",
]

const BetterC0de_TUI_CONFIG_FILES = [
  "tui.json",
  "tui.jsonc",
  ".betterc0de/tui.json",
  ".betterc0de/tui.jsonc",
  ".BetterC0de/tui.json",
  ".BetterC0de/tui.jsonc",
]

const BetterC0de_GLOBAL_TUI_CONFIG_FILES = ["tui.json", "tui.jsonc"]

const BetterC0de_MANAGED_PLIST_DOMAIN = "ai.BetterC0de.managed"

const BetterC0de_MANAGED_PLIST_META_KEYS = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

export type BetterC0deConfigFileSource = {
  sourcePath: string
  absolutePath: string
  fileVariableScope?: "workspace" | "config-directory"
  workspaceControlled?: boolean
  requiredInStrictMode?: boolean
}

type BetterC0deDirectorySource = {
  sourcePath: string
  absolutePath: string
  loadDirectoryConfig: boolean
  workspaceControlled: boolean
}

const MANAGED_PREFERENCES_COMMAND_TIMEOUT_MS = 10_000

export function invalidProjectPolicy(
  sourcePath: string,
  detail: string
): Error {
  return Object.assign(
    new Error(`Invalid project policy config: ${sourcePath} (${detail})`),
    { statusCode: 503, code: "PROJECT_POLICY_INVALID" }
  )
}

export function normalizeProjectTuiConfig(
  config: unknown
): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {}
  const record = config as Record<string, unknown>
  const nested = readRecord(record, "tui")
  if (Object.keys(nested).length === 0) return record
  const { tui: _tui, ...rest } = record
  return { ...nested, ...rest }
}

/**
 * `workspaceControlled` marks config that came out of the opened repository
 * (`betterc0de.json`, `.betterc0de/**`, ancestor files up to the git root) as
 * opposed to the user's own global/managed config. Anyone reading a key whose
 * value names something the app will *execute* — a shell binary, a formatter
 * command, an MCP stdio command — must branch on this: a cloned repository is
 * untrusted input, and the value is chosen by whoever wrote the repo.
 */
export async function readBetterC0deProjectConfigs(
  workspaceRoot: string,
  options: { strict?: boolean } = {}
): Promise<
  Array<{
    sourcePath: string
    absoluteSourcePath?: string
    config: unknown
    workspaceControlled: boolean
  }>
> {
  const configs: Array<{
    sourcePath: string
    absoluteSourcePath?: string
    config: unknown
    workspaceControlled: boolean
  }> = []
  const seenFiles = new Set<string>()
  let loadedFileCount = 0
  let loadedBytes = 0

  async function readConfigSource(
    source: BetterC0deConfigFileSource
  ): Promise<void> {
    const requestedPath = path.resolve(source.absolutePath)
    const absolutePath = platformCanonicalAbsolutePath(requestedPath)
    const sourcePath = formatBetterC0deDirectoryFileSourcePath(
      workspaceRoot,
      absolutePath
    )
    const pathKey = platformAbsolutePathKey(absolutePath)
    if (seenFiles.has(pathKey)) return

    let substituted: string
    try {
      if (loadedFileCount >= PROJECT_CONFIG_MAX_FILES) {
        throw Object.assign(new Error("project config file limit exceeded"), {
          code: "EFBIG",
        })
      }
      const read = await readBoundedUtf8File(
        requestedPath,
        PROJECT_CONFIG_MAX_FILE_BYTES
      )
      if (loadedBytes + read.bytesRead > PROJECT_CONFIG_MAX_TOTAL_BYTES) {
        throw Object.assign(
          new Error("aggregate project config byte limit exceeded"),
          { code: "EFBIG" }
        )
      }
      loadedFileCount += 1
      loadedBytes += read.bytesRead
      substituted = await substituteBetterC0deConfigVariables(
        workspaceRoot,
        sourcePath,
        read.text,
        {
          absoluteSourcePath: absolutePath,
          fileVariableScope: source.fileVariableScope,
          allowEnvironmentVariables: source.workspaceControlled !== true,
        }
      )
    } catch (error) {
      const missingOptionalSource =
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        source.requiredInStrictMode !== true
      if (options.strict && !missingOptionalSource) {
        throw invalidProjectPolicy(
          sourcePath,
          source.requiredInStrictMode === true
            ? "explicit config source could not be read"
            : "config source could not be read"
        )
      }
      return
    }

    const config = parseJsoncObject(substituted)
    if (
      options.strict &&
      (!config || typeof config !== "object" || Array.isArray(config))
    ) {
      throw Object.assign(
        new Error(`Invalid project policy config: ${sourcePath}`),
        { statusCode: 503 }
      )
    }
    if (config && typeof config === "object" && !Array.isArray(config)) {
      seenFiles.add(pathKey)
      configs.push({
        sourcePath,
        absoluteSourcePath: absolutePath,
        config,
        workspaceControlled: source.workspaceControlled === true,
      })
    }
  }

  async function readInlineConfigSource(
    sourcePath: string,
    rawContent: string | undefined
  ): Promise<void> {
    const content = rawContent?.trim()
    if (!content) return
    const rawBytes = Buffer.byteLength(content, "utf8")
    if (
      rawBytes > PROJECT_CONFIG_MAX_FILE_BYTES ||
      loadedFileCount >= PROJECT_CONFIG_MAX_FILES
    ) {
      if (options.strict) {
        throw invalidProjectPolicy(
          sourcePath,
          "config source exceeds its size limit"
        )
      }
      return
    }

    const substituted = await substituteBetterC0deConfigVariables(
      workspaceRoot,
      sourcePath,
      content
    )
    const substitutedBytes = Buffer.byteLength(substituted, "utf8")
    if (
      substitutedBytes > PROJECT_CONFIG_MAX_FILE_BYTES ||
      loadedBytes + substitutedBytes > PROJECT_CONFIG_MAX_TOTAL_BYTES
    ) {
      if (options.strict) {
        throw invalidProjectPolicy(
          sourcePath,
          "config source exceeds the aggregate size limit"
        )
      }
      return
    }
    const config = parseJsoncObject(substituted)
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      if (options.strict) {
        throw invalidProjectPolicy(
          sourcePath,
          "config source is not a valid object"
        )
      }
      return
    }
    loadedFileCount += 1
    loadedBytes += substitutedBytes
    configs.push({ sourcePath, config, workspaceControlled: false })
  }

  for (const source of betterC0deGlobalConfigSources(
    BetterC0de_GLOBAL_CONFIG_FILES
  )) {
    await readConfigSource(source)
  }
  const explicitBetterC0deConfig =
    betterC0deExplicitConfigSource("BETTERC0DE_CONFIG")
  if (explicitBetterC0deConfig) {
    await readConfigSource(explicitBetterC0deConfig)
  }
  const explicitConfig = betterC0deExplicitConfigSource("BetterC0de_CONFIG")
  if (explicitConfig) {
    await readConfigSource(explicitConfig)
  }
  for (const source of betterC0deProjectConfigFileSources(
    workspaceRoot,
    BetterC0de_PROJECT_CONFIG_FILES
  )) {
    await readConfigSource(source)
  }
  for (const source of betterC0deDirectoryConfigFileSources(workspaceRoot, [
    "betterc0de.json",
    "betterc0de.jsonc",
    "BetterC0de.json",
    "BetterC0de.jsonc",
  ])) {
    await readConfigSource(source)
  }
  await readInlineConfigSource(
    "BETTERC0DE_CONFIG_CONTENT",
    process.env.BETTERC0DE_CONFIG_CONTENT
  )
  await readInlineConfigSource(
    "BetterC0de_CONFIG_CONTENT",
    process.env.BetterC0de_CONFIG_CONTENT
  )
  for (const source of betterC0deManagedConfigSources([
    "betterc0de.json",
    "betterc0de.jsonc",
    "BetterC0de.json",
    "BetterC0de.jsonc",
  ])) {
    await readConfigSource(source)
  }
  const managedPreferences = await readBetterC0deManagedPreferencesConfig(
    options.strict === true
  )
  if (managedPreferences) {
    const managedBytes = Buffer.byteLength(managedPreferences.content, "utf8")
    if (
      managedBytes > PROJECT_CONFIG_MAX_FILE_BYTES ||
      loadedFileCount >= PROJECT_CONFIG_MAX_FILES ||
      loadedBytes + managedBytes > PROJECT_CONFIG_MAX_TOTAL_BYTES
    ) {
      if (options.strict) {
        throw invalidProjectPolicy(
          managedPreferences.sourcePath,
          "managed preferences exceed the config size limit"
        )
      }
    } else {
      const config = parseJsoncObject(managedPreferences.content)
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        if (options.strict) {
          throw invalidProjectPolicy(
            managedPreferences.sourcePath,
            "managed preferences are not a valid object"
          )
        }
      } else {
        loadedFileCount += 1
        loadedBytes += managedBytes
        configs.push({
          sourcePath: managedPreferences.sourcePath,
          absoluteSourcePath: managedPreferences.absolutePath,
          config,
          workspaceControlled: false,
        })
      }
    }
  }
  const permissionConfig = process.env.BetterC0de_PERMISSION?.trim()
  if (permissionConfig) {
    const permissionBytes = Buffer.byteLength(permissionConfig, "utf8")
    if (
      permissionBytes > PROJECT_CONFIG_MAX_FILE_BYTES ||
      loadedFileCount >= PROJECT_CONFIG_MAX_FILES ||
      loadedBytes + permissionBytes > PROJECT_CONFIG_MAX_TOTAL_BYTES
    ) {
      if (options.strict) {
        throw invalidProjectPolicy(
          "BetterC0de_PERMISSION",
          "permission override exceeds the config size limit"
        )
      }
    } else {
      const permission = parseJsoncObject(permissionConfig)
      if (
        isPermissionAction(permission) ||
        (permission &&
          typeof permission === "object" &&
          !Array.isArray(permission))
      ) {
        loadedFileCount += 1
        loadedBytes += permissionBytes
        configs.push({
          sourcePath: "BetterC0de_PERMISSION",
          config: { permission },
          workspaceControlled: false,
        })
      } else if (options.strict) {
        throw invalidProjectPolicy(
          "BetterC0de_PERMISSION",
          "permission override is invalid"
        )
      }
    }
  }
  const disabledCompaction: Record<string, unknown> = {}
  if (
    parseBooleanScalar(process.env.BetterC0de_DISABLE_AUTOCOMPACT ?? "") ===
    true
  ) {
    disabledCompaction.auto = false
  }
  if (parseBooleanScalar(process.env.BetterC0de_DISABLE_PRUNE ?? "") === true) {
    disabledCompaction.prune = false
  }
  if (Object.keys(disabledCompaction).length > 0) {
    configs.push({
      sourcePath: "BetterC0de environment flags",
      config: { compaction: disabledCompaction },
      workspaceControlled: false,
    })
  }
  if (parseBooleanScalar(process.env.BetterC0de_AUTO_SHARE ?? "") === true) {
    configs.push({
      sourcePath: "BetterC0de_AUTO_SHARE",
      config: { "runtime.autoShare": true },
      workspaceControlled: false,
    })
  }
  const pluginRuntimeFlags: Record<string, unknown> = {}
  if (isBetterC0dePureMode()) pluginRuntimeFlags["runtime.pure"] = true
  if (
    parseBooleanScalar(process.env.BetterC0de_DISABLE_DEFAULT_PLUGINS ?? "") ===
    true
  ) {
    pluginRuntimeFlags["runtime.disableDefaultPlugins"] = true
  }
  if (Object.keys(pluginRuntimeFlags).length > 0) {
    configs.push({
      sourcePath: "BetterC0de plugin runtime flags",
      config: pluginRuntimeFlags,
      workspaceControlled: false,
    })
  }
  if (isBetterC0deClaudeCodePromptDisabled()) {
    configs.push({
      sourcePath: "BetterC0de prompt runtime flags",
      config: { "runtime.disableClaudeCodePrompt": true },
      workspaceControlled: false,
    })
  }
  const runtimeFlagConfig = readBetterC0deRuntimeFlagConfig()
  if (Object.keys(runtimeFlagConfig).length > 0) {
    configs.push({
      sourcePath: "BetterC0de runtime flags",
      config: runtimeFlagConfig,
      workspaceControlled: false,
    })
  }
  const bashDefaultTimeoutMs = parsePositiveIntegerScalar(
    process.env.BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS ?? ""
  )
  if (bashDefaultTimeoutMs !== undefined) {
    configs.push({
      sourcePath: "BetterC0de shell runtime flags",
      config: { "runtime.bashDefaultTimeoutMs": bashDefaultTimeoutMs },
      workspaceControlled: false,
    })
  }
  if (parseBooleanScalar(process.env.BetterC0de_DISABLE_SHARE ?? "") === true) {
    configs.push({
      sourcePath: "BetterC0de_DISABLE_SHARE",
      config: { share: "disabled" },
      workspaceControlled: false,
    })
  }
  return configs
}

export async function readBetterC0deProjectTuiConfigs(
  workspaceRoot: string
): Promise<Array<{ sourcePath: string; config: Record<string, unknown> }>> {
  const configs: Array<{
    sourcePath: string
    config: Record<string, unknown>
  }> = []
  const seenFiles = new Set<string>()
  let loadedFileCount = 0
  let loadedBytes = 0

  async function readTuiSource(
    source: BetterC0deConfigFileSource
  ): Promise<void> {
    const requestedPath = path.resolve(source.absolutePath)
    const absolutePath = platformCanonicalAbsolutePath(requestedPath)
    const sourcePath = formatBetterC0deDirectoryFileSourcePath(
      workspaceRoot,
      absolutePath
    )
    const pathKey = platformAbsolutePathKey(absolutePath)
    if (seenFiles.has(pathKey)) return
    seenFiles.add(pathKey)

    let substituted: string
    try {
      if (loadedFileCount >= PROJECT_TUI_CONFIG_MAX_FILES) return
      const read = await readBoundedUtf8File(
        requestedPath,
        PROJECT_TUI_CONFIG_MAX_FILE_BYTES
      )
      if (loadedBytes + read.bytesRead > PROJECT_TUI_CONFIG_MAX_TOTAL_BYTES) {
        return
      }
      loadedFileCount += 1
      loadedBytes += read.bytesRead
      substituted = await substituteBetterC0deConfigVariables(
        workspaceRoot,
        sourcePath,
        read.text,
        {
          absoluteSourcePath: absolutePath,
          fileVariableScope: source.fileVariableScope,
          allowEnvironmentVariables: source.workspaceControlled !== true,
        }
      )
    } catch {
      return
    }

    const parsed = normalizeProjectTuiConfig(parseJsoncObject(substituted))
    if (Object.keys(parsed).length > 0) {
      configs.push({
        sourcePath,
        config: parsed,
      })
    }
  }

  for (const source of betterC0deGlobalConfigSources(
    BetterC0de_GLOBAL_TUI_CONFIG_FILES
  )) {
    await readTuiSource(source)
  }
  const explicitBetterC0deTuiConfig = betterC0deExplicitConfigSource(
    "BETTERC0DE_TUI_CONFIG"
  )
  if (explicitBetterC0deTuiConfig) {
    await readTuiSource(explicitBetterC0deTuiConfig)
  }
  const explicitTuiConfig = betterC0deExplicitConfigSource(
    "BetterC0de_TUI_CONFIG"
  )
  if (explicitTuiConfig) {
    await readTuiSource(explicitTuiConfig)
  }
  for (const source of betterC0deProjectConfigFileSources(
    workspaceRoot,
    BetterC0de_TUI_CONFIG_FILES
  )) {
    await readTuiSource(source)
  }
  for (const source of betterC0deDirectoryConfigFileSources(workspaceRoot, [
    "tui.json",
    "tui.jsonc",
  ])) {
    await readTuiSource(source)
  }
  return configs
}

export function betterC0deExplicitConfigSource(
  envName:
    | "BETTERC0DE_CONFIG"
    | "BETTERC0DE_TUI_CONFIG"
    | "BetterC0de_CONFIG"
    | "BetterC0de_TUI_CONFIG"
): BetterC0deConfigFileSource | null {
  const raw = process.env[envName]?.trim()
  if (!raw) return null
  const absolutePath = path.resolve(expandHomePath(raw))
  return {
    absolutePath,
    sourcePath: formatBetterC0deConfigSourcePath(absolutePath),
    fileVariableScope: "config-directory",
    requiredInStrictMode:
      envName === "BETTERC0DE_CONFIG" || envName === "BetterC0de_CONFIG",
  }
}

export function betterC0deGlobalConfigSources(
  fileNames: readonly string[]
): BetterC0deConfigFileSource[] {
  const dirs = betterC0deGlobalConfigDirectories()
  return dirs.flatMap((configDir) =>
    fileNames.map((fileName) => {
      const absolutePath = path.join(configDir, fileName)
      return {
        absolutePath,
        sourcePath: formatBetterC0deConfigSourcePath(absolutePath),
        fileVariableScope: "config-directory" as const,
      }
    })
  )
}

export function betterC0deGlobalConfigDirectories(): string[] {
  return uniqueAbsolutePaths([
    betterC0deDefaultGlobalConfigDir(),
    ...[betterC0deConfiguredConfigDir()].filter(
      (dir): dir is string => typeof dir === "string"
    ),
  ])
}

export function betterC0deManagedConfigSources(
  fileNames: readonly string[]
): BetterC0deConfigFileSource[] {
  const configDir = betterC0deManagedConfigDir()
  if (!fsSync.existsSync(configDir)) return []
  return fileNames.map((fileName) => {
    const absolutePath = path.join(configDir, fileName)
    return {
      absolutePath,
      sourcePath: formatBetterC0deConfigSourcePath(absolutePath),
      fileVariableScope: "config-directory" as const,
    }
  })
}

async function readBetterC0deManagedPreferencesConfig(strict = false): Promise<{
  sourcePath: string
  absolutePath: string
  content: string
} | null> {
  const paths = betterC0deManagedPreferencesPaths()
  for (const plistPath of paths) {
    let converted: string | null = null
    try {
      const read = await readBoundedUtf8File(
        plistPath,
        PROJECT_CONFIG_MAX_FILE_BYTES
      )
      converted = parseBetterC0deManagedPreferencesJson(read.text)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      if (strict && (error as NodeJS.ErrnoException).code === "EFBIG") {
        throw invalidProjectPolicy(
          `mobileconfig:${plistPath}`,
          "managed preferences exceed the config size limit"
        )
      }
      converted = await convertBetterC0deManagedPreferencePlist(plistPath)
    }
    if (!converted) {
      if (strict) {
        throw invalidProjectPolicy(
          `mobileconfig:${plistPath}`,
          "managed preferences could not be parsed"
        )
      }
      continue
    }
    return {
      absolutePath: plistPath,
      sourcePath: `mobileconfig:${plistPath}`,
      content: converted,
    }
  }
  return null
}

function betterC0deManagedPreferencesPaths(): string[] {
  const testFile = process.env.BetterC0de_TEST_MANAGED_PREFERENCES_FILE?.trim()
  if (testFile) return [path.resolve(expandHomePath(testFile))]
  if (process.platform !== "darwin") return []
  const username = os.userInfo().username
  return [
    path.join(
      "/Library/Managed Preferences",
      username,
      `${BetterC0de_MANAGED_PLIST_DOMAIN}.plist`
    ),
    path.join(
      "/Library/Managed Preferences",
      `${BetterC0de_MANAGED_PLIST_DOMAIN}.plist`
    ),
  ]
}

function parseBetterC0deManagedPreferencesJson(json: string): string {
  const raw = JSON.parse(json) as Record<string, unknown>
  for (const key of BetterC0de_MANAGED_PLIST_META_KEYS) {
    delete raw[key]
  }
  return JSON.stringify(raw)
}

async function convertBetterC0deManagedPreferencePlist(
  plistPath: string
): Promise<string | null> {
  if (!fsSync.existsSync(plistPath)) return null
  const result = await runCommandCapture("plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    plistPath,
  ])
  if (result.exitCode !== 0) return null
  try {
    return parseBetterC0deManagedPreferencesJson(result.stdout)
  } catch {
    return null
  }
}

async function runCommandCapture(
  command: string,
  args: string[]
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runBoundedWorkspaceCommand({
    command,
    args,
    env: sanitizedShellEnvironment(),
    timeoutMs: MANAGED_PREFERENCES_COMMAND_TIMEOUT_MS,
    outputLimitBytes: PROJECT_CONFIG_MAX_FILE_BYTES,
    label: `config-helper:${command}`,
  })
  return {
    exitCode:
      result.failure ||
      result.timedOut ||
      result.outputExceeded ||
      result.treeError ||
      result.exitCode === null
        ? -1
        : result.exitCode,
    stdout: result.stdout,
    stderr: [
      result.stderr,
      result.timedOut ? `${command} timed out.` : "",
      result.outputExceeded
        ? `${command} output exceeded ${PROJECT_CONFIG_MAX_FILE_BYTES} bytes.`
        : "",
      result.treeError
        ? `${command} process tree did not settle: ${result.treeError}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

function betterC0deWorkspaceFileSources(
  workspaceRoot: string,
  sourcePaths: readonly string[]
): BetterC0deConfigFileSource[] {
  return sourcePaths.flatMap((sourcePath) => {
    try {
      return [
        {
          absolutePath: safeResolveInside(workspaceRoot, sourcePath),
          sourcePath,
          fileVariableScope: "workspace" as const,
          workspaceControlled: true,
        },
      ]
    } catch {
      return []
    }
  })
}

function betterC0deProjectFileSources(
  workspaceRoot: string,
  sourcePaths: readonly string[]
): BetterC0deConfigFileSource[] {
  const topLevelFiles = sourcePaths.filter((sourcePath) =>
    isTopLevelConfigFileName(sourcePath)
  )
  const nestedFiles = sourcePaths.filter(
    (sourcePath) => !isTopLevelConfigFileName(sourcePath)
  )
  return [
    ...betterC0deAncestorProjectFileSources(workspaceRoot, topLevelFiles),
    ...betterC0deWorkspaceFileSources(workspaceRoot, nestedFiles),
  ]
}

export function betterC0deProjectConfigFileSources(
  workspaceRoot: string,
  sourcePaths: readonly string[]
): BetterC0deConfigFileSource[] {
  if (isBetterC0deProjectConfigDisabled()) return []
  return betterC0deProjectFileSources(workspaceRoot, sourcePaths)
}

function betterC0deAncestorProjectFileSources(
  workspaceRoot: string,
  fileNames: readonly string[]
): BetterC0deConfigFileSource[] {
  const root = path.resolve(workspaceRoot)
  const stop = findNearestGitRootSync(root) ?? root
  const directories: string[] = []
  let current = root
  while (true) {
    directories.push(current)
    if (current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  directories.reverse()
  return directories.flatMap((directory) =>
    fileNames.map((fileName) => {
      const absolutePath = path.join(directory, fileName)
      return {
        absolutePath,
        sourcePath: formatBetterC0deDirectoryFileSourcePath(
          workspaceRoot,
          absolutePath
        ),
        fileVariableScope: "workspace" as const,
        workspaceControlled: true,
      }
    })
  )
}

function isTopLevelConfigFileName(sourcePath: string): boolean {
  return !sourcePath.includes("/") && !sourcePath.includes("\\")
}

/**
 * Ancestor crawls (git root, `.betterc0de` directories above the workspace)
 * walk to the drive root with one or two `existsSync` per level, and every
 * search, quick-open and config read used to repeat that per request. The
 * results above the workspace root change rarely, so they are cached for
 * this long; the workspace root itself is always checked live so a
 * `.betterc0de` created inside the open project is seen immediately.
 */
const ANCESTOR_CRAWL_TTL_MS = 30_000
const ANCESTOR_CRAWL_CACHE_MAX_ENTRIES = 256

interface AncestorCrawlEntry<T> {
  readonly checkedAt: number
  readonly value: T
}

const nearestGitRootCache = new Map<string, AncestorCrawlEntry<string | null>>()
const ancestorConfigDirCache = new Map<string, AncestorCrawlEntry<string[]>>()

function readAncestorCrawlCache<T>(
  cache: Map<string, AncestorCrawlEntry<T>>,
  key: string
): AncestorCrawlEntry<T> | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.checkedAt >= ANCESTOR_CRAWL_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit
}

function writeAncestorCrawlCache<T>(
  cache: Map<string, AncestorCrawlEntry<T>>,
  key: string,
  value: T
): T {
  cache.delete(key)
  cache.set(key, { checkedAt: Date.now(), value })
  while (cache.size > ANCESTOR_CRAWL_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
  return value
}

export function __resetProjectConfigCrawlCachesForTests(): void {
  nearestGitRootCache.clear()
  ancestorConfigDirCache.clear()
}

/**
 * The workspace root's own `.git` is checked live, like `.betterc0de`: a
 * `git init` inside an open workspace must take effect on the next request,
 * not after ANCESTOR_CRAWL_TTL_MS. Only the walk *above* the root is cached.
 */
function findNearestGitRootSync(start: string): string | null {
  const resolved = path.resolve(start)
  if (fsSync.existsSync(path.join(resolved, ".git"))) return resolved
  const parent = path.dirname(resolved)
  if (parent === resolved) return null
  return findNearestGitRootAboveSync(parent)
}

function findNearestGitRootAboveSync(start: string): string | null {
  const resolved = path.resolve(start)
  const key = platformAbsolutePathKey(resolved)
  const cached = readAncestorCrawlCache(nearestGitRootCache, key)
  if (cached) return cached.value
  let current = resolved
  while (true) {
    if (fsSync.existsSync(path.join(current, ".git"))) {
      return writeAncestorCrawlCache(nearestGitRootCache, key, current)
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return writeAncestorCrawlCache(nearestGitRootCache, key, null)
    }
    current = parent
  }
}

/**
 * `.betterc0de` / `.BetterC0de` directories in `parent` and every directory
 * above it, nearest first. Cached; see ANCESTOR_CRAWL_TTL_MS.
 */
function ancestorBetterC0deConfigDirs(parent: string): string[] {
  const key = platformAbsolutePathKey(parent)
  const cached = readAncestorCrawlCache(ancestorConfigDirCache, key)
  if (cached) return cached.value
  const found: string[] = []
  let current = parent
  while (true) {
    for (const name of [".betterc0de", ".BetterC0de"]) {
      const candidate = path.join(current, name)
      if (fsSync.existsSync(candidate)) found.push(candidate)
    }
    const next = path.dirname(current)
    if (next === current) break
    current = next
  }
  return writeAncestorCrawlCache(ancestorConfigDirCache, key, found)
}

export function betterC0deDirectoryConfigFileSources(
  workspaceRoot: string,
  fileNames: readonly string[]
): BetterC0deConfigFileSource[] {
  return betterC0deConfigDirectorySources(workspaceRoot)
    .filter((source) => source.loadDirectoryConfig)
    .flatMap((dir) =>
      fileNames.map((fileName) => {
        const absolutePath = path.join(dir.absolutePath, fileName)
        return {
          absolutePath,
          sourcePath: formatBetterC0deDirectoryFileSourcePath(
            workspaceRoot,
            absolutePath
          ),
          fileVariableScope: "config-directory" as const,
          workspaceControlled: dir.workspaceControlled,
        }
      })
    )
}

export function betterC0deConfigDirectorySources(
  workspaceRoot: string
): BetterC0deDirectorySource[] {
  const root = path.resolve(workspaceRoot)
  const out: BetterC0deDirectorySource[] = []
  const seen = new Set<string>()
  const add = (
    absolutePath: string,
    loadDirectoryConfig: boolean,
    workspaceControlled: boolean
  ): void => {
    const normalized = platformCanonicalAbsolutePath(absolutePath)
    const key = platformAbsolutePathKey(normalized)
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      absolutePath: normalized,
      sourcePath: formatBetterC0deDirectorySourcePath(root, normalized),
      loadDirectoryConfig,
      workspaceControlled,
    })
  }

  add(betterC0deDefaultGlobalConfigDir(), false, false)
  add(legacyBetterC0deDefaultGlobalConfigDir(), false, false)

  if (!isBetterC0deProjectConfigDisabled()) {
    // The workspace root is checked live; ancestors come from the cache.
    for (const name of [".betterc0de", ".BetterC0de"]) {
      const candidate = path.join(root, name)
      if (fsSync.existsSync(candidate)) add(candidate, true, true)
    }
    const parent = path.dirname(root)
    if (parent !== root) {
      for (const candidate of ancestorBetterC0deConfigDirs(parent)) {
        add(candidate, true, true)
      }
    }
  }

  const homeBetterC0de = path.join(betterC0deHomeDir(), ".betterc0de")
  if (fsSync.existsSync(homeBetterC0de)) add(homeBetterC0de, true, false)

  const legacyHomeBetterC0de = path.join(betterC0deHomeDir(), ".BetterC0de")
  if (fsSync.existsSync(legacyHomeBetterC0de)) {
    add(legacyHomeBetterC0de, true, false)
  }

  const configured = betterC0deConfiguredConfigDir()
  if (configured) add(configured, true, false)

  return out
}

function legacyBetterC0deDefaultGlobalConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim()
  return path.join(
    path.resolve(
      expandHomePath(xdgConfig || path.join(betterC0deHomeDir(), ".config"))
    ),
    "betterc0de"
  )
}

function betterC0deDefaultGlobalConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim()
  return path.join(
    path.resolve(
      expandHomePath(xdgConfig || path.join(betterC0deHomeDir(), ".config"))
    ),
    "BetterC0de"
  )
}

function betterC0deConfiguredConfigDir(): string | null {
  const configured =
    process.env.BETTERC0DE_CONFIG_DIR?.trim() ??
    process.env.BetterC0de_CONFIG_DIR?.trim()
  return configured ? path.resolve(expandHomePath(configured)) : null
}

function betterC0deManagedConfigDir(): string {
  const configured =
    process.env.BETTERC0DE_TEST_MANAGED_CONFIG_DIR?.trim() ??
    process.env.BetterC0de_TEST_MANAGED_CONFIG_DIR?.trim()
  if (configured) return path.resolve(expandHomePath(configured))
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/betterc0de"
    case "win32":
      return path.join(
        process.env.ProgramData || "C:\\ProgramData",
        "BetterC0de"
      )
    default:
      return "/etc/betterc0de"
  }
}

export function isBetterC0deProjectConfigDisabled(): boolean {
  return (
    parseBooleanScalar(
      process.env.BETTERC0DE_DISABLE_PROJECT_CONFIG ??
        process.env.BetterC0de_DISABLE_PROJECT_CONFIG ??
        ""
    ) === true
  )
}

export function isBetterC0dePureMode(): boolean {
  return parseBooleanScalar(process.env.BetterC0de_PURE ?? "") === true
}

export function isBetterC0deClaudeCodeSkillsDisabled(): boolean {
  return (
    parseBooleanScalar(process.env.BetterC0de_DISABLE_CLAUDE_CODE ?? "") ===
      true ||
    parseBooleanScalar(
      process.env.BetterC0de_DISABLE_CLAUDE_CODE_SKILLS ?? ""
    ) === true
  )
}

export function isBetterC0deClaudeCodePromptDisabled(): boolean {
  return (
    parseBooleanScalar(process.env.BetterC0de_DISABLE_CLAUDE_CODE ?? "") ===
      true ||
    parseBooleanScalar(
      process.env.BetterC0de_DISABLE_CLAUDE_CODE_PROMPT ?? ""
    ) === true
  )
}

function readBetterC0deRuntimeFlagConfig(
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  const isEnabled = (name: string): boolean =>
    parseBooleanScalar(env[name] ?? "") === true
  const setBool = (key: string, name: string): void => {
    if (isEnabled(name)) config[`runtime.${key}`] = true
  }
  const setExperimentalBool = (key: string, name: string): void => {
    if (experimental || isEnabled(name)) config[`runtime.${key}`] = true
  }

  const experimental = isEnabled("BetterC0de_EXPERIMENTAL")
  if (experimental) config["runtime.experimental"] = true
  setBool("autoHeapSnapshot", "BetterC0de_AUTO_HEAP_SNAPSHOT")
  setBool("disableAutoupdate", "BetterC0de_DISABLE_AUTOUPDATE")
  setBool("alwaysNotifyUpdate", "BetterC0de_ALWAYS_NOTIFY_UPDATE")
  setBool("disableModelsFetch", "BetterC0de_DISABLE_MODELS_FETCH")
  setBool("experimentalFileWatcher", "BetterC0de_EXPERIMENTAL_FILEWATCHER")
  setBool(
    "experimentalDisableFileWatcher",
    "BetterC0de_EXPERIMENTAL_DISABLE_FILEWATCHER"
  )
  setBool(
    "experimentalDisableCopyOnSelect",
    "BetterC0de_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"
  )
  setBool("directTrace", "BetterC0de_DIRECT_TRACE")
  setBool("disableMouse", "BetterC0de_DISABLE_MOUSE")
  setBool("disableTerminalTitle", "BetterC0de_DISABLE_TERMINAL_TITLE")
  setBool("showTtfd", "BetterC0de_SHOW_TTFD")
  setBool("disableChannelDb", "BetterC0de_DISABLE_CHANNEL_DB")
  setBool("disableEmbeddedWebUi", "BetterC0de_DISABLE_EMBEDDED_WEB_UI")
  setBool("disableExternalSkills", "BetterC0de_DISABLE_EXTERNAL_SKILLS")
  setBool("disableLspDownload", "BetterC0de_DISABLE_LSP_DOWNLOAD")
  setBool("skipMigrations", "BetterC0de_SKIP_MIGRATIONS")
  if (isBetterC0deClaudeCodeSkillsDisabled()) {
    config["runtime.disableClaudeCodeSkills"] = true
  }
  if (
    experimental ||
    isEnabled("BetterC0de_ENABLE_EXA") ||
    isEnabled("BetterC0de_EXPERIMENTAL_EXA")
  ) {
    config["runtime.enableExa"] = true
  }
  if (
    isEnabled("BetterC0de_ENABLE_PARALLEL") ||
    isEnabled("BetterC0de_EXPERIMENTAL_PARALLEL")
  ) {
    config["runtime.enableParallel"] = true
  }
  const webSearchProvider = env.BetterC0de_WEBSEARCH_PROVIDER?.trim()
  if (webSearchProvider === "exa" || webSearchProvider === "parallel") {
    config["runtime.webSearchProvider"] = webSearchProvider
  }
  setBool("enableExperimentalModels", "BetterC0de_ENABLE_EXPERIMENTAL_MODELS")
  setBool("enableQuestionTool", "BetterC0de_ENABLE_QUESTION_TOOL")
  setExperimentalBool("experimentalScout", "BetterC0de_EXPERIMENTAL_SCOUT")
  setExperimentalBool(
    "experimentalBackgroundSubagents",
    "BetterC0de_EXPERIMENTAL_BACKGROUND_SUBAGENTS"
  )
  setBool("experimentalLspTy", "BetterC0de_EXPERIMENTAL_LSP_TY")
  setExperimentalBool("experimentalLspTool", "BetterC0de_EXPERIMENTAL_LSP_TOOL")
  setExperimentalBool("experimentalOxfmt", "BetterC0de_EXPERIMENTAL_OXFMT")
  setExperimentalBool(
    "experimentalPlanMode",
    "BetterC0de_EXPERIMENTAL_PLAN_MODE"
  )
  setExperimentalBool(
    "experimentalEventSystem",
    "BetterC0de_EXPERIMENTAL_EVENT_SYSTEM"
  )
  setExperimentalBool(
    "experimentalWorkspaces",
    "BetterC0de_EXPERIMENTAL_WORKSPACES"
  )
  setExperimentalBool(
    "experimentalIconDiscovery",
    "BetterC0de_EXPERIMENTAL_ICON_DISCOVERY"
  )
  setExperimentalBool(
    "experimentalNativeLlm",
    "BetterC0de_EXPERIMENTAL_NATIVE_LLM"
  )
  const outputTokenMax = parsePositiveIntegerScalar(
    env.BetterC0de_EXPERIMENTAL_OUTPUT_TOKEN_MAX ?? ""
  )
  if (outputTokenMax !== undefined) {
    config["runtime.outputTokenMax"] = outputTokenMax
  }
  const client = env.BetterC0de_CLIENT?.trim()
  if (client) config["runtime.client"] = client
  const modelsUrl = env.BetterC0de_MODELS_URL?.trim()
  if (modelsUrl) config["runtime.modelsUrl"] = modelsUrl
  const modelsPath = env.BetterC0de_MODELS_PATH?.trim()
  if (modelsPath) config["runtime.modelsPath"] = modelsPath
  const fakeVcs = env.BetterC0de_FAKE_VCS?.trim()
  if (fakeVcs) config["runtime.fakeVcs"] = fakeVcs
  const workspaceId = env.BetterC0de_WORKSPACE_ID?.trim()
  if (workspaceId) config["runtime.workspaceId"] = workspaceId
  const repoCloneGithubBaseUrl =
    env.BetterC0de_REPO_CLONE_GITHUB_BASE_URL?.trim()
  if (repoCloneGithubBaseUrl) {
    config["runtime.repoCloneGithubBaseUrl"] = repoCloneGithubBaseUrl
  }

  return config
}

export function betterC0deHomeDir(): string {
  const raw = process.env.BetterC0de_TEST_HOME?.trim() || os.homedir()
  if (raw === "~") return path.resolve(os.homedir())
  if (raw.startsWith("~/")) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)))
  }
  return path.resolve(raw)
}

export function expandHomePath(input: string): string {
  if (input === "~") return betterC0deHomeDir()
  if (input.startsWith("~/"))
    return path.join(betterC0deHomeDir(), input.slice(2))
  return input
}

export function formatBetterC0deConfigSourcePath(absolutePath: string): string {
  const home = platformCanonicalAbsolutePath(betterC0deHomeDir())
  const canonicalAbsolutePath = platformCanonicalAbsolutePath(absolutePath)
  const relativeHome = path.relative(home, canonicalAbsolutePath)
  if (!relativeHome.startsWith("..") && !path.isAbsolute(relativeHome)) {
    return `~/${relativeHome.replace(/\\/g, "/")}`
  }
  return canonicalAbsolutePath
}

function formatBetterC0deDirectorySourcePath(
  workspaceRoot: string,
  absolutePath: string
): string {
  const canonicalWorkspaceRoot = platformCanonicalAbsolutePath(workspaceRoot)
  const canonicalAbsolutePath = platformCanonicalAbsolutePath(absolutePath)
  const relativeToWorkspace = path
    .relative(canonicalWorkspaceRoot, canonicalAbsolutePath)
    .replace(/\\/g, "/")
  if (
    relativeToWorkspace &&
    !relativeToWorkspace.startsWith("..") &&
    !path.isAbsolute(relativeToWorkspace)
  ) {
    return relativeToWorkspace
  }
  return formatBetterC0deConfigSourcePath(absolutePath)
}

export function formatBetterC0deDirectoryFileSourcePath(
  workspaceRoot: string,
  absolutePath: string
): string {
  const canonicalWorkspaceRoot = platformCanonicalAbsolutePath(workspaceRoot)
  const canonicalAbsolutePath = platformCanonicalAbsolutePath(absolutePath)
  const relativeToWorkspace = path
    .relative(canonicalWorkspaceRoot, canonicalAbsolutePath)
    .replace(/\\/g, "/")
  if (
    relativeToWorkspace &&
    !relativeToWorkspace.startsWith("..") &&
    !path.isAbsolute(relativeToWorkspace)
  ) {
    return relativeToWorkspace
  }
  return formatBetterC0deConfigSourcePath(absolutePath)
}

export function uniqueAbsolutePaths(paths: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of paths) {
    const normalized = platformCanonicalAbsolutePath(value)
    const key = platformAbsolutePathKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

export function platformCanonicalAbsolutePath(value: string): string {
  const resolved = path.resolve(value)
  // Windows and macOS file systems are case-insensitive by default, so the
  // candidates `betterc0de.jsonc` and `BetterC0de.jsonc` (or `.betterc0de/`
  // and `.BetterC0de/`) can be one entry. The native realpath returns its
  // single on-disk spelling, which both deduplicates and names it correctly;
  // a case-sensitive volume still yields two distinct paths.
  if (process.platform !== "win32" && process.platform !== "darwin")
    return resolved
  try {
    return fsSync.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export function platformAbsolutePathKey(value: string): string {
  const normalized = platformCanonicalAbsolutePath(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

async function substituteBetterC0deConfigVariables(
  workspaceRoot: string,
  sourcePath: string,
  content: string,
  options: {
    absoluteSourcePath?: string
    fileVariableScope?: "workspace" | "config-directory"
    allowEnvironmentVariables?: boolean
  } = {}
): Promise<string> {
  const withEnv = content.replace(/\{env:([^}]+)\}/g, (_token, varName) => {
    if (options.allowEnvironmentVariables === false) return ""
    const key = String(varName).trim()
    return key ? (process.env[key] ?? "") : ""
  })
  if (Buffer.byteLength(withEnv, "utf8") > PROJECT_CONFIG_MAX_EXPANDED_BYTES) {
    throw Object.assign(new Error("expanded project config is too large"), {
      code: "EFBIG",
    })
  }
  if (!withEnv.includes("{file:")) return withEnv

  const configDir = path.dirname(
    options.absoluteSourcePath ?? safeResolveInside(workspaceRoot, sourcePath)
  )
  let out = ""
  let cursor = 0
  let outputBytes = 0
  let replacementCount = 0

  const append = (value: string): void => {
    const nextBytes = Buffer.byteLength(value, "utf8")
    if (outputBytes + nextBytes > PROJECT_CONFIG_MAX_EXPANDED_BYTES) {
      throw Object.assign(new Error("expanded project config is too large"), {
        code: "EFBIG",
      })
    }
    out += value
    outputBytes += nextBytes
  }

  for (const match of withEnv.matchAll(/\{file:[^}]+\}/g)) {
    if (replacementCount >= PROJECT_FILE_VARIABLE_MAX_COUNT) break
    const token = match[0]
    const index = match.index ?? 0
    append(withEnv.slice(cursor, index))

    const lineStart = withEnv.lastIndexOf("\n", index - 1) + 1
    const prefix = withEnv.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      append(token)
      cursor = index + token.length
      continue
    }

    replacementCount += 1
    const replacement = await readBetterC0deConfigFileVariable(
      workspaceRoot,
      configDir,
      token,
      options.fileVariableScope ?? "workspace"
    )
    append(replacement ?? token)
    cursor = index + token.length
  }

  append(withEnv.slice(cursor))
  return out
}

async function readBetterC0deConfigFileVariable(
  workspaceRoot: string,
  configDir: string,
  token: string,
  scope: "workspace" | "config-directory"
): Promise<string | null> {
  const rawPath = token
    .replace(/^\{file:/, "")
    .replace(/\}$/, "")
    .trim()
  if (!rawPath || rawPath.startsWith("~/")) return null
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(configDir, rawPath)
  const allowedRoot =
    scope === "config-directory"
      ? path.resolve(configDir)
      : path.resolve(workspaceRoot)
  if (!isPathInside(allowedRoot, resolved)) return null

  try {
    const realAllowedRoot = await fs.realpath(allowedRoot)
    const realTarget = await fs.realpath(resolved)
    if (!isPathInside(realAllowedRoot, realTarget)) return null
    const read = await readBoundedUtf8File(
      realTarget,
      PROJECT_FILE_VARIABLE_MAX_BYTES
    )
    const targetAfterRead = await fs.realpath(resolved)
    if (
      targetAfterRead !== realTarget ||
      !isPathInside(realAllowedRoot, targetAfterRead)
    ) {
      return null
    }
    return JSON.stringify(read.text.trim()).slice(1, -1)
  } catch {
    return null
  }
}

export function readRecord(
  input: unknown,
  key: string
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const value = (input as Record<string, unknown>)[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function isPermissionAction(
  value: unknown
): value is "ask" | "allow" | "deny" {
  return value === "ask" || value === "allow" || value === "deny"
}

export function parseJsoncObject(input: string): unknown {
  try {
    return JSON.parse(stripJsonTrailingCommas(stripJsonComments(input)))
  } catch {
    return null
  }
}

function stripJsonComments(input: string): string {
  let out = ""
  let inString = false
  let quote = ""
  let escaped = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ""
    const next = input[i + 1] ?? ""

    if (inString) {
      out += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        inString = false
        quote = ""
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      out += char
      continue
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1
      out += "\n"
      continue
    }

    if (char === "/" && next === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") out += "\n"
        i += 1
      }
      i += 1
      continue
    }

    out += char
  }
  return out
}

function stripJsonTrailingCommas(input: string): string {
  let out = ""
  let inString = false
  let quote = ""
  let escaped = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? ""

    if (inString) {
      out += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        inString = false
        quote = ""
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      out += char
      continue
    }

    if (char === ",") {
      let cursor = i + 1
      while (/\s/.test(input[cursor] ?? "")) cursor += 1
      const next = input[cursor]
      if (next === "}" || next === "]") continue
    }

    out += char
  }
  return out
}

export function parseBooleanScalar(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

export function parseNumberScalar(value: string): number | undefined {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parsePositiveIntegerScalar(value: string): number | undefined {
  const parsed = parseNumberScalar(value)
  return parsed !== undefined && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : undefined
}
