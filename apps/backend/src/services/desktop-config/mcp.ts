import type { PromptMcp } from "@betterc0de/schema/prompt-context"
import type { AppState } from "../../appState"
import {
  resolvePortableMcpServers,
  type PortableMcpServer,
  type ResolveMcpServersOptions,
  type SettingsMcpServerInput,
} from "../../provider/runtime/acp/AcpMcpServers"
import { desktopConfigStoreFor } from "./store"

/**
 * The MCP servers configured for a workspace, as one list. Agent turns
 * attach exactly these (bootstrap/providers.ts wires this resolver into
 * every provider), and the prompt lists exactly these
 * (`promptMcpsFromServers`), so the two can no longer disagree.
 *
 * Sources: the desktop's `mcp-servers.json` in the runtime home (its
 * project/local entries only in their own, explicitly trusted workspace),
 * the user's global BetterC0de config, and the workspace's own config when
 * the workspace is explicitly trusted. `settings.mcp_servers` is read only
 * while it still exists: the one-time migration (migration.ts) moves it into
 * `mcp-servers.json` and removes it, so it is present only when that could
 * not complete (settings writes blocked).
 */

/**
 * What the resolution reads. Without `agentPermissions` no workspace counts
 * as trusted, so no workspace adds servers (fails closed).
 */
export type ConfiguredMcpState = Pick<AppState, "config" | "settings"> &
  Partial<Pick<AppState, "agentPermissions">>

/** Legacy `settings.mcp_servers`, still present only before migration. */
function legacySettingsServers(
  state: Pick<AppState, "settings">
): ReadonlyArray<SettingsMcpServerInput> {
  const servers = (state.settings.get() as { mcp_servers?: unknown })
    .mcp_servers
  return Array.isArray(servers)
    ? (servers as ReadonlyArray<SettingsMcpServerInput>)
    : []
}

/**
 * Options for `resolvePortableMcpServers` that every caller shares. A
 * workspace may contribute servers only once it is *explicitly* trusted:
 * the compatibility default ("trusted" with no stored record) is not consent
 * to run what a repository chose.
 */
export function configuredMcpResolverOptions(
  state: ConfiguredMcpState
): ResolveMcpServersOptions {
  return {
    importedStorePath:
      desktopConfigStoreFor(state.config)?.paths.mcpFile ?? null,
    // Read at each turn, so a change applies without a restart.
    resolveSettingsServers: () => legacySettingsServers(state),
    allowWorkspaceSpawnedServers: (cwd: string) => {
      try {
        const trust = state.agentPermissions?.getWorkspaceTrust(cwd)
        return trust?.state === "trusted" && trust.explicit === true
      } catch {
        return false
      }
    },
  }
}

/**
 * The configured MCP servers for a turn running in `cwd` (a project folder
 * or the thread's scratch workspace). With an empty `cwd` only the user's
 * own servers are listed.
 */
export function resolveConfiguredMcpServers(
  state: ConfiguredMcpState,
  cwd: string
): Promise<ReadonlyArray<PortableMcpServer>> {
  const options = configuredMcpResolverOptions(state)
  return resolvePortableMcpServers(
    cwd,
    cwd.trim() ? options : { ...options, resolveProjectServers: async () => [] }
  )
}

/** The prompt's view of resolved servers (the prompt lists their names). */
export function promptMcpsFromServers(
  servers: ReadonlyArray<PortableMcpServer>
): PromptMcp[] {
  return servers.map((server) =>
    server.transport === "stdio"
      ? { name: server.name, command: server.command, args: [...server.args] }
      : { name: server.name, command: server.url, args: [] }
  )
}
