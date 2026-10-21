import { parseCliArgs, stringifyCliArgs } from "@/lib/cli-parse"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { HttpError } from "@/lib/errors/types"
import { type RuntimeMcpServer } from "@/lib/runtime-config"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { readFile, writeFile } from "@/services/backend/workspaceApi"
import { formatListPlain } from "./input-context"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  parsePluginConfigObject,
  parsePluginToggleBoolean,
  serializeBetterC0deConfig,
  type ActiveThreadRef,
} from "./provider-config"
import { parseBetterC0dePositiveInteger } from "./runtime-config"

export function resolveRuntimeMcpServer(
  mcpList: ReadonlyArray<RuntimeMcpServer>,
  query: string | null | undefined
): RuntimeMcpServer | null {
  const normalized = normalizeRuntimeMcpQuery(query)
  if (!normalized) return null
  const exact = mcpList.find(
    (mcp) =>
      normalizeRuntimeMcpQuery(mcp.id) === normalized ||
      normalizeRuntimeMcpQuery(mcp.name) === normalized
  )
  if (exact) return exact
  const prefix = mcpList.find(
    (mcp) =>
      normalizeRuntimeMcpQuery(mcp.id).startsWith(normalized) ||
      normalizeRuntimeMcpQuery(mcp.name).startsWith(normalized)
  )
  if (prefix) return prefix
  return (
    mcpList.find(
      (mcp) =>
        normalizeRuntimeMcpQuery(mcp.id).includes(normalized) ||
        normalizeRuntimeMcpQuery(mcp.name).includes(normalized)
    ) ?? null
  )
}

export function buildMcpResourcesOutput(
  mcpList: ReadonlyArray<RuntimeMcpServer>,
  args: ReadonlyArray<string> = []
): string {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const json =
    cleanArgs.includes("--json") || cleanArgs.includes("--format=json")
  const query = cleanArgs
    .filter((arg) => !arg.startsWith("--"))
    .join(" ")
    .trim()
  const normalizedQuery = normalizeRuntimeMcpQuery(query)
  const rows = normalizedQuery
    ? mcpList.filter((mcp) =>
        normalizeRuntimeMcpQuery(
          `${mcp.id} ${mcp.name} ${mcp.type ?? ""} ${mcp.url ?? ""} ${mcp.command} ${mcp.sourcePath ?? ""}`
        ).includes(normalizedQuery)
      )
    : mcpList

  if (json) {
    return [
      "# MCP Resources",
      "",
      "Compatibility reference: `experimental.resource.list` / `GET /experimental/resource`.",
      "",
      "```json",
      JSON.stringify(
        rows.map((mcp) => ({
          client: mcp.id,
          name: mcp.name,
          type: mcp.type || "local",
          enabled: mcp.enabled,
          uri: mcp.url || null,
          sourcePath: mcp.sourcePath || null,
          authStatus: mcp.authStatus || null,
        })),
        null,
        2
      ),
      "```",
      "",
      "> BetterC0de lists configured MCP resource providers here. the compatibility CLI's HTTP route calls `listResources()` on already-connected MCP clients and returns concrete `{ name, uri, mimeType, client }` resources.",
    ].join("\n")
  }

  if (mcpList.length === 0) {
    return [
      "# MCP Resources",
      "",
      "Compatibility reference: `experimental.resource.list` / `GET /experimental/resource`.",
      "",
      "> No installed or project-local MCP servers found yet, so there are no known MCP resource providers.",
      "",
      "Use `/mcps` to inspect configured MCP servers or `/mcp-add --config-only ...` to add one.",
    ].join("\n")
  }

  return [
    "# MCP Resources",
    "",
    "Compatibility reference: `experimental.resource.list` / `GET /experimental/resource`.",
    query
      ? `Filter: \`${escapeMarkdownTableCell(query)}\` (${rows.length} match${rows.length === 1 ? "" : "es"})`
      : "",
    "",
    rows.length === 0
      ? "> No configured MCP resource provider matched this filter."
      : "| Client | Type | Resource URI scope | Auth | Source |",
    rows.length === 0
      ? ""
      : "|:-------|:-----|:-------------------|:-----|:-------|",
    ...rows.map((mcp) => {
      const uriScope =
        mcp.type === "remote"
          ? mcp.url || "remote MCP endpoint"
          : [mcp.command, ...mcp.args].filter(Boolean).join(" ") ||
            "local MCP command"
      return `| **${escapeMarkdownTableCell(mcp.name)}** (\`${escapeMarkdownTableCell(mcp.id)}\`) | ${escapeMarkdownTableCell(mcp.type || "local")} | \`${escapeMarkdownTableCell(uriScope)}\` | ${escapeMarkdownTableCell(formatRuntimeMcpAuthStatus(mcp))} | ${formatRuntimeMcpSource(mcp)} |`
    }),
    rows.length === 0 ? "" : "",
    "> BetterC0de does not silently start arbitrary MCP servers from chat to call `listResources()`. Use `/mcp-debug <id>` for connection details, or `/experimental.resource.list --terminal` to prefill an compatibility server flow when you need the raw HTTP resource endpoint.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

export function buildBetterC0deMcpTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const shouldOpen = args.some(isBetterC0deRuntimeTerminalFlag)
  const isAuthList =
    normalized === "mcp.auth.list" ||
    normalized === "mcp.auth.ls" ||
    normalized === "mcp-auth-list" ||
    normalized === "mcp-auth-ls" ||
    (normalized.includes("auth") && cleanArgs.length === 0)
  const mode = normalized.includes("debug")
    ? "debug"
    : normalized.includes("logout")
      ? "logout"
      : normalized.includes("add") || normalized.includes("install")
        ? "add"
        : normalized === "mcp" ||
            normalized.endsWith(".ls") ||
            normalized.endsWith("-ls") ||
            normalized.includes("list")
          ? "list"
          : "auth"
  const cli =
    mode === "auth" && isAuthList
      ? "betterc0de mcp auth list"
      : ["betterc0de mcp", mode, stringifyCliArgs(cleanArgs)]
          .filter(Boolean)
          .join(" ")
  return { command: cli, shouldOpen }
}

export function buildMcpTerminalSection(command: string): string {
  return [
    "## Terminal",
    "",
    "```sh",
    command,
    "```",
    "",
    "> Opened the terminal panel with this BetterC0de MCP command prefilled.",
  ].join("\n")
}

export async function buildProjectMcpConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const request = parseProjectMcpConfigArgs(args)
  if (request.validation.length > 0) {
    return buildProjectMcpConfigValidationOutput(request.validation)
  }

  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# MCP Add\n\n> Open a workspace folder before using `--config-only`."
  }

  if (!request.name) {
    return [
      "# MCP Add",
      "",
      '> Local usage: `/mcp-add --config-only filesystem --command "npx @modelcontextprotocol/server-filesystem ." --env GITHUB_TOKEN`',
      "> Remote usage: `/mcp-add --config-only docs --url https://example.com/mcp --oauth true --client-id my-client`",
      "> Remove usage: `/mcp-add --config-only docs --remove`",
    ].join("\n")
  }
  if (!isValidProjectMcpName(request.name)) {
    return "# MCP Add\n\n> MCP server name may contain only letters, numbers, `.`, `_`, and `-`, and must start with a letter or number."
  }
  if (request.clientSecretProvided) {
    return [
      "# MCP Add",
      "",
      "> Refusing to write `clientSecret` from chat.",
      "",
      "Use the compatibility CLI's interactive terminal flow for OAuth client secrets:",
      "",
      "```sh",
      "betterc0de mcp add",
      "```",
    ].join("\n")
  }

  const loaded = await loadProjectBetterC0deConfigForChat(
    runtimePath,
    "MCP Add"
  )
  if ("output" in loaded) return loaded.output

  const mcpValue = loaded.config.mcp
  if (
    mcpValue !== undefined &&
    (!mcpValue || typeof mcpValue !== "object" || Array.isArray(mcpValue))
  ) {
    return [
      "# MCP Add",
      "",
      "> Could not update the project BetterC0de MCP config.",
      "",
      `Target: \`${escapeInlineCode(loaded.configPath)}\``,
      "Error: `mcp` must be an object map of MCP server names to BetterC0de MCP entries.",
    ].join("\n")
  }

  const mcp =
    mcpValue && typeof mcpValue === "object" && !Array.isArray(mcpValue)
      ? { ...(mcpValue as Record<string, unknown>) }
      : {}

  if (request.remove) {
    delete mcp[request.name]
    loaded.config.mcp = mcp
    return writeProjectBetterC0deConfigForChat({
      runtimePath,
      config: loaded.config,
      configPath: loaded.configPath,
      existed: loaded.existed,
      heading: "MCP Add",
      settings: [`mcp.${request.name}`],
    })
  }

  const entryResult = buildProjectMcpConfigEntry(
    { ...request, name: request.name },
    mcp[request.name]
  )
  if ("error" in entryResult) {
    return [
      "# MCP Add",
      "",
      `> ${entryResult.error}`,
      "",
      `Server: \`${escapeInlineCode(request.name)}\``,
    ].join("\n")
  }

  mcp[request.name] = entryResult.entry
  loaded.config.mcp = mcp
  return writeProjectBetterC0deConfigForChat({
    runtimePath,
    config: loaded.config,
    configPath: loaded.configPath,
    existed: loaded.existed,
    heading: "MCP Add",
    settings: [`mcp.${request.name}`],
  })
}

type ProjectMcpConfigType = "local" | "remote"

interface ProjectMcpConfigRequest {
  name?: string
  type?: ProjectMcpConfigType
  command?: string[]
  url?: string
  environment: Record<string, string>
  headers: Record<string, string>
  enabled?: boolean
  timeout?: number
  oauth?: boolean
  clientId?: string
  scope?: string
  redirectUri?: string
  clientSecretProvided: boolean
  remove: boolean
  validation: string[]
}

function parseProjectMcpConfigArgs(
  args: ReadonlyArray<string>
): ProjectMcpConfigRequest {
  const request: ProjectMcpConfigRequest = {
    environment: {},
    headers: {},
    clientSecretProvided: false,
    remove: false,
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
      case "--name":
      case "--server":
        request.name = nextValue().trim()
        break
      case "--type": {
        const value = nextValue()
        const type = normalizeProjectMcpConfigType(value)
        if (type) request.type = type
        else request.validation.push("`--type` must be `local` or `remote`.")
        break
      }
      case "--local":
        request.type = "local"
        break
      case "--remote":
        request.type = "remote"
        break
      case "--command":
      case "--cmd":
        request.command = parseCliArgs(nextValue())
        request.type ??= "local"
        break
      case "--arg": {
        const command = request.command ?? []
        command.push(nextValue())
        request.command = command
        request.type ??= "local"
        break
      }
      case "--url":
        request.url = nextValue().trim()
        request.type ??= "remote"
        break
      case "--env": {
        const value = nextValue()
        const pair = parseProjectMcpEnvironmentPair(value)
        if (pair) request.environment[pair.key] = pair.value
        else {
          request.validation.push(
            "`--env` must be an environment key or `KEY=value` pair."
          )
        }
        break
      }
      case "--header":
      case "--headers": {
        const value = nextValue()
        const pair = parseProjectMcpHeaderPair(value)
        if (pair) request.headers[pair.key] = pair.value
        else {
          request.validation.push("`--header` must use `Header-Name=value`.")
        }
        break
      }
      case "--oauth": {
        const raw = nextOptionalValue() ?? "true"
        const value = parsePluginToggleBoolean(raw)
        if (value !== undefined) request.oauth = value
        else request.validation.push("`--oauth` must be true or false.")
        break
      }
      case "--no-oauth":
        request.oauth = false
        break
      case "--client-id":
      case "--clientId":
        request.clientId = nextValue().trim()
        request.oauth ??= true
        break
      case "--client-secret":
      case "--clientSecret":
        request.clientSecretProvided = true
        nextOptionalValue()
        request.oauth ??= true
        break
      case "--scope":
        request.scope = nextValue().trim()
        request.oauth ??= true
        break
      case "--redirect-uri":
      case "--redirectUri":
        request.redirectUri = nextValue().trim()
        request.oauth ??= true
        break
      case "--timeout": {
        const raw = nextValue()
        const timeout = parseBetterC0dePositiveInteger(raw)
        if (timeout) request.timeout = timeout
        else request.validation.push("`--timeout` must be a positive integer.")
        break
      }
      case "--enabled":
      case "--enable": {
        const raw = nextOptionalValue() ?? "true"
        const enabled = parsePluginToggleBoolean(raw)
        if (enabled !== undefined) request.enabled = enabled
        else request.validation.push("`--enabled` must be true or false.")
        break
      }
      case "--disabled":
      case "--disable":
        request.enabled = false
        break
      case "--remove":
      case "--delete":
        request.remove = true
        break
      default:
        if (!arg.startsWith("-") && !request.name) {
          request.name = arg.trim()
        }
        break
    }
  }

  return request
}

function buildProjectMcpConfigValidationOutput(messages: string[]): string {
  return [
    "# MCP Add",
    "",
    "> Refusing to write an invalid BetterC0de MCP config.",
    "",
    "## Validation",
    "",
    ...messages.map((message) => `- ${message}`),
  ].join("\n")
}

function buildProjectMcpConfigEntry(
  request: ProjectMcpConfigRequest & { name: string },
  current: unknown
): { entry: Record<string, unknown> } | { error: string } {
  const currentEntry =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {}
  const currentType = normalizeProjectMcpConfigType(
    typeof currentEntry.type === "string" ? currentEntry.type : ""
  )
  const type =
    request.type ??
    (request.url ? "remote" : undefined) ??
    (request.command ? "local" : undefined) ??
    currentType

  if (!type) {
    const toggleOnly =
      request.enabled !== undefined &&
      !request.command &&
      !request.url &&
      Object.keys(request.environment).length === 0 &&
      Object.keys(request.headers).length === 0 &&
      request.oauth === undefined &&
      !request.clientId &&
      !request.scope &&
      !request.redirectUri &&
      request.timeout === undefined
    if (toggleOnly) {
      return { entry: { enabled: request.enabled } }
    }
    return {
      error:
        "Provide `--command <cmd>` for a local MCP server, `--url <url>` for a remote MCP server, or update an existing MCP entry.",
    }
  }

  if (type === "local") {
    if (
      Object.keys(request.headers).length > 0 ||
      request.oauth !== undefined
    ) {
      return {
        error:
          "`--header` and OAuth options are only valid for remote MCP servers.",
      }
    }
    const existingCommand = Array.isArray(currentEntry.command)
      ? currentEntry.command.filter(
          (item): item is string => typeof item === "string"
        )
      : []
    const command = request.command ?? existingCommand
    if (command.length === 0) {
      return { error: "Local MCP config needs `--command <cmd>`." }
    }

    const existingEnvironment =
      currentType === "local" &&
      currentEntry.environment &&
      typeof currentEntry.environment === "object" &&
      !Array.isArray(currentEntry.environment)
        ? Object.fromEntries(
            Object.entries(currentEntry.environment).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : {}
    const entry: Record<string, unknown> = {
      ...(currentType === "local" ? currentEntry : {}),
      type: "local",
      command,
    }
    const environment = {
      ...existingEnvironment,
      ...request.environment,
    }
    if (Object.keys(environment).length > 0) {
      entry.environment = environment
    } else {
      delete entry.environment
    }
    if (request.enabled !== undefined) entry.enabled = request.enabled
    if (request.timeout !== undefined) entry.timeout = request.timeout
    return { entry }
  }

  if (request.command) {
    return { error: "`--command` is only valid for local MCP servers." }
  }
  if (Object.keys(request.environment).length > 0) {
    return { error: "`--env` is only valid for local MCP servers." }
  }
  const url =
    request.url ??
    (typeof currentEntry.url === "string" ? currentEntry.url.trim() : "")
  if (!url) {
    return { error: "Remote MCP config needs `--url <url>`." }
  }
  if (!isValidProjectMcpUrl(url)) {
    return { error: "Remote MCP URL must be a valid URL." }
  }

  const existingHeaders =
    currentType === "remote" &&
    currentEntry.headers &&
    typeof currentEntry.headers === "object" &&
    !Array.isArray(currentEntry.headers)
      ? Object.fromEntries(
          Object.entries(currentEntry.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : {}
  const entry: Record<string, unknown> = {
    ...(currentType === "remote" ? currentEntry : {}),
    type: "remote",
    url,
  }
  const headers = {
    ...existingHeaders,
    ...request.headers,
  }
  if (Object.keys(headers).length > 0) {
    entry.headers = headers
  } else {
    delete entry.headers
  }
  if (request.oauth === false) {
    entry.oauth = false
  } else if (
    request.oauth === true ||
    request.clientId ||
    request.scope ||
    request.redirectUri
  ) {
    entry.oauth = {
      ...(request.clientId ? { clientId: request.clientId } : {}),
      ...(request.scope ? { scope: request.scope } : {}),
      ...(request.redirectUri ? { redirectUri: request.redirectUri } : {}),
    }
  }
  if (request.enabled !== undefined) entry.enabled = request.enabled
  if (request.timeout !== undefined) entry.timeout = request.timeout
  return { entry }
}

function normalizeProjectMcpConfigType(
  value: string
): ProjectMcpConfigType | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "local" || normalized === "stdio") return "local"
  if (
    normalized === "remote" ||
    normalized === "http" ||
    normalized === "sse"
  ) {
    return "remote"
  }
  return undefined
}

function isValidProjectMcpName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

function parseProjectMcpEnvironmentPair(
  value: string
): { key: string; value: string } | undefined {
  const separator = value.indexOf("=")
  const key = (separator >= 0 ? value.slice(0, separator) : value).trim()
  if (!isFormatterEnvironmentKey(key)) return undefined
  return {
    key,
    value: separator >= 0 ? value.slice(separator + 1) : `\${${key}}`,
  }
}

function parseProjectMcpHeaderPair(
  value: string
): { key: string; value: string } | undefined {
  const separator = value.indexOf("=")
  if (separator <= 0) return undefined
  const key = value.slice(0, separator).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) return undefined
  return { key, value: value.slice(separator + 1) }
}

function isValidProjectMcpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function buildMcpLogoutOutput(
  mcpList: ReadonlyArray<RuntimeMcpServer>,
  query?: string,
  args: ReadonlyArray<string> = []
): string {
  const terminalCommand = buildBetterC0deMcpTerminalCommand("/mcp-logout", args)
  const authServers = mcpList.filter(
    (mcp) => mcp.authStatus || (mcp.oauth && mcp.oauth !== "disabled")
  )
  const matched = query ? resolveRuntimeMcpServer(mcpList, query) : null
  if (query && !matched) return buildMcpNotFoundOutput(query, mcpList)

  if (matched) {
    return [
      "# MCP Logout",
      "",
      "Compatibility reference: `betterc0de mcp logout <name>`.",
      "",
      "| Field | Value |",
      "|:------|:------|",
      `| Server | **${escapeMarkdownTableCell(matched.name)}** |`,
      `| ID | \`${escapeMarkdownTableCell(matched.id)}\` |`,
      `| Auth status | ${escapeMarkdownTableCell(formatRuntimeMcpAuthStatus(matched))} |`,
      matched.authSourcePath
        ? `| Auth source | \`${escapeMarkdownTableCell(matched.authSourcePath)}\` |`
        : "",
      "",
      "> BetterC0de shows MCP credential state but does not silently delete OAuth tokens from chat. Use the terminal command above, or remove the stored credentials through the provider/MCP auth source intentionally.",
      terminalCommand.shouldOpen && terminalCommand.command
        ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (authServers.length === 0) {
    return [
      "# MCP Logout",
      "",
      "Compatibility reference: `betterc0de mcp logout`.",
      "",
      "> No OAuth-capable MCP servers or stored MCP auth metadata found.",
      terminalCommand.shouldOpen && terminalCommand.command
        ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
        : "",
    ].join("\n")
  }

  return [
    "# MCP Logout",
    "",
    "Compatibility reference: `betterc0de mcp logout`.",
    "",
    "| Server | ID | Auth | Source |",
    "|:-------|:---|:-----|:-------|",
    ...authServers.map(
      (mcp) =>
        `| **${escapeMarkdownTableCell(mcp.name)}** | \`${escapeMarkdownTableCell(mcp.id)}\` | ${escapeMarkdownTableCell(formatRuntimeMcpAuthStatus(mcp))} | ${formatRuntimeMcpSource(mcp)} |`
    ),
    "",
    "> Use `/mcp-logout <mcp-id>` for details. Token deletion remains explicit outside chat.",
    terminalCommand.shouldOpen && terminalCommand.command
      ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
      : "",
  ].join("\n")
}

export function buildMcpNotFoundOutput(
  query: string,
  mcpList: ReadonlyArray<RuntimeMcpServer>
): string {
  const known = mcpList.map((mcp) => `\`${mcp.id}\``).join(", ")
  return [
    "# MCP Servers\n",
    `> No MCP server matched \`${query}\`.`,
    known ? `\nKnown MCP IDs: ${known}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function formatRuntimeMcpSource(mcp: RuntimeMcpServer): string {
  if (mcp.sourcePath)
    return `Project config: \`${escapeMarkdownTableCell(mcp.sourcePath)}\``
  return "Runtime settings"
}

export function formatRuntimeMcpAuthStatus(mcp: RuntimeMcpServer): string {
  const status =
    mcp.authStatus === "authenticated"
      ? "authenticated"
      : mcp.authStatus === "expired"
        ? "expired"
        : "not authenticated"
  const storage =
    mcp.authStorageKeys && mcp.authStorageKeys.length > 0
      ? ` (${mcp.authStorageKeys.join(", ")})`
      : ""
  return `${status}${storage}`
}

function normalizeRuntimeMcpQuery(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^\//, "").toLowerCase()
}

export function isFormatterEnvironmentKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

export async function loadProjectBetterC0deConfigForChat(
  runtimePath: string,
  heading: string
): Promise<
  | {
      config: Record<string, unknown>
      configPath: string
      existed: boolean
    }
  | { output: string }
> {
  const configPath = "betterc0de.json"
  const absoluteConfigPath = resolveWorkspaceFilePath(runtimePath, configPath)
  try {
    const file = await readFile(absoluteConfigPath, { silent404: true })
    return {
      config: parsePluginConfigObject(file.content, configPath),
      configPath,
      existed: true,
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { config: {}, configPath, existed: false }
    }
    return {
      output: [
        `# ${heading}`,
        "",
        "> Could not read the project BetterC0de compatibility config.",
        "",
        `Target: \`${escapeInlineCode(configPath)}\``,
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n"),
    }
  }
}

export async function writeProjectBetterC0deConfigForChat(input: {
  runtimePath: string
  config: Record<string, unknown>
  configPath: string
  existed: boolean
  heading: string
  settings: ReadonlyArray<string>
}): Promise<string> {
  try {
    await writeFile(
      input.runtimePath,
      input.configPath,
      serializeBetterC0deConfig(input.config)
    )
  } catch (error) {
    return [
      `# ${input.heading}`,
      "",
      "> Could not write the project BetterC0de compatibility config.",
      "",
      `Target: \`${escapeInlineCode(input.configPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    `# ${input.heading}`,
    "",
    input.existed
      ? "Updated the workspace BetterC0de compatibility config."
      : "Created the workspace BetterC0de compatibility config.",
    "",
    `Target: \`${escapeInlineCode(input.configPath)}\``,
    `Settings: ${escapeMarkdownTableCell(formatListPlain(input.settings))}`,
    "",
    "> Config-only mode only edited project BetterC0de compatibility config; it did not execute external code or start BetterC0de services.",
  ].join("\n")
}

export function stripBetterC0deRuntimeUiFlags(
  args: ReadonlyArray<string>
): ReadonlyArray<string> {
  return args.filter((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
}

export function isBetterC0deRuntimeTerminalFlag(arg: string): boolean {
  return (
    arg === "--terminal" ||
    arg === "--open-terminal" ||
    arg === "--new-terminal"
  )
}
