import { parseCliArgs, stringifyCliArgs } from "@/lib/cli-parse"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { HttpError } from "@/lib/errors/types"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  readFile,
  writeFile,
  type WorkspaceProjectFormatter,
} from "@/services/backend/workspaceApi"
import { formatListPlain } from "./input-context"
import {
  isBetterC0deRuntimeTerminalFlag,
  isFormatterEnvironmentKey,
} from "./mcp-commands"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  parsePluginConfigObject,
  parsePluginToggleBoolean,
  serializeBetterC0deConfig,
  type ActiveThreadRef,
} from "./provider-config"
import {
  formatProjectConfigValidationOutput,
  parsePluginBooleanFlagValue,
} from "./runtime-config"

export function parseProjectFormatFlags(args: ReadonlyArray<string>): {
  args: string[]
  dryRun: boolean
  terminal: boolean
} {
  return {
    args: args.filter(
      (arg) =>
        arg !== "--dry-run" &&
        arg !== "--preview" &&
        !isBetterC0deRuntimeTerminalFlag(arg)
    ),
    dryRun: args.includes("--dry-run") || args.includes("--preview"),
    terminal: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

export function parseProjectFormatArgs(
  args: string[],
  formatters: ReadonlyArray<WorkspaceProjectFormatter>
): { relativePath: string; formatterId?: string } {
  if (args.length <= 1) return { relativePath: args.join(" ").trim() }
  const ids = new Set(
    formatters.flatMap((formatter) => [
      formatter.id.toLowerCase(),
      formatter.name.toLowerCase(),
    ])
  )
  const maybeFormatter = args.at(-1)?.toLowerCase()
  if (maybeFormatter && ids.has(maybeFormatter)) {
    return {
      relativePath: args.slice(0, -1).join(" ").trim(),
      formatterId: args.at(-1),
    }
  }
  return { relativePath: args.join(" ").trim() }
}

export function buildProjectFormatTerminalCommand(
  args: ReadonlyArray<string>,
  formatters: ReadonlyArray<WorkspaceProjectFormatter>
): { command: string; shouldOpen: boolean } {
  const requestedFlags = parseProjectFormatFlags(args)
  const { relativePath, formatterId } = parseProjectFormatArgs(
    requestedFlags.args,
    formatters
  )
  if (!relativePath) {
    return { command: "", shouldOpen: requestedFlags.terminal }
  }
  const candidates = selectProjectFormatterPreviewCandidates(
    formatters,
    relativePath,
    formatterId
  )
  const command = candidates
    .map((formatter) => projectFormatterPreviewCommand(formatter, relativePath))
    .find(Boolean)
  return { command: command ?? "", shouldOpen: requestedFlags.terminal }
}

export function buildProjectFormatPreviewOutput(input: {
  formatters: ReadonlyArray<WorkspaceProjectFormatter>
  formatterId?: string
  relativePath: string
  runtimePath: string
  terminal: boolean
}): string {
  const candidates = selectProjectFormatterPreviewCandidates(
    input.formatters,
    input.relativePath,
    input.formatterId
  )
  if (candidates.length === 0) {
    return [
      "# Format File Preview",
      "",
      `**${escapeMarkdownTableCell(input.relativePath)}** in \`${escapeInlineCode(input.runtimePath)}\``,
      "",
      input.formatterId
        ? `> No enabled BetterC0de formatter named \`${escapeInlineCode(input.formatterId)}\` matches this file.`
        : "> No enabled BetterC0de formatter matches this file.",
    ].join("\n")
  }
  const terminalCommand = buildProjectFormatTerminalCommand(
    [
      input.relativePath,
      ...(input.formatterId ? [input.formatterId] : []),
      ...(input.terminal ? ["--terminal"] : []),
    ],
    input.formatters
  )
  return [
    "# Format File Preview",
    "",
    `**${escapeMarkdownTableCell(input.relativePath)}** in \`${escapeInlineCode(input.runtimePath)}\``,
    "",
    "| Formatter | Command | Source | Status |",
    "|:----------|:--------|:-------|:-------|",
    ...candidates.map((formatter) => {
      const command = projectFormatterPreviewCommand(
        formatter,
        input.relativePath
      )
      const status = command
        ? "Runnable"
        : formatter.builtin
          ? formatter.available === false
            ? "Unavailable"
            : "BetterC0de compatibility runtime built-in"
          : "No command"
      return `| **${escapeMarkdownTableCell(formatter.name)}** | \`${escapeMarkdownTableCell(command || formatCommand(formatter.command, formatter.args, formatter.builtin))}\` | \`${escapeMarkdownTableCell(formatter.sourcePath)}\` | ${escapeMarkdownTableCell(status)} |`
    }),
    input.terminal && terminalCommand.command
      ? [
          "",
          "## Terminal",
          "",
          "```sh",
          terminalCommand.command,
          "```",
          "",
          "> Opened the terminal panel with this formatter command prefilled. Press Enter there to run it intentionally.",
        ].join("\n")
      : "",
    input.terminal && !terminalCommand.command
      ? "\n> No runnable formatter command is available to prefill in the terminal."
      : "",
    "",
    "> Preview mode does not modify files. Run `/format <file> [formatter]` without `--dry-run` or `--terminal` to execute through BetterC0de.",
  ]
    .filter(Boolean)
    .join("\n")
}

function selectProjectFormatterPreviewCandidates(
  formatters: ReadonlyArray<WorkspaceProjectFormatter>,
  relativePath: string,
  formatterId?: string
): WorkspaceProjectFormatter[] {
  const requested = formatterId?.trim().toLowerCase()
  const extension = projectFormatExtension(relativePath)
  return formatters.filter((formatter) => {
    if (!formatter.enabled) return false
    if (
      requested &&
      formatter.id.toLowerCase() !== requested &&
      formatter.name.toLowerCase() !== requested
    ) {
      return false
    }
    if (formatter.extensions.length === 0) return Boolean(requested)
    return formatter.extensions.some(
      (candidate) => candidate.toLowerCase() === extension
    )
  })
}

function projectFormatterPreviewCommand(
  formatter: WorkspaceProjectFormatter,
  relativePath: string
): string {
  if (!formatter.command) return ""
  const command = formatter.command.replace(/\$FILE/g, relativePath)
  const args = formatter.args.map((arg) => arg.replace(/\$FILE/g, relativePath))
  const includesFile =
    formatter.command.includes("$FILE") ||
    formatter.args.some((arg) => arg.includes("$FILE"))
  return formatCommand(
    command,
    includesFile ? args : [...args, relativePath],
    false
  )
}

function projectFormatExtension(relativePath: string): string {
  const basename = relativePath.split(/[\\/]/).pop() ?? relativePath
  const index = basename.lastIndexOf(".")
  return index >= 0 ? basename.slice(index).toLowerCase() : ""
}

interface ProjectFormatterConfigRequest {
  formatterId?: string
  builtinsEnabled?: boolean
  command: string[]
  extensions: string[]
  environment: Record<string, string>
  disabled?: boolean
  force: boolean
  dryRun: boolean
  validation: string[]
}

export async function buildProjectFormatterConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const request = parseProjectFormatterConfigArgs(args)
  if (request.validation.length > 0) {
    return formatProjectConfigValidationOutput(
      "Project Formatters",
      request.validation
    )
  }
  if (!runtimePath) {
    return "# Project Formatters\n\n> Open a workspace folder before using `--config-only`."
  }
  if (!request.formatterId) {
    if (request.builtinsEnabled !== undefined) {
      if (request.dryRun) {
        return [
          "# Project Formatters",
          "",
          "Dry run only. No files were changed.",
          "",
          "`Target: betterc0de.json#formatter`",
          `Built-ins: ${request.builtinsEnabled ? "enabled" : "disabled"}`,
        ].join("\n")
      }
      return writeProjectFormatterBooleanConfigFromChat({
        runtimePath,
        enabled: request.builtinsEnabled,
        force: request.force,
      })
    }
    return [
      "# Project Formatters",
      "",
      '> Usage: `/formatters --config-only <id> --command "prettier --write $FILE" --ext .ts,.tsx [--env KEY=VALUE] [--force]`',
      "> Built-ins: `/formatters --config-only --enable-builtins` or `/formatters --config-only --disable-builtins --force`.",
      "",
      "Compatibility stores formatter entries in `betterc0de.json#formatter`.",
    ].join("\n")
  }
  if (request.command.length === 0 && request.disabled === undefined) {
    return [
      "# Project Formatters",
      "",
      "> Formatter config needs either `--command` or `--disabled` / `--enable`.",
      "",
      `Formatter: \`${escapeInlineCode(request.formatterId)}\``,
    ].join("\n")
  }
  if (request.dryRun) {
    return [
      "# Project Formatters",
      "",
      "Dry run only. No files were changed.",
      "",
      `Target: \`betterc0de.json#formatter.${escapeInlineCode(request.formatterId)}\``,
      `Command: \`${escapeInlineCode(formatCommandParts(request.command))}\``,
      `Extensions: ${escapeMarkdownTableCell(formatListPlain(request.extensions))}`,
    ].join("\n")
  }

  return writeProjectFormatterConfigFromChat({
    runtimePath,
    request: { ...request, formatterId: request.formatterId },
  })
}

function parseProjectFormatterConfigArgs(
  args: ReadonlyArray<string>
): ProjectFormatterConfigRequest {
  const request: ProjectFormatterConfigRequest = {
    command: [],
    extensions: [],
    environment: {},
    force: false,
    dryRun: false,
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
      case "--config-only":
        break
      case "--force":
      case "-f":
        request.force = parsePluginBooleanFlagValue(
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
      case "--enable-builtins":
      case "--enable-builtin":
        request.builtinsEnabled = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--disable-builtins":
      case "--disable-builtin":
        request.builtinsEnabled = !parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--builtins":
      case "--builtin": {
        const rawValue = nextRequiredValue(key)
        const value = parsePluginToggleBoolean(rawValue)
        if (typeof value === "boolean") request.builtinsEnabled = value
        else if (rawValue)
          request.validation.push(`\`${key}\` must be true or false.`)
        break
      }
      case "--name":
      case "--id":
      case "--formatter":
        request.formatterId = nextRequiredValue(key)
        break
      case "--command":
      case "--cmd":
        request.command = parseCliArgs(nextRequiredValue(key))
        break
      case "--arg":
        {
          const value = nextRequiredValue("--arg")
          if (value) request.command.push(value)
        }
        break
      case "--ext":
      case "--extensions":
        request.extensions.push(
          ...parseFormatterExtensions(
            nextRequiredValue(key),
            key,
            request.validation
          )
        )
        break
      case "--env": {
        const env = nextRequiredValue("--env")
        if (!env) break
        const [envKey, ...valueParts] = env.split("=")
        const envValue = valueParts.join("=")
        if (envKey && isFormatterEnvironmentKey(envKey)) {
          request.environment[envKey] = envValue
        } else {
          request.validation.push(
            "`--env` must be an environment key or `KEY=value` pair."
          )
        }
        break
      }
      case "--disabled":
      case "--disable":
        request.disabled = parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      case "--enable":
      case "--enabled":
        request.disabled = !parsePluginBooleanFlagValue(
          key,
          inlineValue,
          request.validation
        )
        break
      default:
        if (!arg.startsWith("-") && !request.formatterId) {
          request.formatterId = arg.trim()
        }
        break
    }
  }

  request.extensions = Array.from(new Set(request.extensions))
  return request
}

export function parseFormatterExtensions(
  value: string,
  label?: string,
  validation?: string[]
): string[] {
  const extensions: string[] = []
  for (const entry of value.split(",")) {
    const raw = entry.trim().toLowerCase()
    if (!raw) continue
    const extension = raw.startsWith(".") ? raw : `.${raw}`
    if (/^\.[a-z0-9][a-z0-9._+-]*$/.test(extension)) {
      extensions.push(extension)
    } else if (label && validation) {
      validation.push(
        `Invalid BetterC0de file extension for \`${label}\`: \`${entry.trim()}\`. Use values like \`.ts\` or \`tsx\`.`
      )
    }
  }
  return extensions
}

async function writeProjectFormatterBooleanConfigFromChat(input: {
  runtimePath: string
  enabled: boolean
  force: boolean
}): Promise<string> {
  const configPath = "betterc0de.json"
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
        "# Project Formatters",
        "",
        "> Could not read the project BetterC0de compatibility config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n")
    }
  }

  if (
    config.formatter &&
    typeof config.formatter === "object" &&
    !Array.isArray(config.formatter) &&
    !input.force
  ) {
    return [
      "# Project Formatters",
      "",
      "> Formatter config entries already exist.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      "",
      "Use `--force` to replace the formatter map with the compatibility CLI's boolean built-in setting.",
    ].join("\n")
  }

  config.formatter = input.enabled

  try {
    await writeFile(
      input.runtimePath,
      configPath,
      serializeBetterC0deConfig(config)
    )
  } catch (error) {
    return [
      "# Project Formatters",
      "",
      "> Could not write the project BetterC0de compatibility config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# Project Formatters",
    "",
    existed
      ? "Updated the workspace BetterC0de formatter config."
      : "Created the workspace BetterC0de formatter config.",
    "",
    `Target: \`${escapeInlineCode(configPath)}\``,
    `Built-ins: ${input.enabled ? "enabled" : "disabled"}`,
    "",
    "> Config-only mode updated only `betterc0de.json#formatter`. It did not run formatters.",
  ].join("\n")
}

async function writeProjectFormatterConfigFromChat(input: {
  runtimePath: string
  request: ProjectFormatterConfigRequest & { formatterId: string }
}): Promise<string> {
  const configPath = "betterc0de.json"
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
        "# Project Formatters",
        "",
        "> Could not read the project BetterC0de compatibility config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n")
    }
  }

  const formatterValue = config.formatter
  if (
    formatterValue !== undefined &&
    typeof formatterValue !== "boolean" &&
    (!formatterValue ||
      typeof formatterValue !== "object" ||
      Array.isArray(formatterValue))
  ) {
    return [
      "# Project Formatters",
      "",
      "> Could not update the project formatter config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      "Error: `formatter` must be `true`, `false`, or an object map.",
    ].join("\n")
  }

  const existingFormatters =
    formatterValue &&
    typeof formatterValue === "object" &&
    !Array.isArray(formatterValue)
      ? { ...(formatterValue as Record<string, unknown>) }
      : {}
  if (
    Object.prototype.hasOwnProperty.call(
      existingFormatters,
      input.request.formatterId
    ) &&
    !input.request.force
  ) {
    return [
      "# Project Formatters",
      "",
      "> Formatter config entry already exists.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Formatter: \`${escapeInlineCode(input.request.formatterId)}\``,
      "",
      "Use `--force` to replace it intentionally.",
    ].join("\n")
  }

  existingFormatters[input.request.formatterId] =
    buildProjectFormatterConfigEntry(input.request)
  config.formatter = existingFormatters

  try {
    await writeFile(
      input.runtimePath,
      configPath,
      serializeBetterC0deConfig(config)
    )
  } catch (error) {
    return [
      "# Project Formatters",
      "",
      "> Could not write the project BetterC0de compatibility config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# Project Formatters",
    "",
    existed
      ? "Updated the workspace BetterC0de formatter config."
      : "Created the workspace BetterC0de formatter config.",
    "",
    `Target: \`${escapeInlineCode(configPath)}\``,
    `Formatter: \`${escapeInlineCode(input.request.formatterId)}\``,
    `Command: \`${escapeInlineCode(formatCommandParts(input.request.command))}\``,
    `Extensions: ${escapeMarkdownTableCell(formatListPlain(input.request.extensions))}`,
    "",
    "> Config-only mode updated only `betterc0de.json#formatter`. It did not run the formatter.",
  ].join("\n")
}

function buildProjectFormatterConfigEntry(
  request: ProjectFormatterConfigRequest
): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  if (request.disabled !== undefined) entry.disabled = request.disabled
  if (request.command.length > 0) entry.command = request.command
  if (request.extensions.length > 0) entry.extensions = request.extensions
  if (Object.keys(request.environment).length > 0) {
    entry.environment = request.environment
  }
  return entry
}

export function formatCommandParts(command: ReadonlyArray<string>): string {
  return command.length > 0 ? stringifyCliArgs([...command]) : "-"
}

export function formatCommand(
  command: string,
  args: ReadonlyArray<string>,
  builtin: boolean
): string {
  if (!command) return builtin ? "built-in" : "(not configured)"
  return [command, stringifyCliArgs([...args])].filter(Boolean).join(" ")
}
