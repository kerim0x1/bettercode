import path from "node:path"
import type { ServerConfig } from "../../config"

export interface DesktopConfigPaths {
  readonly home: string
  readonly mcpFile: string
  readonly hooksFile: string
  readonly rulesFile: string
  readonly skillsDir: string
  readonly subagentsDir: string
}

export function desktopConfigPaths(home: string): DesktopConfigPaths {
  return {
    home,
    mcpFile: path.join(home, "mcp-servers.json"),
    hooksFile: path.join(home, "hooks.json"),
    rulesFile: path.join(home, "rules.md"),
    skillsDir: path.join(home, "skills"),
    subagentsDir: path.join(home, "subagents"),
  }
}

/**
 * The runtime home of `config`: `config.runtimeHome`, resolved once by
 * `createServerConfig` (config.ts `resolveRuntimeHome`). A configuration
 * built by hand without one (tests, a bare state double) keeps the standard
 * layout rule, `<home>/userdata` belongs to `<home>`, and otherwise has no
 * desktop configuration. Nothing here reads the environment.
 */
export function runtimeHomeOf(
  config: Pick<ServerConfig, "dataDir" | "runtimeHome">
): string | null {
  if (config.runtimeHome) return config.runtimeHome
  if (!config.dataDir) return null
  const resolved = path.resolve(config.dataDir)
  return path.basename(resolved).toLowerCase() === "userdata"
    ? path.dirname(resolved)
    : null
}
