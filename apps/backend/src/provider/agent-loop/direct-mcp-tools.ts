import { isRecord } from "@betterc0de/schema"
import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type {
  PortableMcpServer,
  PortableMcpServerResolver,
} from "../runtime/acp/AcpMcpServers"
import type { ToolExecLimits, ToolExecResult } from "./tool-executor"
import type { ShellCommandRunner } from "../../services/shell"
import { normalizeLevel } from "../permissions"
import { normalizeChatMode } from "../shared/chat-mode-tools"

const MAX_MCP_SERVERS_PER_TURN = 12
const MAX_MCP_TOOLS_PER_SERVER = 32
const MAX_MCP_TOOLS_PER_TURN = 96
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_DESCRIPTION_CHARS = 2_048
const MCP_CONNECT_TIMEOUT_MS = 8_000
const MCP_LIST_TIMEOUT_MS = 8_000
const MCP_CALL_TIMEOUT_MS = 60_000

export interface DirectMcpListedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

export interface DirectMcpClient {
  listTools(options: {
    readonly signal: AbortSignal
    readonly timeout: number
    readonly maxTotalTimeout: number
  }): Promise<{ readonly tools: ReadonlyArray<DirectMcpListedTool> }>
  callTool(
    input: {
      readonly name: string
      readonly arguments: Record<string, unknown>
    },
    options: {
      readonly signal: AbortSignal
      readonly timeout: number
      readonly maxTotalTimeout: number
    }
  ): Promise<unknown>
  close(): Promise<void>
}

export type DirectMcpClientFactory = (
  server: PortableMcpServer,
  cwd: string,
  signal: AbortSignal
) => Promise<DirectMcpClient>

export interface DirectMcpAdapterOptions {
  readonly mcpServerResolver?: PortableMcpServerResolver
  readonly mcpClientFactory?: DirectMcpClientFactory
  /**
   * The backend's shell sessions, which the built-in Bash tool runs in
   * (`ToolExecContext.shell`). Bootstrap passes `AppState.shellSessions`.
   */
  readonly shellSessions?: ShellCommandRunner
}

export interface DirectMcpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

interface ConnectedMcpServer {
  readonly client: DirectMcpClient
  readonly serverName: string
}

interface ResolvedMcpTool extends DirectMcpToolDefinition {
  readonly client: DirectMcpClient
  readonly originalName: string
  readonly secretValues: ReadonlyArray<string>
}

/**
 * A turn-scoped MCP client pool for the direct API adapters.
 *
 * Discovery happens once before the first model request. Every connected
 * client is closed from the adapter's `finally` block, including failed,
 * interrupted, and provider-fallback turns.
 */
export class DirectMcpToolSession {
  private readonly byAdvertisedName = new Map<string, ResolvedMcpTool>()
  private closed = false

  private constructor(
    private readonly connections: ReadonlyArray<ConnectedMcpServer>
  ) {}

  static async open(input: {
    readonly cwd: string
    readonly signal: AbortSignal
    readonly resolver?: PortableMcpServerResolver
    readonly clientFactory?: DirectMcpClientFactory
  }): Promise<DirectMcpToolSession> {
    if (!input.resolver || input.signal.aborted) {
      return new DirectMcpToolSession([])
    }

    let servers: ReadonlyArray<PortableMcpServer>
    try {
      servers = await input.resolver(input.cwd)
    } catch {
      // MCP configuration is optional. Discovery fails closed so a corrupt
      // entry cannot prevent the provider from answering without MCP tools.
      return new DirectMcpToolSession([])
    }
    if (input.signal.aborted) return new DirectMcpToolSession([])

    const clientFactory = input.clientFactory ?? connectDirectMcpClient
    const discovered = await Promise.all(
      servers.slice(0, MAX_MCP_SERVERS_PER_TURN).map(async (server, index) => {
        let client: DirectMcpClient | null = null
        try {
          client = await clientFactory(server, input.cwd, input.signal)
          const listed = await client.listTools({
            signal: input.signal,
            timeout: MCP_LIST_TIMEOUT_MS,
            maxTotalTimeout: MCP_LIST_TIMEOUT_MS,
          })
          return {
            index,
            serverId: server.id,
            serverName: server.name,
            secretValues: configuredSecretValues(server),
            client,
            tools: listed.tools.slice(0, MAX_MCP_TOOLS_PER_SERVER),
          }
        } catch {
          await client?.close().catch(() => undefined)
          return null
        }
      })
    )

    const successful: Array<{
      index: number
      serverId: string
      serverName: string
      secretValues: ReadonlyArray<string>
      client: DirectMcpClient
      tools: ReadonlyArray<DirectMcpListedTool>
    }> = []
    for (const entry of discovered) {
      if (entry) successful.push(entry)
    }
    const session = new DirectMcpToolSession(
      successful.map(({ client, serverName }) => ({
        client,
        serverName,
      }))
    )

    let toolCount = 0
    for (const server of successful) {
      for (const tool of server.tools) {
        if (toolCount >= MAX_MCP_TOOLS_PER_TURN) break
        const schema = boundedInputSchema(tool.inputSchema, server.secretValues)
        if (!schema || !validMcpToolName(tool.name)) continue
        const name = uniqueAdvertisedToolName(
          session.byAdvertisedName,
          server.index,
          server.serverId,
          server.serverName,
          tool.name
        )
        session.byAdvertisedName.set(name, {
          name,
          originalName: tool.name,
          client: server.client,
          secretValues: server.secretValues,
          description: boundedDescription(
            server.serverName,
            tool,
            server.secretValues
          ),
          inputSchema: schema,
        })
        toolCount += 1
      }
    }
    return session
  }

  definitions(): ReadonlyArray<DirectMcpToolDefinition> {
    return [...this.byAdvertisedName.values()].map(
      ({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })
    )
  }

  has(name: string): boolean {
    return this.byAdvertisedName.has(name)
  }

  async execute(
    advertisedName: string,
    input: unknown,
    options: {
      readonly signal: AbortSignal
      readonly limits: ToolExecLimits
    }
  ): Promise<ToolExecResult> {
    const tool = this.byAdvertisedName.get(advertisedName)
    if (!tool) return failed("Unknown MCP tool.")
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return failed("MCP tool input must be a JSON object.")
    }
    if (options.signal.aborted)
      return failed("MCP tool execution was cancelled.")

    try {
      const result = await tool.client.callTool(
        {
          name: tool.originalName,
          arguments: input as Record<string, unknown>,
        },
        {
          signal: options.signal,
          timeout: MCP_CALL_TIMEOUT_MS,
          maxTotalTimeout: MCP_CALL_TIMEOUT_MS,
        }
      )
      const normalized = normalizeMcpToolResult(
        result,
        options.limits,
        tool.secretValues
      )
      const output = normalized.output
      return normalized.isError
        ? {
            output,
            error: "MCP tool reported an error.",
          }
        : { output }
    } catch {
      // SDK/transport errors can contain command lines, URLs, or authorization
      // headers. Never surface the raw message in provider events or prompts.
      return failed(
        options.signal.aborted
          ? "MCP tool execution was cancelled."
          : "MCP tool execution failed."
      )
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.byAdvertisedName.clear()
    await Promise.allSettled(
      this.connections.map((connection) => connection.client.close())
    )
  }
}

export function directMcpToolsForOpenAi(session: DirectMcpToolSession): Array<{
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}> {
  return session.definitions().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

export function directMcpToolsForAnthropic(
  session: DirectMcpToolSession
): Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> {
  return session.definitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

export function directMcpEnabledForMode(
  mode: string | null | undefined
): boolean {
  const normalized = normalizeChatMode(mode)
  return normalized === "agent" || normalized === "debug"
}

/** Read-only turns and modes without a project must not launch MCP servers. */
export function directMcpEnabledForTurn(
  mode: string | null | undefined,
  permissionLevel: string | null | undefined
): boolean {
  return (
    directMcpEnabledForMode(mode) &&
    normalizeLevel(permissionLevel) !== "read-only"
  )
}

export async function connectDirectMcpClient(
  server: PortableMcpServer,
  cwd: string,
  signal: AbortSignal
): Promise<DirectMcpClient> {
  const client = new Client({
    name: "betterc0de-direct-agent",
    version: "1.0.0",
  })
  try {
    if (server.transport === "stdio") {
      const env = validatedEnvironment(server.env)
      if (
        !validCommand(server.command) ||
        !validArguments(server.args) ||
        !env
      ) {
        throw new Error("Unsupported MCP stdio configuration.")
      }
      const transport = new StdioClientTransport({
        command: server.command,
        args: [...server.args],
        env: { ...getDefaultEnvironment(), ...env },
        cwd,
        // Child stderr may include echoed credentials. Discard it rather than
        // inheriting it into backend logs, and avoid a bounded pipe deadlock.
        stderr: "ignore",
      })
      await client.connect(transport, {
        signal,
        timeout: MCP_CONNECT_TIMEOUT_MS,
        maxTotalTimeout: MCP_CONNECT_TIMEOUT_MS,
      })
    } else {
      if (server.transport !== "http") {
        throw new Error("Unsupported MCP transport.")
      }
      const url = safeMcpHttpUrl(server.url)
      const headers = validatedHeaders(server.headers)
      if (!url || !headers) {
        throw new Error("Unsupported MCP HTTP configuration.")
      }
      const transport = new StreamableHTTPClientTransport(url, {
        // Do not let a configured HTTPS endpoint redirect credentials to a
        // different or plaintext origin. Redirects must be configured as the
        // final MCP URL explicitly.
        requestInit: { headers, redirect: "error" },
        reconnectionOptions: {
          maxReconnectionDelay: 2_000,
          initialReconnectionDelay: 250,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 1,
        },
      })
      await client.connect(transport, {
        signal,
        timeout: MCP_CONNECT_TIMEOUT_MS,
        maxTotalTimeout: MCP_CONNECT_TIMEOUT_MS,
      })
    }

    return {
      listTools: (options) => client.listTools(undefined, options),
      callTool: (input, options) => client.callTool(input, undefined, options),
      close: () => client.close(),
    }
  } catch {
    await client.close().catch(() => undefined)
    throw new Error("MCP connection failed.")
  }
}

function boundedDescription(
  serverName: string,
  tool: DirectMcpListedTool,
  secrets: ReadonlyArray<string>
): string {
  const description = tool.description?.trim() || `Run ${tool.name}.`
  return redactKnownSecrets(
    `MCP server ${serverName}: ${description}`,
    secrets
  ).slice(0, MAX_DESCRIPTION_CHARS)
}

function validMcpToolName(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !containsControlCharacter(value)
  )
}

function boundedInputSchema(
  value: Record<string, unknown>,
  secrets: ReadonlyArray<string>
): Record<string, unknown> | null {
  try {
    if (!jsonValueWithinBounds(value)) return null
    const serialized = JSON.stringify(value)
    if (
      !serialized ||
      Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES
    ) {
      return null
    }
    const parsed: unknown = JSON.parse(serialized)
    if (!isRecord(parsed) || parsed.type !== "object") return null
    return redactJsonStrings(parsed, secrets) as Record<string, unknown>
  } catch {
    return null
  }
}

function jsonValueWithinBounds(value: unknown): boolean {
  let nodes = 0
  let characters = 0
  const seen = new Set<object>()

  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1
    if (nodes > 4_096 || depth > 24) return false
    if (typeof candidate === "string") {
      characters += candidate.length
      return characters <= MAX_SCHEMA_BYTES
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return true
    }
    if (!candidate || typeof candidate !== "object") return false
    if (seen.has(candidate)) return false
    seen.add(candidate)

    if (Array.isArray(candidate)) {
      if (candidate.length > 1_024) return false
      for (const item of candidate) {
        if (!visit(item, depth + 1)) return false
      }
      return true
    }

    let entries = 0
    for (const [key, item] of Object.entries(candidate)) {
      entries += 1
      characters += key.length
      if (
        entries > 1_024 ||
        characters > MAX_SCHEMA_BYTES ||
        !visit(item, depth + 1)
      ) {
        return false
      }
    }
    return true
  }

  return visit(value, 0)
}

function redactJsonStrings(
  value: unknown,
  secrets: ReadonlyArray<string>
): unknown {
  if (typeof value === "string") return redactKnownSecrets(value, secrets)
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonStrings(entry, secrets))
  }
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      redactKnownSecrets(key, secrets),
      redactJsonStrings(entryValue, secrets),
    ])
  )
}

function uniqueAdvertisedToolName(
  existing: ReadonlyMap<string, unknown>,
  serverIndex: number,
  serverId: string,
  serverName: string,
  toolName: string
): string {
  const serverSlug = toolNameSlug(serverName, 16)
  const toolSlug = toolNameSlug(toolName, 24)
  const seed = `${serverIndex}\0${serverId}\0${serverName}\0${toolName}`
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 10)
  const base = `mcp__${serverSlug}__${toolSlug}_${hash}`.slice(0, 64)
  if (!existing.has(base)) return base

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixText = `_${suffix.toString(36)}`
    const candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`
    if (!existing.has(candidate)) return candidate
  }
  throw new Error("MCP tool namespace exhausted.")
}

function toolNameSlug(value: string, maxLength: number): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\u0020-\u007e]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength)
  return normalized || "tool"
}

function validCommand(value: string): boolean {
  return Boolean(
    value.trim() &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    !value.includes("\r") &&
    !value.includes("\n")
  )
}

function validArguments(values: ReadonlyArray<string>): boolean {
  return (
    values.length <= 32 &&
    values.every(
      (value) =>
        value.length <= 2_048 &&
        !value.includes("\0") &&
        !value.includes("\r") &&
        !value.includes("\n")
    )
  )
}

function validatedEnvironment(
  entries: Readonly<Record<string, string>>
): Record<string, string> | null {
  const pairs = Object.entries(entries)
  if (pairs.length > 64) return null
  const output: Record<string, string> = {}
  for (const [name, value] of pairs) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      value.length > 8_192 ||
      value.includes("\0")
    ) {
      return null
    }
    output[name] = value
  }
  return output
}

function validatedHeaders(
  entries: Readonly<Record<string, string>>
): Headers | null {
  const pairs = Object.entries(entries)
  if (pairs.length > 64) return null
  const headers = new Headers()
  try {
    for (const [name, value] of pairs) {
      const normalizedName = name.toLowerCase()
      if (
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
        UNSAFE_CONFIGURED_HTTP_HEADERS.has(normalizedName) ||
        value.length > 8_192 ||
        value.includes("\0") ||
        value.includes("\r") ||
        value.includes("\n")
      ) {
        return null
      }
      headers.set(name, value)
    }
    return headers
  } catch {
    return null
  }
}

const UNSAFE_CONFIGURED_HTTP_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function safeMcpHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.username || url.password) return null
    if (url.protocol === "https:") return url
    if (url.protocol !== "http:") return null
    const hostname = url.hostname.toLowerCase()
    const loopback =
      hostname === "localhost" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    return loopback ? url : null
  } catch {
    return null
  }
}

function configuredSecretValues(
  server: PortableMcpServer
): ReadonlyArray<string> {
  const values =
    server.transport === "stdio"
      ? Object.values(server.env)
      : [...Object.values(server.headers), ...safeUrlSearchValues(server.url)]
  const secrets = new Set<string>()
  for (const value of values) {
    if (!value) continue
    secrets.add(value)
    const authorizationValue = value.match(
      /^\s*(?:bearer|basic)\s+(.+?)\s*$/i
    )?.[1]
    if (authorizationValue) secrets.add(authorizationValue)
  }
  return [...secrets].sort((left, right) => right.length - left.length)
}

function safeUrlSearchValues(value: string): string[] {
  try {
    return [...new URL(value).searchParams.values()].filter(Boolean)
  } catch {
    return []
  }
}

function redactKnownSecrets(
  value: string,
  secrets: ReadonlyArray<string>
): string {
  let output = value
  for (const secret of secrets) {
    output = output.split(secret).join("[REDACTED]")
  }
  return output
}

function normalizeMcpToolResult(
  value: unknown,
  limits: ToolExecLimits,
  secrets: ReadonlyArray<string>
): { output: string; isError: boolean } {
  if (!isRecord(value)) {
    return {
      output: truncateOutput("MCP tool returned no content.", limits),
      isError: false,
    }
  }
  const parts: string[] = []
  const captureLimit = Math.max(1, limits.maxBytes) + 64
  let capturedBytes = 0
  let contentWasTruncated = false
  const addPart = (part: string): void => {
    if (capturedBytes >= captureLimit) {
      contentWasTruncated = true
      return
    }
    // Redact complete values before capture or final truncation can cut through
    // a credential and leave a prefix that no longer matches the secret.
    part = redactKnownSecrets(part, secrets)
    const separatorBytes = parts.length > 0 ? 1 : 0
    const remaining = Math.max(0, captureLimit - capturedBytes - separatorBytes)
    const bounded = utf8Prefix(part, remaining)
    if (bounded !== part) contentWasTruncated = true
    if (!bounded && part) return
    parts.push(bounded)
    capturedBytes += separatorBytes + Buffer.byteLength(bounded, "utf8")
  }
  const content = Array.isArray(value.content) ? value.content : []
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === "text" && typeof item.text === "string") {
      addPart(item.text)
    } else if (item.type === "image" && typeof item.data === "string") {
      addPart(
        `[image ${stringValue(item.mimeType) ?? "unknown"}; ${base64ByteLength(
          item.data
        )} bytes]`
      )
    } else if (item.type === "audio" && typeof item.data === "string") {
      addPart(
        `[audio ${stringValue(item.mimeType) ?? "unknown"}; ${base64ByteLength(
          item.data
        )} bytes]`
      )
    } else if (item.type === "resource" && isRecord(item.resource)) {
      const resource = item.resource
      if (typeof resource.text === "string") {
        addPart(`${stringValue(resource.uri) ?? "resource"}:\n${resource.text}`)
      } else {
        addPart(
          `[resource ${stringValue(resource.uri) ?? "unknown"}; binary content omitted]`
        )
      }
    } else if (item.type === "resource_link") {
      addPart(
        `[resource ${stringValue(item.name) ?? "link"}: ${
          stringValue(item.uri) ?? "unknown"
        }]`
      )
    }
  }

  if (parts.length === 0 && isRecord(value.structuredContent)) {
    addPart(safeJson(value.structuredContent))
  }
  if (parts.length === 0 && "toolResult" in value) {
    addPart(safeJson(value.toolResult))
  }
  if (parts.length === 0) addPart("MCP tool returned no content.")
  if (contentWasTruncated) addPart("\nadditional content omitted")
  return {
    output: truncateOutput(
      redactKnownSecrets(parts.join("\n"), secrets),
      limits
    ),
    isError: value.isError === true,
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable MCP result]"
  }
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

function truncateOutput(value: string, limits: ToolExecLimits): string {
  const maxLines = Math.max(1, limits.maxLines)
  const maxBytes = Math.max(1, limits.maxBytes)
  const marker = "\n… [output truncated]"
  let output = value
  let truncated = false
  const lines = output.split("\n")
  if (lines.length > maxLines) {
    output = lines.slice(0, maxLines).join("\n")
    truncated = true
  }
  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = utf8Prefix(
      output,
      Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"))
    )
    truncated = true
  }
  if (!truncated) return output
  if (maxBytes <= Buffer.byteLength(marker.trimStart(), "utf8")) {
    return utf8Prefix(marker.trimStart(), maxBytes)
  }
  return `${utf8Prefix(output, maxBytes - Buffer.byteLength(marker, "utf8"))}${marker}`
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ""
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8")
    if (bytes + size > maxBytes) break
    bytes += size
    output += codePoint
  }
  return output
}

function failed(error: string): ToolExecResult {
  return { output: `Error: ${error}`, error }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}
