import { stringifyCliArgs } from "@/lib/cli-parse"
import {
  setRuntimeMcpEnabled,
  type RuntimeMcpServer,
} from "@/lib/runtime-config"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  listProjectMcpServers,
  type WorkspaceProjectMcpServer,
} from "@/services/backend/workspaceApi"
import { errorMessage, formatListPlain } from "./input-context"
import { formatDebugPathCell } from "./lsp-commands"
import {
  buildBetterC0deMcpTerminalCommand,
  buildMcpNotFoundOutput,
  buildMcpTerminalSection,
  formatRuntimeMcpAuthStatus,
  formatRuntimeMcpSource,
  isBetterC0deRuntimeTerminalFlag,
  resolveRuntimeMcpServer,
} from "./mcp-commands"
import {
  escapeMarkdownTableCell,
  type ActiveThreadRef,
} from "./provider-config"

export async function listProjectRuntimeMcps(
  runtimePath?: string | null
): Promise<RuntimeMcpServer[]> {
  if (!runtimePath) return []
  try {
    const projectMcps = await listProjectMcpServers(runtimePath)
    return projectMcps.map(projectMcpToRuntimeMcp)
  } catch {
    return []
  }
}

function projectMcpToRuntimeMcp(
  server: WorkspaceProjectMcpServer
): RuntimeMcpServer {
  return {
    id: server.id,
    name: server.name || server.id,
    command: server.command,
    args: server.args,
    env: server.env,
    envKeys: server.envKeys,
    headerKeys: server.headerKeys,
    enabled: server.enabled,
    type: server.type,
    url: server.url ?? null,
    sourcePath: server.sourcePath,
    timeoutMs: server.timeoutMs,
    oauth: server.oauth,
    oauthKeys: server.oauthKeys,
    authStatus: server.authStatus,
    authStorageKeys: server.authStorageKeys,
    authSourcePath: server.authSourcePath,
    authServerUrl: server.authServerUrl,
  }
}

export function buildMcpServersOutput(
  mcpList: ReadonlyArray<RuntimeMcpServer>,
  args: ReadonlyArray<string> = []
): string {
  const terminalCommand = buildBetterC0deMcpTerminalCommand("/mcp.list", args)
  if (mcpList.length === 0) {
    return [
      "# MCP Servers",
      "",
      "> No installed or project-local MCP servers found yet.",
      ">",
      "> Open the **Marketplace** to browse and install MCP servers like GitHub, Supabase, Vercel, and more, or add BetterC0de MCP config in `betterc0de.jsonc`.",
      "",
      terminalCommand.shouldOpen && terminalCommand.command
        ? buildMcpTerminalSection(terminalCommand.command)
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  }
  return [
    "# MCP Servers\n",
    `${mcpList.length} server${mcpList.length > 1 ? "s" : ""} available, ${mcpList.filter((m) => m.enabled).length} active\n`,
    "| Server | ID | Type | Command | Args | Details | Status | Source |",
    "|:-------|:---|:-----|:--------|:-----|:--------|:-------|:-------|",
    ...mcpList.map((mcp) => {
      const args = stringifyCliArgs(mcp.args)
      return `| **${escapeMarkdownTableCell(mcp.name)}** | \`${escapeMarkdownTableCell(mcp.id)}\` | ${escapeMarkdownTableCell(mcp.type || "local")} | \`${escapeMarkdownTableCell(mcp.command)}\` | \`${escapeMarkdownTableCell(args)}\` | ${escapeMarkdownTableCell(formatRuntimeMcpDetails(mcp))} | ${formatRuntimeMcpStatus(mcp)} | ${formatRuntimeMcpSource(mcp)} |`
    }),
    "",
    "> Type `/<mcp-id>` or `/mcps <mcp-id>` to inspect a server. Use `/mcp-toggle <mcp-id> [on|off]` for installed runtime MCPs.",
    terminalCommand.shouldOpen && terminalCommand.command
      ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
      : "",
  ].join("\n")
}

export function stripBetterC0deMcpSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (
    ![
      "add",
      "install",
      "auth",
      "authenticate",
      "logout",
      "remove",
      "debug",
      "inspect",
      "list",
      "ls",
      "status",
      "resource",
      "resources",
    ].includes(first ?? "")
  ) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}

export function buildMcpAuthOutput(
  mcpList: ReadonlyArray<RuntimeMcpServer>,
  args: ReadonlyArray<string> = []
): string {
  const terminalCommand = buildBetterC0deMcpTerminalCommand("/mcp-auth", args)
  const authServers = mcpList.filter(
    (mcp) => (mcp.oauth && mcp.oauth !== "disabled") || mcp.authStatus
  )

  if (mcpList.length === 0) {
    return [
      "# MCP Auth",
      "",
      "Compatibility reference: `betterc0de mcp auth list`.",
      "",
      "> No MCP servers are installed or configured.",
      terminalCommand.shouldOpen && terminalCommand.command
        ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
        : "",
    ].join("\n")
  }

  if (authServers.length === 0) {
    return [
      "# MCP Auth",
      "",
      "Compatibility reference: `betterc0de mcp auth list`.",
      "",
      "> No OAuth-capable MCP servers found. Use `/mcps` to inspect all configured servers.",
      terminalCommand.shouldOpen && terminalCommand.command
        ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
        : "",
    ].join("\n")
  }

  return [
    "# MCP Auth",
    "",
    "Compatibility reference: `betterc0de mcp auth list`.",
    "",
    "| Server | ID | OAuth | Auth | Source |",
    "|:-------|:---|:------|:-----|:-------|",
    ...authServers.map(
      (mcp) =>
        `| **${escapeMarkdownTableCell(mcp.name)}** | \`${escapeMarkdownTableCell(mcp.id)}\` | ${escapeMarkdownTableCell(formatRuntimeMcpOAuth(mcp))} | ${escapeMarkdownTableCell(formatRuntimeMcpAuthStatus(mcp))} | ${formatRuntimeMcpSource(mcp)} |`
    ),
    "",
    "> Stored tokens and client secrets are never shown. Use `/mcp-auth <mcp-id>` for full connection details.",
    terminalCommand.shouldOpen && terminalCommand.command
      ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
      : "",
    "",
  ].join("\n")
}

export function buildMcpAddOutput(
  activeThread: ActiveThreadRef,
  args: ReadonlyArray<string> = []
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const terminalCommand = buildBetterC0deMcpTerminalCommand("/mcp-add", args)
  return [
    "# MCP Add",
    "",
    "Compatibility reference: `betterc0de mcp add`.",
    "",
    `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
    "",
    "Opened **Settings > Tools & MCP**. Add managed BetterC0de MCP servers there, or add project-local BetterC0de MCP config in `betterc0de.jsonc`.",
    "",
    "Project-local remote MCP example:",
    "",
    "```json",
    '{ "mcp": { "my-server": { "type": "remote", "url": "https://example.com/mcp" } } }',
    "```",
    "",
    "Project-local local MCP example:",
    "",
    "```json",
    '{ "mcp": { "my-server": { "type": "local", "command": ["node", "./server.js"] } } }',
    "```",
    "",
    "Config-only chat usage:",
    "",
    '`/mcp-add --config-only my-server --url https://example.com/mcp` or `/mcp-add --config-only my-server --command "node ./server.js"`.',
    "",
    terminalCommand.shouldOpen && terminalCommand.command
      ? buildMcpTerminalSection(terminalCommand.command)
      : "> Add `--terminal` to prefill `betterc0de mcp add` in the integrated terminal.",
  ].join("\n")
}

export function buildMcpDebugOutput(
  mcpList: ReadonlyArray<RuntimeMcpServer>,
  query?: string,
  args: ReadonlyArray<string> = []
): string {
  const terminalCommand = buildBetterC0deMcpTerminalCommand("/mcp-debug", args)
  if (!query?.trim()) {
    return [
      "# MCP Debug",
      "",
      "Compatibility reference: `betterc0de mcp debug <name>`.",
      "",
      "> Usage: `/mcp-debug <mcp-id>`",
      "",
      mcpList.length
        ? `Known MCP IDs: ${mcpList.map((mcp) => `\`${mcp.id}\``).join(", ")}`
        : "No MCP servers are installed or configured.",
      terminalCommand.shouldOpen && terminalCommand.command
        ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
        : "",
    ].join("\n")
  }

  const matched = resolveRuntimeMcpServer(mcpList, query)
  if (!matched) return buildMcpNotFoundOutput(query, mcpList)
  return [
    "# MCP Debug",
    "",
    "Compatibility reference: `betterc0de mcp debug <name>`.",
    "",
    buildRuntimeMcpDetailOutput(matched),
    terminalCommand.shouldOpen && terminalCommand.command
      ? `\n${buildMcpTerminalSection(terminalCommand.command)}`
      : "",
  ].join("\n")
}

export function buildRuntimeMcpDetailOutput(mcp: RuntimeMcpServer): string {
  const args = stringifyCliArgs(mcp.args)
  return [
    `# ${mcp.name}\n`,
    "| | |",
    "|:--|:--|",
    "| **Type** | MCP Server |",
    `| **Status** | ${formatRuntimeMcpStatus(mcp)} |`,
    `| **Command** | \`${escapeMarkdownTableCell([mcp.command, args].filter(Boolean).join(" "))}\` |`,
    `| **ID** | \`${escapeMarkdownTableCell(mcp.id)}\` |`,
    `| **Source** | ${formatRuntimeMcpSource(mcp)} |`,
    mcp.url ? `| **URL** | \`${escapeMarkdownTableCell(mcp.url)}\` |` : "",
    mcp.envKeys?.length
      ? `| **Environment keys** | ${escapeMarkdownTableCell(formatListPlain(mcp.envKeys))} |`
      : "",
    mcp.headerKeys?.length
      ? `| **Header keys** | ${escapeMarkdownTableCell(formatListPlain(mcp.headerKeys))} |`
      : "",
    mcp.timeoutMs ? `| **Timeout** | ${mcp.timeoutMs} ms |` : "",
    mcp.oauth
      ? `| **OAuth** | ${escapeMarkdownTableCell(formatRuntimeMcpOAuth(mcp))} |`
      : "",
    mcp.authStatus
      ? `| **Auth status** | ${escapeMarkdownTableCell(formatRuntimeMcpAuthStatus(mcp))} |`
      : "",
    mcp.authSourcePath
      ? `| **Auth source** | \`${escapeMarkdownTableCell(mcp.authSourcePath)}\` |`
      : "",
    "",
    canPersistRuntimeMcpToggle(mcp)
      ? "> Toggle with `/mcp-toggle " +
        mcp.id +
        ` ${mcp.enabled ? "off" : "on"}\`.`
      : `> Project-local MCPs are controlled by \`betterc0de.jsonc\`; use \`/mcp-toggle ${mcp.id} ${mcp.enabled ? "off" : "on"} --config-only\` to write a project override.`,
  ]
    .filter(Boolean)
    .join("\n")
}

export async function buildRuntimeMcpToggleOutput(
  mcp: RuntimeMcpServer,
  enabled: boolean
): Promise<string> {
  if (!canPersistRuntimeMcpToggle(mcp)) {
    return [
      "# MCP Toggle\n",
      `\`${mcp.id}\` is project-local and comes from ${formatRuntimeMcpSource(mcp)}.`,
      "",
      `> Use \`/mcp-toggle ${mcp.id} ${enabled ? "on" : "off"} --config-only\` to write a project override, or install this MCP through Settings before toggling runtime state.`,
    ].join("\n")
  }
  try {
    await setRuntimeMcpEnabled(mcp.id, enabled)
    return [
      "# MCP Toggle\n",
      "| | |",
      "|:--|:--|",
      `| **Server** | ${escapeMarkdownTableCell(mcp.name)} |`,
      `| **ID** | \`${escapeMarkdownTableCell(mcp.id)}\` |`,
      `| **Status** | ${enabled ? "Active" : "Disabled"} |`,
    ].join("\n")
  } catch (err) {
    return [
      "# MCP Toggle\n",
      `> Failed to update \`${mcp.id}\`: ${escapeMarkdownTableCell(errorMessage(err))}`,
    ].join("\n")
  }
}

function canPersistRuntimeMcpToggle(mcp: RuntimeMcpServer): boolean {
  return !mcp.sourcePath || Boolean(mcp.installedAt)
}

function formatRuntimeMcpStatus(mcp: RuntimeMcpServer): string {
  return mcp.enabled ? "Active" : "Disabled"
}

function formatRuntimeMcpDetails(mcp: RuntimeMcpServer): string {
  const details = [
    mcp.envKeys?.length ? `env ${formatListPlain(mcp.envKeys)}` : "",
    mcp.headerKeys?.length ? `headers ${formatListPlain(mcp.headerKeys)}` : "",
    mcp.timeoutMs ? `timeout ${mcp.timeoutMs}ms` : "",
    mcp.oauth ? `oauth ${formatRuntimeMcpOAuth(mcp)}` : "",
    mcp.authStatus ? `auth ${formatRuntimeMcpAuthStatus(mcp)}` : "",
  ].filter(Boolean)
  return details.length > 0 ? details.join(" · ") : "-"
}

function formatRuntimeMcpOAuth(mcp: RuntimeMcpServer): string {
  if (mcp.oauth === "configured") {
    return mcp.oauthKeys && mcp.oauthKeys.length > 0
      ? `configured (${mcp.oauthKeys.join(", ")})`
      : "configured"
  }
  if (mcp.oauth === "disabled") return "disabled"
  return "auto"
}
