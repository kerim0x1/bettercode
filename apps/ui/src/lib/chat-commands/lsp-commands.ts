import { parseCliArgs, stringifyCliArgs } from "@/lib/cli-parse"
import { buildCodeOutline } from "@/lib/code-outline"
import { filterDocumentSymbols } from "@/lib/document-symbols"
import {
  selectAllEditorDiagnostics,
  useEditorDiagnosticsStore,
  type EditorDiagnostic,
} from "@/lib/editor-diagnostics-store"
import { relativeEditorPath, resolveWorkspaceFilePath } from "@/lib/editor-path"
import { useEditorStore } from "@/lib/editor-store"
import { HttpError } from "@/lib/errors/types"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  buildOpenEditorWorkspaceSymbolSourcesFromTabs,
  buildWorkspaceSymbols,
} from "@/lib/workspace-symbols"
import {
  readFile,
  writeFile,
  type WorkspaceProjectLspServer,
} from "@/services/backend/workspaceApi"
import {
  formatCommand,
  formatCommandParts,
  parseFormatterExtensions,
} from "./formatter-commands"
import { formatListPlain } from "./input-context"
import { isFormatterEnvironmentKey } from "./mcp-commands"
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

interface ProjectLspConfigRequest {
  serverId?: string
  builtinsEnabled?: boolean
  command: string[]
  extensions: string[]
  env: Record<string, string>
  initialization?: Record<string, unknown>
  disabled?: boolean
  force: boolean
  dryRun: boolean
  validation: string[]
}

const BETTERC0DE_BUILTIN_LSP_SERVER_IDS = new Set([
  "astro",
  "bash",
  "biome",
  "clangd",
  "clojure-lsp",
  "csharp",
  "dart",
  "deno",
  "dockerfile",
  "elixir-ls",
  "eslint",
  "fsharp",
  "gleam",
  "gopls",
  "haskell-language-server",
  "jdtls",
  "julials",
  "kotlin-ls",
  "lua-ls",
  "nixd",
  "ocaml-lsp",
  "oxlint",
  "php intelephense",
  "prisma",
  "pyright",
  "razor",
  "ruby-lsp",
  "rust",
  "sourcekit-lsp",
  "svelte",
  "terraform",
  "texlab",
  "tinymist",
  "ty",
  "typescript",
  "vue",
  "yaml-ls",
  "zls",
])

export async function buildProjectLspConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const request = parseProjectLspConfigArgs(args)
  if (request.validation.length > 0) {
    return formatProjectConfigValidationOutput(
      "Project LSP Servers",
      request.validation
    )
  }
  if (!runtimePath) {
    return "# Project LSP Servers\n\n> Open a workspace folder before using `--config-only`."
  }
  if (!request.serverId) {
    if (request.builtinsEnabled !== undefined) {
      if (request.dryRun) {
        return [
          "# Project LSP Servers",
          "",
          "Dry run only. No files were changed.",
          "",
          "`Target: betterc0de.json#lsp`",
          `Built-ins: ${request.builtinsEnabled ? "enabled" : "disabled"}`,
        ].join("\n")
      }
      return writeProjectLspBooleanConfigFromChat({
        runtimePath,
        enabled: request.builtinsEnabled,
        force: request.force,
      })
    }
    return [
      "# Project LSP Servers",
      "",
      '> Usage: `/lsp --config-only <id> --command "typescript-language-server --stdio" --ext .ts,.tsx [--env KEY=VALUE] [--force]`',
      "> Built-ins: `/lsp --config-only --enable-builtins` or `/lsp --config-only --disable-builtins --force`.",
      "",
      "Compatibility stores LSP entries in `betterc0de.json#lsp`.",
    ].join("\n")
  }
  if (request.command.length === 0 && request.disabled !== true) {
    return [
      "# Project LSP Servers",
      "",
      "> LSP config needs `--command` for enabled entries. Use `--disable` to write a disabled entry.",
      "",
      `Server: \`${escapeInlineCode(request.serverId)}\``,
    ].join("\n")
  }
  if (
    hasMissingCustomLspExtensions({ ...request, serverId: request.serverId })
  ) {
    return [
      "# Project LSP Servers",
      "",
      "> Compatibility requires `--ext` for custom LSP servers so it knows which files the server should attach to.",
      "",
      `Server: \`${escapeInlineCode(request.serverId)}\``,
      "",
      "Built-in compatibility server IDs are exempt; use `--disable` to write a disabled custom entry without extensions.",
    ].join("\n")
  }
  if (request.dryRun) {
    return [
      "# Project LSP Servers",
      "",
      "Dry run only. No files were changed.",
      "",
      `Target: \`betterc0de.json#lsp.${escapeInlineCode(request.serverId)}\``,
      `Command: \`${escapeInlineCode(formatCommandParts(request.command))}\``,
      `Extensions: ${escapeMarkdownTableCell(formatListPlain(request.extensions))}`,
    ].join("\n")
  }

  return writeProjectLspConfigFromChat({
    runtimePath,
    request: { ...request, serverId: request.serverId },
  })
}

function hasMissingCustomLspExtensions(
  request: ProjectLspConfigRequest & { serverId: string }
): boolean {
  if (request.disabled === true) return false
  if (request.extensions.length > 0) return false
  return !BETTERC0DE_BUILTIN_LSP_SERVER_IDS.has(
    request.serverId.trim().toLowerCase()
  )
}

function parseProjectLspConfigArgs(
  args: ReadonlyArray<string>
): ProjectLspConfigRequest {
  const request: ProjectLspConfigRequest = {
    command: [],
    extensions: [],
    env: {},
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
      case "--server":
        request.serverId = nextRequiredValue(key)
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
          request.env[envKey] = envValue
        } else {
          request.validation.push(
            "`--env` must be an environment key or `KEY=value` pair."
          )
        }
        break
      }
      case "--init":
      case "--initialization": {
        const initValue = nextRequiredValue(key)
        const parsed = parseProjectLspInitialization(initValue)
        if (parsed) request.initialization = parsed
        else if (initValue) {
          request.validation.push(`\`${key}\` must be a JSON object.`)
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
        if (!arg.startsWith("-") && !request.serverId) {
          request.serverId = arg.trim()
        }
        break
    }
  }

  request.extensions = Array.from(new Set(request.extensions))
  return request
}

function parseProjectLspInitialization(
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

async function writeProjectLspBooleanConfigFromChat(input: {
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
        "# Project LSP Servers",
        "",
        "> Could not read the project BetterC0de compatibility config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n")
    }
  }

  if (
    config.lsp &&
    typeof config.lsp === "object" &&
    !Array.isArray(config.lsp) &&
    !input.force
  ) {
    return [
      "# Project LSP Servers",
      "",
      "> LSP config entries already exist.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      "",
      "Use `--force` to replace the LSP map with the compatibility CLI's boolean built-in setting.",
    ].join("\n")
  }

  config.lsp = input.enabled

  try {
    await writeFile(
      input.runtimePath,
      configPath,
      serializeBetterC0deConfig(config)
    )
  } catch (error) {
    return [
      "# Project LSP Servers",
      "",
      "> Could not write the project BetterC0de compatibility config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# Project LSP Servers",
    "",
    existed
      ? "Updated the workspace BetterC0de LSP config."
      : "Created the workspace BetterC0de LSP config.",
    "",
    `Target: \`${escapeInlineCode(configPath)}\``,
    `Built-ins: ${input.enabled ? "enabled" : "disabled"}`,
    "",
    "> Config-only mode updated only `betterc0de.json#lsp`. It did not start language servers.",
  ].join("\n")
}

async function writeProjectLspConfigFromChat(input: {
  runtimePath: string
  request: ProjectLspConfigRequest & { serverId: string }
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
        "# Project LSP Servers",
        "",
        "> Could not read the project BetterC0de compatibility config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n")
    }
  }

  const lspValue = config.lsp
  if (
    lspValue !== undefined &&
    typeof lspValue !== "boolean" &&
    (!lspValue || typeof lspValue !== "object" || Array.isArray(lspValue))
  ) {
    return [
      "# Project LSP Servers",
      "",
      "> Could not update the project LSP config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      "Error: `lsp` must be `true`, `false`, or an object map.",
    ].join("\n")
  }

  const existingServers =
    lspValue && typeof lspValue === "object" && !Array.isArray(lspValue)
      ? { ...(lspValue as Record<string, unknown>) }
      : {}
  if (
    Object.prototype.hasOwnProperty.call(
      existingServers,
      input.request.serverId
    ) &&
    !input.request.force
  ) {
    return [
      "# Project LSP Servers",
      "",
      "> LSP config entry already exists.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Server: \`${escapeInlineCode(input.request.serverId)}\``,
      "",
      "Use `--force` to replace it intentionally.",
    ].join("\n")
  }

  existingServers[input.request.serverId] = buildProjectLspConfigEntry(
    input.request
  )
  config.lsp = existingServers

  try {
    await writeFile(
      input.runtimePath,
      configPath,
      serializeBetterC0deConfig(config)
    )
  } catch (error) {
    return [
      "# Project LSP Servers",
      "",
      "> Could not write the project BetterC0de compatibility config.",
      "",
      `Target: \`${escapeInlineCode(configPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# Project LSP Servers",
    "",
    existed
      ? "Updated the workspace BetterC0de LSP config."
      : "Created the workspace BetterC0de LSP config.",
    "",
    `Target: \`${escapeInlineCode(configPath)}\``,
    `Server: \`${escapeInlineCode(input.request.serverId)}\``,
    `Command: \`${escapeInlineCode(formatCommandParts(input.request.command))}\``,
    `Extensions: ${escapeMarkdownTableCell(formatListPlain(input.request.extensions))}`,
    "",
    "> Config-only mode updated only `betterc0de.json#lsp`. It did not start a language server.",
  ].join("\n")
}

function buildProjectLspConfigEntry(
  request: ProjectLspConfigRequest
): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  if (request.disabled !== undefined) entry.disabled = request.disabled
  if (request.command.length > 0) entry.command = request.command
  if (request.extensions.length > 0) entry.extensions = request.extensions
  if (Object.keys(request.env).length > 0) entry.env = request.env
  if (request.initialization) entry.initialization = request.initialization
  return entry
}

export type ProjectLspDebugKind = "diagnostics" | "symbols" | "document-symbols"

export interface ProjectLspDebugIntent {
  kind: ProjectLspDebugKind
  target?: string
  terminalRequested?: boolean
  outputJson?: boolean
}

export function buildProjectLspDebugOutput(
  servers: ReadonlyArray<WorkspaceProjectLspServer>,
  activeThread: ActiveThreadRef,
  intent: ProjectLspDebugIntent
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const label =
    intent.kind === "diagnostics"
      ? "Diagnostics"
      : intent.kind === "symbols"
        ? "Workspace Symbols"
        : "Document Symbols"
  const placeholder =
    intent.kind === "diagnostics"
      ? "<file>"
      : intent.kind === "symbols"
        ? "<query>"
        : "<uri>"
  const target = intent.target || placeholder
  const cliCommand = `betterc0de debug lsp ${intent.kind} ${stringifyCliArgs([target])}`
  const matchingServers =
    intent.kind === "diagnostics" && intent.target
      ? servers.filter((server) => lspServerMatchesFile(server, intent.target!))
      : servers.filter((server) => server.enabled)
  const betterC0deData = buildBetterC0deLspDebugOutput(
    intent,
    target,
    runtimePath ?? null
  )
  const betterC0deJson = intent.outputJson
    ? buildBetterC0deLspDebugJsonOutput(intent, target, runtimePath ?? null)
    : null

  return [
    `# BetterC0de LSP ${label}`,
    "",
    `Compatibility reference: \`${escapeInlineCode(cliCommand)}\`.`,
    "",
    `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
    `Target: \`${escapeInlineCode(target)}\``,
    "",
    betterC0deJson ?? betterC0deData,
    betterC0deJson || betterC0deData ? "" : null,
    intent.target
      ? [
          "## Configured Server Match",
          "",
          matchingServers.length === 0
            ? "> No enabled BetterC0de LSP server in project config matches this request."
            : [
                "| Server | Extensions | Command | Source |",
                "|:-------|:-----------|:--------|:-------|",
                ...matchingServers.map(
                  (server) =>
                    `| **${escapeMarkdownTableCell(server.name)}** | ${escapeMarkdownTableCell(formatList(server.extensions))} | \`${escapeMarkdownTableCell(formatCommand(server.command, server.args, server.builtin))}\` | \`${escapeMarkdownTableCell(server.sourcePath)}\` |`
                ),
              ].join("\n"),
        ].join("\n")
      : [
          "## Usage",
          "",
          "```sh",
          `betterc0de debug lsp ${intent.kind} ${placeholder}`,
          "```",
        ].join("\n"),
    "",
    intent.terminalRequested
      ? "> Opened the terminal panel with this BetterC0de LSP debug command prefilled. Press Enter there to request raw LSP JSON intentionally."
      : intent.outputJson
        ? "> BetterC0de's BetterC0de-compatible JSON preview is synthesized from cached editor diagnostics and open-editor symbol indexes. Add `--terminal` to request raw live BetterC0de LSP JSON in the integrated terminal."
        : "> BetterC0de shows cached editor diagnostics and symbol indexes when available. Add `--json` for an BetterC0de-compatible JSON preview or `--terminal` to prefill the raw BetterC0de LSP debug command in the integrated terminal.",
  ]
    .filter((part) => part !== null && part !== undefined)
    .join("\n")
}

function buildBetterC0deLspDebugOutput(
  intent: ProjectLspDebugIntent,
  target: string,
  projectPath: string | null
): string | null {
  if (!intent.target) return null
  if (intent.kind === "diagnostics") {
    return buildBetterC0deEditorDiagnosticsOutput(target, projectPath)
  }
  if (intent.kind === "symbols") {
    return buildBetterC0deWorkspaceSymbolsOutput(target, projectPath)
  }
  return buildBetterC0deDocumentSymbolsOutput(target, projectPath)
}

function buildBetterC0deLspDebugJsonOutput(
  intent: ProjectLspDebugIntent,
  target: string,
  projectPath: string | null
): string | null {
  if (!intent.target) return null
  const payload =
    intent.kind === "diagnostics"
      ? buildBetterC0deDiagnosticsJson(target, projectPath)
      : intent.kind === "symbols"
        ? buildBetterC0deWorkspaceSymbolsJson(target, projectPath)
        : buildBetterC0deDocumentSymbolsJson(target, projectPath)
  return [
    "## BetterC0de JSON Preview",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n")
}

function buildBetterC0deDiagnosticsJson(
  target: string,
  projectPath: string | null
): unknown[] {
  return selectAllEditorDiagnostics(
    useEditorDiagnosticsStore.getState().diagnosticsByFile
  )
    .filter((diagnostic) =>
      lspTargetMatchesFile(target, diagnostic.filePath, projectPath)
    )
    .map((diagnostic) => ({
      uri: filePathToUri(diagnostic.filePath),
      file: relativeEditorPath(projectPath, diagnostic.filePath),
      severity: diagnostic.severity,
      source: diagnostic.source ?? null,
      code: diagnostic.code ?? null,
      message: diagnostic.message,
      range: editorDiagnosticRange(diagnostic),
    }))
}

function buildBetterC0deWorkspaceSymbolsJson(
  query: string,
  projectPath: string | null
): unknown[] {
  const sources = buildOpenEditorWorkspaceSymbolSourcesFromTabs({
    projectPath,
    tabs: useEditorStore.getState().tabs,
  }).sources
  return buildWorkspaceSymbols(sources, query).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    detail: symbol.detail ?? null,
    location: {
      uri: filePathToUri(symbol.filePath),
      file: symbol.relativePath,
      range: lineColumnPointRange(symbol.line, symbol.column),
    },
  }))
}

function buildBetterC0deDocumentSymbolsJson(
  target: string,
  projectPath: string | null
): unknown[] {
  const editorState = useEditorStore.getState()
  const tab = editorState.tabs.find((candidate) =>
    lspTargetMatchesFile(target, candidate.filePath, projectPath)
  )
  if (!tab) return []
  return filterDocumentSymbols(
    buildCodeOutline({
      content: tab.content,
      language: tab.language,
      fileName: relativeEditorPath(projectPath, tab.filePath),
    }),
    ""
  ).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    detail: symbol.detail ?? null,
    depth: symbol.depth,
    range: lineColumnPointRange(symbol.line, symbol.column),
    selectionRange: lineColumnPointRange(symbol.line, symbol.column),
  }))
}

function buildBetterC0deEditorDiagnosticsOutput(
  target: string,
  projectPath: string | null
): string {
  const diagnostics = selectAllEditorDiagnostics(
    useEditorDiagnosticsStore.getState().diagnosticsByFile
  ).filter((diagnostic) =>
    lspTargetMatchesFile(target, diagnostic.filePath, projectPath)
  )
  if (diagnostics.length === 0) {
    return [
      "## BetterC0de Editor Diagnostics",
      "",
      `> No cached editor diagnostics found for \`${escapeInlineCode(target)}\`. Open the file in Editor mode so Monaco can publish markers, or run the compatibility CLI command above for live LSP output.`,
    ].join("\n")
  }

  return [
    "## BetterC0de Editor Diagnostics",
    "",
    `${diagnostics.length} cached diagnostic${diagnostics.length === 1 ? "" : "s"} matched this file.`,
    "",
    "| Severity | Location | Source | Message |",
    "|:---------|:---------|:-------|:--------|",
    ...diagnostics
      .slice(0, 20)
      .map((diagnostic) => editorDiagnosticTableRow(diagnostic, projectPath)),
    diagnostics.length > 20
      ? `\n> ${diagnostics.length - 20} more hidden.`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildBetterC0deWorkspaceSymbolsOutput(
  query: string,
  projectPath: string | null
): string {
  const tabs = useEditorStore.getState().tabs
  const sources = buildOpenEditorWorkspaceSymbolSourcesFromTabs({
    projectPath,
    tabs,
  }).sources
  if (sources.length === 0) {
    return [
      "## BetterC0de Workspace Symbols",
      "",
      "> No open editor tabs are available for the local symbol index.",
    ].join("\n")
  }

  const symbols = buildWorkspaceSymbols(sources, query)
  if (symbols.length === 0) {
    return [
      "## BetterC0de Workspace Symbols",
      "",
      `> No open-editor symbols matched \`${escapeInlineCode(query)}\`.`,
    ].join("\n")
  }

  return [
    "## BetterC0de Workspace Symbols",
    "",
    `${symbols.length} symbol${symbols.length === 1 ? "" : "s"} matched open editor tabs.`,
    "",
    "| Symbol | Kind | Location | Detail |",
    "|:-------|:-----|:---------|:-------|",
    ...symbols
      .slice(0, 30)
      .map(
        (symbol) =>
          `| **${escapeMarkdownTableCell(symbol.name)}** | ${escapeMarkdownTableCell(symbol.kind)} | \`${escapeMarkdownTableCell(symbol.relativePath)}:${symbol.line}:${symbol.column}\` | ${escapeMarkdownTableCell(symbol.detail ?? "-")} |`
      ),
    symbols.length > 30 ? `\n> ${symbols.length - 30} more hidden.` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildBetterC0deDocumentSymbolsOutput(
  target: string,
  projectPath: string | null
): string {
  const editorState = useEditorStore.getState()
  const tab = editorState.tabs.find((candidate) =>
    lspTargetMatchesFile(target, candidate.filePath, projectPath)
  )
  if (!tab) {
    return [
      "## BetterC0de Document Symbols",
      "",
      `> No open editor tab matches \`${escapeInlineCode(target)}\`. Open the file in Editor mode to use BetterC0de's local outline, or run the compatibility CLI command above.`,
    ].join("\n")
  }

  const outline = filterDocumentSymbols(
    buildCodeOutline({
      content: tab.content,
      language: tab.language,
      fileName: relativeEditorPath(projectPath, tab.filePath),
    }),
    ""
  )
  if (outline.length === 0) {
    return [
      "## BetterC0de Document Symbols",
      "",
      `> No document symbols were found in \`${escapeInlineCode(relativeEditorPath(projectPath, tab.filePath))}\`.`,
    ].join("\n")
  }

  return [
    "## BetterC0de Document Symbols",
    "",
    `${outline.length} outline symbol${outline.length === 1 ? "" : "s"} found in \`${escapeInlineCode(relativeEditorPath(projectPath, tab.filePath))}\`.`,
    "",
    "| Symbol | Kind | Location | Detail |",
    "|:-------|:-----|:---------|:-------|",
    ...outline
      .slice(0, 40)
      .map(
        (symbol) =>
          `| ${"  ".repeat(symbol.depth)}**${escapeMarkdownTableCell(symbol.name)}** | ${escapeMarkdownTableCell(symbol.kind)} | \`${symbol.line}:${symbol.column}\` | ${escapeMarkdownTableCell(symbol.detail ?? "-")} |`
      ),
    outline.length > 40 ? `\n> ${outline.length - 40} more hidden.` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function lspServerMatchesFile(
  server: WorkspaceProjectLspServer,
  file: string
): boolean {
  if (!server.enabled) return false
  const normalized = file.toLowerCase()
  return server.extensions.some((extension) => {
    const ext = extension.toLowerCase()
    return ext ? normalized.endsWith(ext) : false
  })
}

function editorDiagnosticTableRow(
  diagnostic: EditorDiagnostic,
  projectPath: string | null
): string {
  const relativePath = relativeEditorPath(projectPath, diagnostic.filePath)
  const location = `${relativePath}:${diagnostic.startLineNumber}:${diagnostic.startColumn}`
  return `| ${escapeMarkdownTableCell(diagnostic.severity)} | \`${escapeMarkdownTableCell(location)}\` | ${escapeMarkdownTableCell(diagnostic.source ?? "-")} | ${escapeMarkdownTableCell(truncateTableText(diagnostic.message, 180))} |`
}

function editorDiagnosticRange(diagnostic: EditorDiagnostic): {
  start: { line: number; character: number }
  end: { line: number; character: number }
} {
  return {
    start: {
      line: Math.max(0, diagnostic.startLineNumber - 1),
      character: Math.max(0, diagnostic.startColumn - 1),
    },
    end: {
      line: Math.max(0, diagnostic.endLineNumber - 1),
      character: Math.max(0, diagnostic.endColumn - 1),
    },
  }
}

function lineColumnPointRange(
  line: number,
  column: number
): {
  start: { line: number; character: number }
  end: { line: number; character: number }
} {
  const start = {
    line: Math.max(0, line - 1),
    character: Math.max(0, column - 1),
  }
  return { start, end: start }
}

function filePathToUri(filePath: string): string {
  if (filePath.startsWith("file://")) return filePath
  return `file://${filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`
}

function lspTargetMatchesFile(
  target: string,
  filePath: string,
  projectPath: string | null
): boolean {
  const normalizedTarget = normalizeLspPathTarget(target)
  if (!normalizedTarget) return false
  const normalizedFile = normalizeLspPathTarget(filePath)
  const relativePath = normalizeLspPathTarget(
    relativeEditorPath(projectPath, filePath)
  )
  return (
    normalizedFile === normalizedTarget ||
    relativePath === normalizedTarget ||
    normalizedFile.endsWith(`/${normalizedTarget}`)
  )
}

function normalizeLspPathTarget(value: string): string {
  let cleaned = value.trim().replace(/^["']|["']$/g, "")
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname)
    } catch {
      cleaned = cleaned.slice("file://".length)
    }
  }
  return cleaned.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase()
}

function truncateTableText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}...`
}

export function formatDebugPathCell(value: string | null | undefined): string {
  if (!value) return "-"
  return `\`${escapeMarkdownTableCell(escapeInlineCode(value))}\``
}

export function formatList(values: ReadonlyArray<string>): string {
  return values.length > 0
    ? values.map((value) => `\`${value}\``).join(", ")
    : "-"
}
