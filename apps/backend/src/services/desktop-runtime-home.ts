import path from "node:path"

/**
 * The desktop's settings folder: `rules.md`, `mcp-servers.json`,
 * `hooks.json`, and the `skills` and `subagents` folders the desktop app
 * keeps (apps/shell/shared/runtime-paths.cjs). `BETTERC0DE_HOME` names it;
 * otherwise the desktop starts this backend with its data folder inside it
 * (`<home>/userdata`). A backend started some other way has none.
 */
export function desktopRuntimeHome(dataDir: string): string | null {
  const configuredHome = process.env.BETTERC0DE_HOME?.trim()
  if (configuredHome && path.isAbsolute(configuredHome)) {
    return path.resolve(configuredHome)
  }
  const resolved = path.resolve(dataDir)
  return path.basename(resolved).toLowerCase() === "userdata"
    ? path.dirname(resolved)
    : null
}
