import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { HttpError } from "@/lib/errors/types"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  listProjectConfigSettings,
  readFile,
  writeFile,
  type WorkspaceProjectConfigSetting,
} from "@/services/backend/workspaceApi"
import { formatListPlain } from "./input-context"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  parseBetterC0deRuntimeList,
  parsePluginConfigObject,
  parsePluginToggleBoolean,
  serializeBetterC0deConfig,
  type ActiveThreadRef,
} from "./provider-config"

export function formatProjectConfigValidationOutput(
  title: string,
  validation: ReadonlyArray<string>
): string {
  return [
    `# ${title}`,
    "",
    "## Validation",
    "",
    ...validation.map((item) => `- ${item}`),
  ].join("\n")
}

export function isBetterC0deAttachmentConfigKey(key: string): boolean {
  return key === "attachment" || key.startsWith("attachment.")
}

export function isBetterC0deToolOutputConfigKey(key: string): boolean {
  return key === "tool_output" || key.startsWith("tool_output.")
}

export function isBetterC0deCompactionConfigKey(key: string): boolean {
  return key === "compaction" || key.startsWith("compaction.")
}

export function isBetterC0deRuntimeConfigKey(key: string): boolean {
  return (
    isBetterC0deAttachmentConfigKey(key) ||
    isBetterC0deToolOutputConfigKey(key) ||
    isBetterC0deCompactionConfigKey(key) ||
    key === "shell" ||
    key === "logLevel" ||
    key === "server" ||
    key.startsWith("server.") ||
    key === "watcher" ||
    key.startsWith("watcher.") ||
    key === "snapshot" ||
    key === "share" ||
    key === "autoshare" ||
    key === "autoupdate" ||
    key === "default_agent" ||
    key === "username" ||
    key === "layout" ||
    key === "enterprise" ||
    key.startsWith("enterprise.") ||
    key === "runtime" ||
    key.startsWith("runtime.") ||
    key === "experimental" ||
    key.startsWith("experimental.")
  )
}

interface BetterC0deRuntimeConfigRequest {
  shell?: string
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR"
  server: Record<string, unknown>
  watcherIgnore: string[]
  attachmentImage: Record<string, unknown>
  toolOutput: Record<string, unknown>
  compaction: Record<string, unknown>
  experimental: Record<string, unknown>
  snapshot?: boolean
  share?: "manual" | "auto" | "disabled"
  autoshare?: boolean
  autoupdate?: boolean | "notify"
  defaultAgent?: string
  username?: string
  layout?: "auto" | "stretch"
  enterpriseUrl?: string
  dryRun: boolean
  validation: string[]
}

export async function buildBetterC0deRuntimeConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const request = parseBetterC0deRuntimeConfigArgs(args)
  if (request.validation.length > 0) {
    return formatProjectConfigValidationOutput(
      "BetterC0de Runtime Config",
      request.validation
    )
  }
  if (!runtimePath) {
    return "# BetterC0de Runtime Config\n\n> Open a workspace folder before using `--config-only`."
  }
  if (!hasBetterC0deRuntimeConfigMutation(request)) {
    const settings = await readBetterC0deRuntimeSettings(runtimePath)
    return [
      "# BetterC0de Runtime Config",
      "",
      ...formatBetterC0deRuntimeSettingsBlock(settings),
      "",
      "> Usage: `/betterc0de-runtime --config-only --port 4096 --hostname 127.0.0.1 --mdns false --mdns-domain betterc0de.local --cors https://app.example.com --share manual --autoupdate notify --default-agent build`",
      "> Runtime limits: `/attachments --config-only --auto-resize true --max-width 2000 --max-height 2000 --max-base64-bytes 5242880`, `/tool-output --config-only --max-lines 2000 --max-bytes 51200`, `/compaction --config-only --auto true --prune true --tail-turns 2 --mcp-timeout 10000`",
      "",
      "This writes BetterC0de runtime/app metadata without starting external servers or update flows.",
    ].join("\n")
  }
  if (request.dryRun) {
    return [
      "# BetterC0de Runtime Config",
      "",
      "Dry run only. No files were changed.",
      "",
      `Settings: ${escapeMarkdownTableCell(formatListPlain(betterC0deRuntimeConfigKeys(request)))}`,
    ].join("\n")
  }

  const configPath = "betterc0de.json"
  const absoluteConfigPath = resolveWorkspaceFilePath(runtimePath, configPath)
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
        "# BetterC0de Runtime Config",
        "",
        "> Could not read the project BetterC0de config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n")
    }
  }

  applyBetterC0deRuntimeConfig(config, request)

  try {
    await writeFile(runtimePath, configPath, serializeBetterC0deConfig(config))
  } catch (error) {
    return [
      "# BetterC0de Runtime Config",
      "",
      "> Could not write the project BetterC0de config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# BetterC0de Runtime Config",
    "",
    existed
      ? "Updated the workspace BetterC0de runtime config."
      : "Created the workspace BetterC0de runtime config.",
    "",
    `Target: \`${escapeInlineCode(configPath)}\``,
    `Settings: ${escapeMarkdownTableCell(formatListPlain(betterC0deRuntimeConfigKeys(request)))}`,
    "",
    "> Config-only mode did not start external servers, expose ports, run update checks, or change BetterC0de's own app lifecycle.",
  ].join("\n")
}

function parseBetterC0deRuntimeConfigArgs(
  args: ReadonlyArray<string>
): BetterC0deRuntimeConfigRequest {
  const request: BetterC0deRuntimeConfigRequest = {
    server: {},
    watcherIgnore: [],
    attachmentImage: {},
    toolOutput: {},
    compaction: {},
    experimental: {},
    dryRun: false,
    validation: [],
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextValue = (label = key) => {
      if (inlineValue !== undefined) {
        const value = inlineValue.trim()
        if (!value) request.validation.push(`${label} requires a value.`)
        return inlineValue
      }
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        request.validation.push(`${label} requires a value.`)
        return ""
      }
      index += 1
      return value
    }
    const nextOptionalValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = args[index + 1]
      if (!value || value.startsWith("-")) return undefined
      index += 1
      return value
    }

    switch (key) {
      case "--config-only":
        break
      case "--dry-run":
        request.dryRun = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--shell":
        request.shell = nextValue("--shell").trim()
        break
      case "--log-level": {
        const raw = nextValue("--log-level")
        const level = parseBetterC0deLogLevel(raw)
        if (level) request.logLevel = level
        else if (raw.trim()) {
          request.validation.push(
            "`--log-level` must be `DEBUG`, `INFO`, `WARN`, or `ERROR`."
          )
        }
        break
      }
      case "--server-port": {
        const value = parseBetterC0deRuntimePositiveIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined) request.server.port = value
        break
      }
      case "--port": {
        const value = parseBetterC0deRuntimePositiveIntegerOption(
          nextValue("--port"),
          "--port",
          request.validation
        )
        if (value !== undefined) request.server.port = value
        break
      }
      case "--server-hostname":
      case "--hostname":
        request.server.hostname = nextValue(key).trim()
        break
      case "--server-mdns":
      case "--mdns": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) request.server.mdns = value
        break
      }
      case "--server-mdns-domain":
      case "--mdns-domain":
        request.server.mdnsDomain = nextValue(key).trim()
        break
      case "--server-cors":
      case "--cors": {
        const existingCors = Array.isArray(request.server.cors)
          ? request.server.cors.filter(
              (entry): entry is string => typeof entry === "string"
            )
          : []
        request.server.cors = [
          ...existingCors,
          ...parseBetterC0deRuntimeList(nextValue(key)),
        ]
        break
      }
      case "--auto-resize":
      case "--image-auto-resize": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) request.attachmentImage.auto_resize = value
        break
      }
      case "--max-width":
      case "--image-max-width": {
        const value = parseBetterC0deRuntimePositiveIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined) request.attachmentImage.max_width = value
        break
      }
      case "--max-height":
      case "--image-max-height": {
        const value = parseBetterC0deRuntimePositiveIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined) request.attachmentImage.max_height = value
        break
      }
      case "--max-base64-bytes":
      case "--image-max-base64-bytes": {
        const value = parseBetterC0deRuntimePositiveIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined)
          request.attachmentImage.max_base64_bytes = value
        break
      }
      case "--max-lines":
      case "--tool-output-max-lines": {
        const value = parseBetterC0deRuntimePositiveIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined) request.toolOutput.max_lines = value
        break
      }
      case "--max-bytes":
      case "--tool-output-max-bytes": {
        const value = parseBetterC0deRuntimePositiveIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined) request.toolOutput.max_bytes = value
        break
      }
      case "--auto":
      case "--compaction-auto": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) request.compaction.auto = value
        break
      }
      case "--prune":
      case "--compaction-prune": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) request.compaction.prune = value
        break
      }
      case "--tail-turns":
      case "--compaction-tail-turns": {
        const value = parseBetterC0deRuntimeNonNegativeIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined) request.compaction.tail_turns = value
        break
      }
      case "--preserve-recent-tokens":
      case "--compaction-preserve-recent-tokens": {
        const value = parseBetterC0deRuntimeNonNegativeIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined) {
          request.compaction.preserve_recent_tokens = value
        }
        break
      }
      case "--reserved":
      case "--compaction-reserved": {
        const value = parseBetterC0deRuntimeNonNegativeIntegerOption(
          nextValue(key),
          key,
          request.validation
        )
        if (value !== undefined) request.compaction.reserved = value
        break
      }
      case "--disable-paste-summary": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) {
          request.experimental.disable_paste_summary = value
        }
        break
      }
      case "--paste-summary": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) {
          request.experimental.disable_paste_summary = !value
        }
        break
      }
      case "--batch-tool": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) request.experimental.batch_tool = value
        break
      }
      case "--open-telemetry":
      case "--opentelemetry": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) request.experimental.openTelemetry = value
        break
      }
      case "--primary-tools":
        request.experimental.primary_tools = parseBetterC0deRuntimeList(
          nextValue("--primary-tools")
        )
        break
      case "--continue-loop-on-deny": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) {
          request.experimental.continue_loop_on_deny = value
        }
        break
      }
      case "--mcp-timeout": {
        const value = parseBetterC0deRuntimePositiveIntegerOption(
          nextValue("--mcp-timeout"),
          "--mcp-timeout",
          request.validation
        )
        if (value !== undefined) request.experimental.mcp_timeout = value
        break
      }
      case "--watcher-ignore":
      case "--ignore":
        request.watcherIgnore.push(
          ...parseBetterC0deRuntimeList(nextValue(key))
        )
        break
      case "--snapshot": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          key,
          request.validation
        )
        if (value !== undefined) request.snapshot = value
        break
      }
      case "--no-snapshot":
        request.snapshot = false
        break
      case "--share": {
        const raw = nextValue("--share")
        const share = parseBetterC0deShareSetting(raw)
        if (share) request.share = share
        else if (raw.trim()) {
          request.validation.push(
            "`--share` must be `manual`, `auto`, or `disabled`."
          )
        }
        break
      }
      case "--autoshare": {
        const value = parseBetterC0deRuntimeBooleanOption(
          nextOptionalValue() ?? "true",
          "--autoshare",
          request.validation
        )
        if (value !== undefined) request.autoshare = value
        break
      }
      case "--autoupdate": {
        const raw = nextOptionalValue() ?? "true"
        const value = parseBetterC0deAutoupdateSetting(raw)
        if (value !== undefined) request.autoupdate = value
        else {
          request.validation.push(
            "`--autoupdate` must be true, false, or `notify`."
          )
        }
        break
      }
      case "--default-agent":
        request.defaultAgent = nextValue("--default-agent").trim()
        break
      case "--username":
        request.username = nextValue("--username").trim()
        break
      case "--layout": {
        const raw = nextValue("--layout")
        const layout = parseBetterC0deLayoutSetting(raw)
        if (layout) request.layout = layout
        else if (raw.trim()) {
          request.validation.push("`--layout` must be `auto` or `stretch`.")
        }
        break
      }
      case "--enterprise-url":
        request.enterpriseUrl = nextValue("--enterprise-url").trim()
        break
      default:
        break
    }
  }

  request.watcherIgnore = Array.from(new Set(request.watcherIgnore))
  return request
}

async function readBetterC0deRuntimeSettings(
  runtimePath: string
): Promise<WorkspaceProjectConfigSetting[] | null> {
  try {
    const settings = await listProjectConfigSettings(runtimePath)
    return settings.filter((setting) =>
      isBetterC0deRuntimeConfigKey(setting.key)
    )
  } catch {
    return null
  }
}

function formatBetterC0deRuntimeSettingsBlock(
  settings: ReadonlyArray<WorkspaceProjectConfigSetting> | null
): string[] {
  if (settings === null) {
    return [
      "## Current Runtime Settings",
      "",
      "> Could not load workspace BetterC0de compatibility runtime settings.",
    ]
  }
  if (settings.length === 0) {
    return [
      "## Current Runtime Settings",
      "",
      "> No BetterC0de compatibility runtime/app settings found yet.",
    ]
  }
  return [
    "## Current Runtime Settings",
    "",
    "| Setting | Key | Value | Source |",
    "|:--------|:----|:------|:-------|",
    ...settings.map(
      (setting) =>
        `| ${escapeMarkdownTableCell(setting.label)} | \`${escapeMarkdownTableCell(setting.key)}\` | ${escapeMarkdownTableCell(setting.value)} | \`${escapeMarkdownTableCell(setting.sourcePath)}\` |`
    ),
  ]
}

function applyBetterC0deRuntimeConfig(
  config: Record<string, unknown>,
  request: BetterC0deRuntimeConfigRequest
): void {
  if (request.shell) config.shell = request.shell
  if (request.logLevel) config.logLevel = request.logLevel
  if (Object.keys(request.server).length > 0) {
    const existing =
      config.server &&
      typeof config.server === "object" &&
      !Array.isArray(config.server)
        ? (config.server as Record<string, unknown>)
        : {}
    config.server = { ...existing, ...request.server }
  }
  if (Object.keys(request.attachmentImage).length > 0) {
    const existingAttachment =
      config.attachment &&
      typeof config.attachment === "object" &&
      !Array.isArray(config.attachment)
        ? (config.attachment as Record<string, unknown>)
        : {}
    const existingImage =
      existingAttachment.image &&
      typeof existingAttachment.image === "object" &&
      !Array.isArray(existingAttachment.image)
        ? (existingAttachment.image as Record<string, unknown>)
        : {}
    config.attachment = {
      ...existingAttachment,
      image: { ...existingImage, ...request.attachmentImage },
    }
  }
  if (Object.keys(request.toolOutput).length > 0) {
    const existing =
      config.tool_output &&
      typeof config.tool_output === "object" &&
      !Array.isArray(config.tool_output)
        ? (config.tool_output as Record<string, unknown>)
        : {}
    config.tool_output = { ...existing, ...request.toolOutput }
  }
  if (Object.keys(request.compaction).length > 0) {
    const existing =
      config.compaction &&
      typeof config.compaction === "object" &&
      !Array.isArray(config.compaction)
        ? (config.compaction as Record<string, unknown>)
        : {}
    config.compaction = { ...existing, ...request.compaction }
  }
  if (Object.keys(request.experimental).length > 0) {
    const existing =
      config.experimental &&
      typeof config.experimental === "object" &&
      !Array.isArray(config.experimental)
        ? (config.experimental as Record<string, unknown>)
        : {}
    config.experimental = { ...existing, ...request.experimental }
  }
  if (request.watcherIgnore.length > 0) {
    const existing =
      config.watcher &&
      typeof config.watcher === "object" &&
      !Array.isArray(config.watcher)
        ? (config.watcher as Record<string, unknown>)
        : {}
    config.watcher = { ...existing, ignore: request.watcherIgnore }
  }
  if (request.snapshot !== undefined) config.snapshot = request.snapshot
  if (request.share) config.share = request.share
  if (request.autoshare !== undefined) config.autoshare = request.autoshare
  if (request.autoupdate !== undefined) config.autoupdate = request.autoupdate
  if (request.defaultAgent) config.default_agent = request.defaultAgent
  if (request.username) config.username = request.username
  if (request.layout) config.layout = request.layout
  if (request.enterpriseUrl) {
    const existing =
      config.enterprise &&
      typeof config.enterprise === "object" &&
      !Array.isArray(config.enterprise)
        ? (config.enterprise as Record<string, unknown>)
        : {}
    config.enterprise = { ...existing, url: request.enterpriseUrl }
  }
}

function hasBetterC0deRuntimeConfigMutation(
  request: BetterC0deRuntimeConfigRequest
): boolean {
  return betterC0deRuntimeConfigKeys(request).length > 0
}

function betterC0deRuntimeConfigKeys(
  request: BetterC0deRuntimeConfigRequest
): string[] {
  return [
    request.shell ? "shell" : "",
    request.logLevel ? "logLevel" : "",
    Object.keys(request.server).length > 0 ? "server" : "",
    Object.keys(request.attachmentImage).length > 0 ? "attachment.image" : "",
    Object.keys(request.toolOutput).length > 0 ? "tool_output" : "",
    Object.keys(request.compaction).length > 0 ? "compaction" : "",
    Object.keys(request.experimental).length > 0 ? "experimental" : "",
    request.watcherIgnore.length > 0 ? "watcher.ignore" : "",
    request.snapshot !== undefined ? "snapshot" : "",
    request.share ? "share" : "",
    request.autoshare !== undefined ? "autoshare" : "",
    request.autoupdate !== undefined ? "autoupdate" : "",
    request.defaultAgent ? "default_agent" : "",
    request.username ? "username" : "",
    request.layout ? "layout" : "",
    request.enterpriseUrl ? "enterprise.url" : "",
  ].filter(Boolean)
}

function parseBetterC0deLogLevel(
  value: string
): BetterC0deRuntimeConfigRequest["logLevel"] | undefined {
  const normalized = value.trim().toUpperCase()
  return ["DEBUG", "INFO", "WARN", "ERROR"].includes(normalized)
    ? (normalized as BetterC0deRuntimeConfigRequest["logLevel"])
    : undefined
}

export function parseBetterC0dePositiveInteger(
  value: string
): number | undefined {
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseBetterC0deNonNegativeInteger(value: string): number | undefined {
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function parseBetterC0deRuntimePositiveIntegerOption(
  value: string,
  label: string,
  validation: string[]
): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = parseBetterC0dePositiveInteger(trimmed)
  if (parsed !== undefined) return parsed
  validation.push(`\`${label}\` must be a positive integer.`)
  return undefined
}

function parseBetterC0deRuntimeNonNegativeIntegerOption(
  value: string,
  label: string,
  validation: string[]
): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = parseBetterC0deNonNegativeInteger(trimmed)
  if (parsed !== undefined) return parsed
  validation.push(`\`${label}\` must be a non-negative integer.`)
  return undefined
}

function parseBetterC0deRuntimeBooleanOption(
  value: string,
  label: string,
  validation: string[]
): boolean | undefined {
  const parsed = parsePluginToggleBoolean(value)
  if (typeof parsed === "boolean") return parsed
  validation.push(`\`${label}\` must be true or false.`)
  return undefined
}

function parseBetterC0deShareSetting(
  value: string
): BetterC0deRuntimeConfigRequest["share"] | undefined {
  const normalized = value.trim().toLowerCase()
  if (
    normalized === "manual" ||
    normalized === "auto" ||
    normalized === "disabled"
  ) {
    return normalized
  }
  return undefined
}

function parseBetterC0deAutoupdateSetting(
  value: string
): BetterC0deRuntimeConfigRequest["autoupdate"] | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "notify") return "notify"
  return parsePluginToggleBoolean(normalized)
}

function parseBetterC0deLayoutSetting(
  value: string
): BetterC0deRuntimeConfigRequest["layout"] | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "auto" || normalized === "stretch") return normalized
  return undefined
}

export function parsePluginBooleanFlagValue(
  flag: string,
  inlineValue: string | undefined,
  validation: string[]
): boolean {
  if (inlineValue === undefined) return true
  const normalized = inlineValue.trim().toLowerCase()
  if (normalized === "true" || normalized === "1") return true
  if (normalized === "false" || normalized === "0") return false
  validation.push(`\`${flag}\` must be true or false.`)
  return true
}
