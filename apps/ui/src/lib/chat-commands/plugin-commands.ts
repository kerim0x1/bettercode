import { stringifyCliArgs } from "@/lib/cli-parse"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { HttpError } from "@/lib/errors/types"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { readFile, writeFile } from "@/services/backend/workspaceApi"
import { formatDebugPathCell } from "./lsp-commands"
import { isBetterC0deRuntimeTerminalFlag } from "./mcp-commands"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  isProjectProviderSecretLike,
  parsePluginConfigObject,
  parsePluginInstallOptionValue,
  parsePluginToggleBoolean,
  serializeBetterC0deConfig,
  type ActiveThreadRef,
} from "./provider-config"
import { parsePluginBooleanFlagValue } from "./runtime-config"

export async function buildPluginInstallOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const request = parsePluginInstallArgs(args)
  const moduleName = request.moduleName
  const terminalCommand = buildBetterC0dePluginTerminalCommand(args)
  const validation = buildPluginInstallValidationMessages(args, request)
  const normalizedFlags = [
    request.global ? "--global" : "",
    request.force ? "--force" : "",
  ].filter(Boolean)
  const installArgs = [moduleName ?? "<module>", ...normalizedFlags]
  const command = `betterc0de plugin ${stringifyCliArgs(installArgs)}`
  const plugCommand = `betterc0de plug ${stringifyCliArgs(installArgs)}`

  if (
    runtimePath &&
    moduleName &&
    request.configOnly &&
    request.target &&
    !request.rejectedSecret &&
    validation.length === 0 &&
    !request.global &&
    !request.dryRun
  ) {
    return writeProjectPluginConfigFromChat({
      runtimePath,
      request: {
        ...request,
        moduleName,
        target: request.target,
      },
      command,
      plugCommand,
    })
  }

  return [
    "# BetterC0de Plugin Install",
    "",
    "Compatibility reference: `betterc0de plugin <module>` / `betterc0de plug <module>`.",
    "",
    `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
    "",
    "Opened **Settings > Plugins**.",
    "",
    moduleName
      ? [
          "## Requested Plugin",
          "",
          `Module: \`${escapeInlineCode(moduleName)}\``,
          `Scope: ${request.global ? "global BetterC0de compatibility config" : "workspace/project BetterC0de compatibility config"}`,
          `Replace existing entry: ${request.force ? "yes" : "no"}`,
          `Plugin options: ${formatPluginOptionKeys(request.options)}`,
          request.configOnly
            ? `Config-only target: ${
                request.target
                  ? formatPluginInstallConfigTargets(request)
                  : "missing `--target server|tui|both`"
              }`
            : "Config-only target: disabled",
          "",
          "```sh",
          command,
          "# alias:",
          plugCommand,
          "```",
        ].join("\n")
      : [
          "## Usage",
          "",
          "```sh",
          "betterc0de plugin <npm-module|local-path|repo-spec> [--global] [--force]",
          "betterc0de plug <npm-module|local-path|repo-spec> [--global] [--force]",
          "```",
          "",
          "Chat usage: `/plugin-install <module> [--global] [--force]`.",
          'Config-only usage: `/plugin-install <module> --config-only --target server|tui|both [--root-config] [--config \'{"key":"value"}\'] [--option key=value] [--force]`.',
        ].join("\n"),
    "",
    "the compatibility CLI's install flow resolves the module, reads the plugin manifest, then patches `.betterc0de/betterc0de.json` / `.betterc0de/tui.json` or the global BetterC0de compatibility config.",
    "",
    moduleName && request.configOnly && !runtimePath
      ? "> Open a workspace folder before using `--config-only`, so BetterC0de can write the project BetterC0de compatibility config."
      : "",
    moduleName && request.configOnly && request.global
      ? "> Global BetterC0de compatibility config writes are terminal-only. BetterC0de only writes workspace-local plugin config from chat."
      : "",
    moduleName && request.configOnly && !request.target
      ? "> Add `--target server` for `.betterc0de/betterc0de.json`, `--target tui` for `.betterc0de/tui.json`, or `--target both` when the plugin manifest exposes both entrypoints. BetterC0de normally learns this from the plugin manifest after install."
      : "",
    moduleName && request.configOnly && request.rejectedSecret
      ? "> Refusing to write plugin secrets into project config. Use environment variables, BetterC0de auth, or the plugin's documented secret store instead."
      : "",
    moduleName && isDeprecatedBetterC0dePluginPackage(moduleName)
      ? [
          "## Deprecated Package",
          "",
          `> \`${escapeInlineCode(moduleName)}\` is an old BetterC0de auth plugin package. BetterC0de now provides this auth flow natively, so keep it out of new project plugin config unless you intentionally need legacy behavior.`,
        ].join("\n")
      : "",
    validation.length > 0
      ? ["## Validation", "", ...validation.map((item) => `- ${item}`)].join(
          "\n"
        )
      : "",
    terminalCommand.shouldOpen && terminalCommand.command
      ? [
          "## Terminal",
          "",
          "```sh",
          terminalCommand.command,
          "```",
          "",
          "> Opened the terminal panel with this BetterC0de plugin command prefilled. BetterC0de-only flags such as `--config-only` and `--target` are not passed to the CLI.",
        ].join("\n")
      : "",
    "",
    "> BetterC0de does not silently run npm installs or execute arbitrary plugin code from chat. With `--config-only`, it only edits the project config `plugin` array; use the integrated terminal when you intentionally want the compatibility CLI to resolve/install the module and infer manifest targets.",
  ].join("\n")
}

type PluginInstallTarget = "server" | "tui" | "both"

interface PluginInstallRequest {
  moduleName?: string
  global: boolean
  force: boolean
  configOnly: boolean
  dryRun: boolean
  target?: PluginInstallTarget
  rootConfig: boolean
  options: Record<string, unknown>
  rejectedSecret: boolean
  validation: string[]
}

function parsePluginInstallArgs(
  args: ReadonlyArray<string>
): PluginInstallRequest {
  const request: PluginInstallRequest = {
    global: false,
    force: false,
    configOnly: false,
    dryRun: false,
    rootConfig: false,
    options: {},
    rejectedSecret: false,
    validation: [],
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextRequiredValue = (label: string) => {
      if (inlineValue !== undefined) {
        const value = inlineValue.trim()
        if (!value) request.validation.push(`${label} requires a value.`)
        return value
      }
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        request.validation.push(`${label} requires a value.`)
        return ""
      }
      index += 1
      return value.trim()
    }

    switch (key) {
      case "--global":
      case "-g":
        request.global = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--force":
      case "-f":
        request.force = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--config-only":
        request.configOnly = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--dry-run":
        request.dryRun = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--betterc0de-dir":
      case "--open-code-dir":
      case "--dot-betterc0de":
        request.rootConfig = false
        break
      case "--root-config":
      case "--project-root":
      case "--root":
        request.rootConfig = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--target": {
        const targetValue = nextRequiredValue("--target")
        const target = normalizePluginInstallTarget(targetValue)
        if (target) request.target = target
        else if (targetValue) {
          request.validation.push(
            "`--target` must be `server`, `tui`, or `both`."
          )
        }
        break
      }
      case "--config":
      case "--options": {
        const optionsValue = nextRequiredValue(key)
        if (!optionsValue) break
        const options = parsePluginInstallOptionsObject(optionsValue)
        if (options) {
          if (isPluginInstallSecretLike(options)) {
            request.rejectedSecret = true
          } else {
            request.options = { ...request.options, ...options }
          }
        } else {
          request.validation.push("`--config` must be a JSON object.")
        }
        break
      }
      case "--option":
      case "--set": {
        const optionValue = nextRequiredValue(key)
        if (!optionValue) break
        const option = parsePluginInstallOption(optionValue)
        if (option === "secret") {
          request.rejectedSecret = true
        } else if (option) {
          request.options[option.key] = option.value
        } else {
          request.validation.push(
            "`--option` must use `key=value` with an identifier-like key."
          )
        }
        break
      }
      case "--server":
        if (parsePluginBooleanFlagValue(key, inlineValue, request.validation)) {
          request.configOnly = true
          request.target = combinePluginInstallTarget(request.target, "server")
        }
        break
      case "--tui":
        if (parsePluginBooleanFlagValue(key, inlineValue, request.validation)) {
          request.configOnly = true
          request.target = combinePluginInstallTarget(request.target, "tui")
        }
        break
      default:
        if (!arg.startsWith("-") && !request.moduleName) {
          request.moduleName = arg.trim()
        }
        break
    }
  }

  return request
}

function buildPluginInstallValidationMessages(
  args: ReadonlyArray<string>,
  request: PluginInstallRequest
): string[] {
  const validation = [...request.validation]
  const hasOperationFlag = args.some((arg) => arg.startsWith("-"))
  if (!request.moduleName && hasOperationFlag) {
    validation.push("BetterC0de plugin install requires a module.")
  }
  return validation
}

function isDeprecatedBetterC0dePluginPackage(spec: string): boolean {
  return [
    "betterc0de-openai-codex-auth",
    "betterc0de-copilot-auth",
    "betterc0de-openai-codex-auth",
    "betterc0de-copilot-auth",
  ].some((pkg) => spec.includes(pkg))
}

function parsePluginInstallOptionsObject(
  value: string
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

function parsePluginInstallOption(
  value: string
): { key: string; value: unknown } | "secret" | undefined {
  const separator = value.indexOf("=")
  if (separator <= 0) return undefined
  const key = value.slice(0, separator).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return undefined
  const parsed = parsePluginInstallOptionValue(
    value.slice(separator + 1).trim()
  )
  if (isPluginInstallSecretLike({ [key]: parsed })) return "secret"
  return {
    key,
    value: parsed,
  }
}

function isPluginInstallSecretLike(value: unknown): boolean {
  return isProjectProviderSecretLike("plugin", value)
}

function formatPluginOptionKeys(options: Record<string, unknown>): string {
  const keys = Object.keys(options).sort()
  return keys.length > 0 ? keys.map((key) => `\`${key}\``).join(", ") : "none"
}

function normalizePluginInstallTarget(
  value: string
): PluginInstallTarget | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "server" || normalized === "betterc0de") return "server"
  if (normalized === "tui" || normalized === "terminal") return "tui"
  if (normalized === "both" || normalized === "all") return "both"
  return undefined
}

function combinePluginInstallTarget(
  current: PluginInstallTarget | undefined,
  next: Exclude<PluginInstallTarget, "both">
): PluginInstallTarget {
  if (!current || current === next) return next
  return "both"
}

export function buildBetterC0dePluginTerminalCommand(
  args: ReadonlyArray<string>
): {
  command: string
  shouldOpen: boolean
} {
  const request = parsePluginInstallArgs(args)
  const flags = [
    request.global ? "--global" : "",
    request.force ? "--force" : "",
  ].filter(Boolean)
  const shouldOpen =
    args.some(isBetterC0deRuntimeTerminalFlag) &&
    !request.configOnly &&
    Boolean(request.moduleName)
  return {
    command: `betterc0de plugin ${stringifyCliArgs([
      request.moduleName ?? "",
      ...flags,
    ])}`,
    shouldOpen,
  }
}

async function writeProjectPluginConfigFromChat(input: {
  runtimePath: string
  request: PluginInstallRequest & {
    moduleName: string
    target: PluginInstallTarget
  }
  command: string
  plugCommand: string
}): Promise<string> {
  const results: ProjectPluginConfigWriteSuccess[] = []
  for (const configPath of pluginInstallConfigPaths(input.request)) {
    const result = await writeProjectPluginConfigFileFromChat({
      ...input,
      configPath,
    })
    if ("errorOutput" in result) return result.errorOutput
    results.push(result)
  }

  const targetLabel = formatPluginInstallConfigTargets(input.request)
  const createdAll = results.every((result) => !result.existed)
  const updatedAll = results.every((result) => result.existed)
  return [
    "# BetterC0de Plugin Install",
    "",
    updatedAll
      ? "Updated the workspace BetterC0de plugin config."
      : createdAll
        ? "Created the workspace BetterC0de plugin config."
        : "Updated the workspace BetterC0de plugin config.",
    "",
    `${results.length === 1 ? "Target" : "Targets"}: ${targetLabel}`,
    `Module: \`${escapeInlineCode(input.request.moduleName)}\``,
    `Options: ${formatPluginOptionKeys(input.request.options)}`,
    `Replace existing entry: ${input.request.force ? "yes" : "no"}`,
    "",
    "## Equivalent CLI",
    "",
    "```sh",
    input.command,
    "# alias:",
    input.plugCommand,
    "```",
    "",
    "> Config-only mode updated only the `plugin` array. It did not install npm packages, read plugin manifests, or execute plugin code.",
  ].join("\n")
}

type ProjectPluginConfigWriteSuccess = { configPath: string; existed: boolean }

type ProjectPluginConfigWriteResult =
  | ProjectPluginConfigWriteSuccess
  | { errorOutput: string }

async function writeProjectPluginConfigFileFromChat(input: {
  runtimePath: string
  request: PluginInstallRequest & {
    moduleName: string
    target: PluginInstallTarget
  }
  configPath: string
}): Promise<ProjectPluginConfigWriteResult> {
  const configPath = input.configPath
  const absoluteConfigPath = resolveWorkspaceFilePath(
    input.runtimePath,
    configPath
  )
  let config: Record<string, unknown> = {}
  let existed = false

  try {
    const file = await readFile(absoluteConfigPath, { silent404: true })
    existed = true
    config = parsePluginConfigObject(file.content, configPath)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      config = {}
    } else {
      return {
        errorOutput: [
          "# BetterC0de Plugin Install",
          "",
          "> Could not read the project BetterC0de compatibility config.",
          "",
          `Target: \`${escapeInlineCode(configPath)}\``,
          `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
        ].join("\n"),
      }
    }
  }

  const pluginValue = config.plugin
  if (pluginValue !== undefined && !Array.isArray(pluginValue)) {
    return {
      errorOutput: [
        "# BetterC0de Plugin Install",
        "",
        "> Could not update the project BetterC0de plugin config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        "Error: `plugin` must be an array to append a config-only plugin entry.",
      ].join("\n"),
    }
  }

  const existingPlugins = Array.isArray(pluginValue) ? [...pluginValue] : []
  const matchingIndexes = existingPlugins
    .map((entry, index) =>
      pluginEntriesMatchForInstall(entry, input.request.moduleName) ? index : -1
    )
    .filter((index) => index >= 0)
  if (matchingIndexes.length > 0 && !input.request.force) {
    return {
      errorOutput: [
        "# BetterC0de Plugin Install",
        "",
        "> Plugin config entry already exists.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Module: \`${escapeInlineCode(input.request.moduleName)}\``,
        "",
        "Use `--force` to replace existing entries intentionally.",
      ].join("\n"),
    }
  }

  const nextPlugins = input.request.force
    ? existingPlugins.filter(
        (entry) =>
          !pluginEntriesMatchForInstall(entry, input.request.moduleName)
      )
    : existingPlugins
  const nextEntry =
    Object.keys(input.request.options).length > 0
      ? [input.request.moduleName, input.request.options]
      : input.request.moduleName
  nextPlugins.push(nextEntry)
  config.plugin = nextPlugins

  try {
    await writeFile(
      input.runtimePath,
      configPath,
      serializeBetterC0deConfig(config)
    )
  } catch (error) {
    return {
      errorOutput: [
        "# BetterC0de Plugin Install",
        "",
        "> Could not write the project BetterC0de compatibility config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n"),
    }
  }

  return { configPath, existed }
}

function pluginInstallConfigPath(
  request: Pick<PluginInstallRequest, "rootConfig" | "target">
): string {
  const fileName = request.target === "tui" ? "tui.json" : "betterc0de.json"
  return request.rootConfig ? fileName : `.betterc0de/${fileName}`
}

function pluginInstallConfigPaths(
  request: Pick<PluginInstallRequest, "rootConfig" | "target">
): string[] {
  const targets =
    request.target === "both" ? (["server", "tui"] as const) : [request.target]
  return targets
    .filter((target): target is Exclude<PluginInstallTarget, "both"> =>
      Boolean(target)
    )
    .map((target) => pluginInstallConfigPath({ ...request, target }))
}

function formatPluginInstallConfigTargets(
  request: Pick<PluginInstallRequest, "rootConfig" | "target">
): string {
  return pluginInstallConfigPaths(request)
    .map((path) => `\`${escapeInlineCode(path)}\``)
    .join(", ")
}

function pluginEntrySpec(entry: unknown): string | null {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return null
}

function pluginEntriesMatchForInstall(
  entry: unknown,
  requested: string
): boolean {
  const existing = pluginEntrySpec(entry)
  if (!existing) return false
  if (existing === requested) return true
  const existingIdentity = pluginInstallIdentity(existing)
  const requestedIdentity = pluginInstallIdentity(requested)
  return (
    existingIdentity.kind === "npm" &&
    requestedIdentity.kind === "npm" &&
    existingIdentity.value === requestedIdentity.value
  )
}

function pluginInstallIdentity(spec: string): {
  kind: "file" | "npm" | "raw"
  value: string
} {
  const trimmed = spec.trim()
  if (isPathPluginInstallSpec(trimmed)) {
    return { kind: "file", value: trimmed }
  }
  const aliased = npmAliasTarget(trimmed)
  const npmPackage = parseNpmPackageName(aliased)
  return npmPackage
    ? { kind: "npm", value: npmPackage }
    : { kind: "raw", value: trimmed }
}

function isPathPluginInstallSpec(spec: string): boolean {
  return (
    spec.startsWith("file://") ||
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(spec)
  )
}

function npmAliasTarget(spec: string): string {
  const marker = "@npm:"
  const index = spec.indexOf(marker)
  return index >= 0 ? spec.slice(index + marker.length) : spec
}

function parseNpmPackageName(spec: string): string | null {
  if (
    /^(?:git\+)?(?:https?|ssh):\/\//i.test(spec) ||
    /^git@[^:\s]+:/i.test(spec)
  ) {
    return null
  }
  if (spec.startsWith("@")) {
    const match = /^(@[^/\s]+\/[^@\s/]+)(?:@.*)?$/.exec(spec)
    return match?.[1] ?? null
  }
  if (spec.includes("/") || spec.includes(":")) return null
  const match = /^([^@\s]+)(?:@.*)?$/.exec(spec)
  return match?.[1] ?? null
}

interface PluginToggleRequest {
  pluginId?: string
  enabled?: boolean
  configOnly: boolean
  dryRun: boolean
  rootConfig: boolean
  validation: string[]
}

export async function buildPluginToggleOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const request = parsePluginToggleArgs(args)
  const usage = [
    "# BetterC0de Plugin Toggle",
    "",
    "Compatibility reference: `plugins.toggle` in the TUI plugin dialog.",
    "",
    `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
    "",
    "Usage: `/plugin-toggle <plugin-id> --enabled true|false --config-only [--root-config]`.",
    "",
    "> BetterC0de writes persistent project TUI state to `.betterc0de/tui.json#plugin_enabled` only when `--config-only` is present.",
  ].join("\n")

  const validation =
    request.validation.length > 0
      ? [
          "## Validation",
          "",
          ...request.validation.map((item) => `- ${item}`),
        ].join("\n")
      : ""

  if (
    !request.pluginId ||
    request.enabled === undefined ||
    request.validation.length > 0
  ) {
    return [usage, validation].filter(Boolean).join("\n\n")
  }

  if (!request.configOnly) {
    return [
      "# BetterC0de Plugin Toggle",
      "",
      "Compatibility reference: `plugins.toggle` in the TUI plugin dialog.",
      "",
      `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
      "",
      `Plugin: \`${escapeInlineCode(request.pluginId)}\``,
      `Requested state: \`${String(request.enabled)}\``,
      "",
      "> Add `--config-only` to persist this state in `.betterc0de/tui.json`. Runtime-only BetterC0de terminal UI KV toggles are delegated to the BetterC0de compatibility runtime.",
    ].join("\n")
  }

  if (!runtimePath) {
    return [
      "# BetterC0de Plugin Toggle",
      "",
      "> Open a workspace folder before using `--config-only`.",
      "",
      `Plugin: \`${escapeInlineCode(request.pluginId)}\``,
      `Requested state: \`${String(request.enabled)}\``,
    ].join("\n")
  }

  if (request.dryRun) {
    return [
      "# BetterC0de Plugin Toggle",
      "",
      "Dry run only. No files were changed.",
      "",
      `Target: \`${escapeInlineCode(pluginToggleConfigPath(request))}#plugin_enabled.${escapeInlineCode(request.pluginId)}\``,
      `Requested state: \`${String(request.enabled)}\``,
    ].join("\n")
  }

  return writeProjectPluginEnabledConfig({
    runtimePath,
    pluginId: request.pluginId,
    enabled: request.enabled,
    rootConfig: request.rootConfig,
  })
}

function parsePluginToggleArgs(
  args: ReadonlyArray<string>
): PluginToggleRequest {
  const request: PluginToggleRequest = {
    configOnly: false,
    dryRun: false,
    rootConfig: false,
    validation: [],
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextRequiredValue = (label: string) => {
      if (inlineValue !== undefined) {
        const value = inlineValue.trim()
        if (!value) request.validation.push(`${label} requires a value.`)
        return value
      }
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        request.validation.push(`${label} requires a value.`)
        return ""
      }
      index += 1
      return value.trim()
    }

    switch (key) {
      case "--enabled":
      case "--state": {
        const enabledValue = nextRequiredValue(key)
        const enabled = parsePluginToggleBoolean(enabledValue)
        if (enabled !== undefined) request.enabled = enabled
        else if (enabledValue) {
          request.validation.push(`\`${key}\` must be true or false.`)
        }
        break
      }
      case "--enable":
      case "--on":
        request.enabled = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--disable":
      case "--disabled":
      case "--off":
        request.enabled = !parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--config-only":
        request.configOnly = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--dry-run":
        request.dryRun = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--betterc0de-dir":
      case "--open-code-dir":
      case "--dot-betterc0de":
        request.rootConfig = false
        break
      case "--root-config":
      case "--project-root":
      case "--root":
        request.rootConfig = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      default: {
        const booleanValue = parsePluginToggleBoolean(arg)
        if (booleanValue !== undefined && request.enabled === undefined) {
          request.enabled = booleanValue
        } else if (!arg.startsWith("-") && !request.pluginId) {
          request.pluginId = arg.trim()
        }
        break
      }
    }
  }

  return request
}

async function writeProjectPluginEnabledConfig(input: {
  runtimePath: string
  pluginId: string
  enabled: boolean
  rootConfig: boolean
}): Promise<string> {
  const configPath = pluginToggleConfigPath(input)
  const absoluteConfigPath = resolveWorkspaceFilePath(
    input.runtimePath,
    configPath
  )
  let config: Record<string, unknown> = {}
  let existed = false

  try {
    const file = await readFile(absoluteConfigPath, { silent404: true })
    existed = true
    config = parsePluginConfigObject(file.content, configPath)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      config = {}
    } else {
      return [
        "# BetterC0de Plugin Toggle",
        "",
        "> Could not read the project TUI config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n")
    }
  }

  const existingValue = config.plugin_enabled
  if (
    existingValue !== undefined &&
    (!existingValue ||
      typeof existingValue !== "object" ||
      Array.isArray(existingValue))
  ) {
    return [
      "# BetterC0de Plugin Toggle",
      "",
      "> Could not update the project TUI plugin state.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      "Error: `plugin_enabled` must be an object map of plugin IDs to booleans.",
    ].join("\n")
  }

  const pluginEnabled =
    existingValue &&
    typeof existingValue === "object" &&
    !Array.isArray(existingValue)
      ? Object.fromEntries(
          Object.entries(existingValue).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
          )
        )
      : {}

  if (pluginEnabled[input.pluginId] === input.enabled) {
    return [
      "# BetterC0de Plugin Toggle",
      "",
      "> Project TUI plugin state is already set.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Plugin: \`${escapeInlineCode(input.pluginId)}\``,
      `State: \`${String(input.enabled)}\``,
    ].join("\n")
  }

  config.plugin_enabled = {
    ...pluginEnabled,
    [input.pluginId]: input.enabled,
  }

  try {
    await writeFile(
      input.runtimePath,
      configPath,
      `${JSON.stringify(config, null, 2)}\n`
    )
  } catch (error) {
    return [
      "# BetterC0de Plugin Toggle",
      "",
      "> Could not write the project TUI config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# BetterC0de Plugin Toggle",
    "",
    existed
      ? "Updated the workspace BetterC0de terminal UI plugin state."
      : "Created the workspace BetterC0de terminal UI plugin state.",
    "",
    `Target: \`${escapeInlineCode(configPath)}\``,
    `Plugin: \`${escapeInlineCode(input.pluginId)}\``,
    `State: \`${String(input.enabled)}\``,
    "",
    "> Config-only mode updated only `plugin_enabled`. It did not execute plugin code or change BetterC0de compatibility runtime KV state.",
  ].join("\n")
}

function pluginToggleConfigPath(
  request: Pick<PluginToggleRequest, "rootConfig">
): string {
  return request.rootConfig ? "tui.json" : ".betterc0de/tui.json"
}
