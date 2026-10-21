import fs from "node:fs/promises"
import path from "node:path"
import { readBoolean, readStringRecord, readUnknownRecord } from "./formatters"
import {
  formatBetterC0deConfigSourcePath,
  readBetterC0deProjectConfigs,
  readRecord,
} from "./project-config"
import {
  betterC0deDataDirectories,
  readFiniteNumber,
  readPositiveInteger,
  readString,
} from "./providers"

export interface ProjectMcpServerTemplate {
  id: string
  name: string
  type: "local" | "remote"
  command: string
  args: string[]
  env: Record<string, string>
  envKeys?: string[]
  headerKeys?: string[]
  enabled: boolean
  sourcePath: string
  url?: string | null
  timeoutMs?: number
  oauth?: "auto" | "disabled" | "configured"
  oauthKeys?: string[]
  authStatus?: "authenticated" | "expired" | "not_authenticated"
  authStorageKeys?: string[]
  authSourcePath?: string
  authServerUrl?: string | null
  /**
   * False when the entry comes from the user's own global or managed config;
   * true when the opened repository declared it (see project-config.ts).
   */
  workspaceControlled?: boolean
}

export async function listProjectMcpServers(
  cwd: string
): Promise<ProjectMcpServerTemplate[]> {
  const root = path.resolve(cwd)
  const authData = await readBetterC0deMcpAuthData()
  const byId = new Map<string, ProjectMcpServerTemplate>()
  for (const {
    config,
    sourcePath,
    workspaceControlled,
  } of await readBetterC0deProjectConfigs(root, { strict: true })) {
    const mcpConfig = readRecord(config, "mcp")
    for (const [id, rawServer] of Object.entries(mcpConfig)) {
      const server = projectMcpServerFromConfig(id, rawServer, sourcePath)
      if (server)
        byId.set(id, {
          ...attachProjectMcpAuthStatus(server, authData),
          workspaceControlled,
        })
    }
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { sensitivity: "base" })
  )
}

function projectMcpServerFromConfig(
  id: string,
  rawServer: unknown,
  sourcePath: string
): ProjectMcpServerTemplate | null {
  if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) {
    return null
  }
  const server = rawServer as Record<string, unknown>
  const type = readString(server.type)
  const enabled = readBoolean(server.enabled) !== false
  const timeoutMs = readPositiveInteger(server.timeout)
  if (type === "local") {
    const command = Array.isArray(server.command)
      ? server.command.filter(
          (item): item is string => typeof item === "string"
        )
      : []
    if (command.length === 0) return null
    const env = readStringRecord(server.environment)
    const envKeys = sortedRecordKeys(env)
    return {
      id,
      name: id,
      type,
      command: command[0] ?? "",
      args: command.slice(1),
      env,
      ...(envKeys.length > 0 ? { envKeys } : {}),
      enabled,
      sourcePath: `${sourcePath}#mcp.${id}`,
      ...(timeoutMs ? { timeoutMs } : {}),
    }
  }

  if (type === "remote") {
    const url = readString(server.url)
    if (!url) return null
    const oauth = normalizeProjectMcpOAuth(server.oauth)
    const headers = readStringRecord(server.headers)
    const headerKeys = sortedRecordKeys(headers)
    return {
      id,
      name: id,
      type,
      command: url,
      args: [],
      env: headers,
      ...(headerKeys.length > 0 ? { headerKeys } : {}),
      enabled,
      sourcePath: `${sourcePath}#mcp.${id}`,
      url,
      ...(timeoutMs ? { timeoutMs } : {}),
      oauth: oauth.mode,
      ...(oauth.keys.length > 0 ? { oauthKeys: oauth.keys } : {}),
    }
  }

  return null
}

function sortedRecordKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  )
}

function normalizeProjectMcpOAuth(value: unknown): {
  mode: "auto" | "disabled" | "configured"
  keys: string[]
} {
  if (value === false) return { mode: "disabled", keys: [] }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      mode: "configured",
      keys: Object.keys(readUnknownRecord(value)).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      ),
    }
  }
  return { mode: "auto", keys: [] }
}

type BetterC0deMcpAuthData = {
  sourcePath?: string
  entries: Record<string, unknown>
}

async function readBetterC0deMcpAuthData(): Promise<BetterC0deMcpAuthData> {
  for (const dataDir of betterC0deDataDirectories()) {
    const authPath = path.join(dataDir, "mcp-auth.json")
    try {
      const raw = await fs.readFile(authPath, "utf8")
      const parsed = JSON.parse(raw)
      return {
        sourcePath: formatBetterC0deConfigSourcePath(authPath),
        entries: readUnknownRecord(parsed),
      }
    } catch {
      continue
    }
  }
  return { entries: {} }
}

function attachProjectMcpAuthStatus(
  server: ProjectMcpServerTemplate,
  authData: BetterC0deMcpAuthData
): ProjectMcpServerTemplate {
  if (server.type !== "remote" || server.oauth === "disabled") return server
  const entry = readUnknownRecord(authData.entries[server.id])
  const hasEntry = Object.keys(entry).length > 0
  const storedServerUrl = readString(entry.serverUrl)
  const matchesUrl =
    !storedServerUrl || !server.url || storedServerUrl === server.url
  const usableEntry = hasEntry && matchesUrl ? entry : {}
  const authStatus = projectMcpAuthStatus(usableEntry)
  const authStorageKeys =
    hasEntry && matchesUrl ? projectMcpAuthStorageKeys(entry) : []
  return {
    ...server,
    authStatus,
    ...(authStorageKeys.length > 0 ? { authStorageKeys } : {}),
    ...(hasEntry && matchesUrl && authData.sourcePath
      ? { authSourcePath: authData.sourcePath }
      : {}),
    ...(storedServerUrl && matchesUrl
      ? { authServerUrl: storedServerUrl }
      : {}),
  }
}

function projectMcpAuthStatus(
  entry: Record<string, unknown>
): "authenticated" | "expired" | "not_authenticated" {
  const tokens = readUnknownRecord(entry.tokens)
  if (Object.keys(tokens).length === 0) return "not_authenticated"
  const expiresAt = readFiniteNumber(tokens.expiresAt)
  if (expiresAt !== undefined && expiresAt < Date.now() / 1000) {
    return "expired"
  }
  return "authenticated"
}

function projectMcpAuthStorageKeys(entry: Record<string, unknown>): string[] {
  const keys: string[] = []
  if (Object.keys(readUnknownRecord(entry.tokens)).length > 0) {
    keys.push("tokens")
  }
  if (Object.keys(readUnknownRecord(entry.clientInfo)).length > 0) {
    keys.push("clientInfo")
  }
  if (readString(entry.codeVerifier)) keys.push("codeVerifier")
  if (readString(entry.oauthState)) keys.push("oauthState")
  if (readString(entry.serverUrl)) keys.push("serverUrl")
  return keys
}
