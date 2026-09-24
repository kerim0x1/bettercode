import fs from "node:fs"
import path from "node:path"

/** Use the executable found by Electron when Finder supplied a minimal PATH. */
export function codexBinaryPath(configuredPath?: string | null): string {
  const configured = configuredPath?.trim()
  if (configured && configured !== "codex") return configured
  return process.env.BETTERC0DE_CODEX_CLI_PATH?.trim() || "codex"
}

/** npm's Codex launcher uses /usr/bin/env node; keep its Node visible on macOS. */
export function codexProcessEnvironment(
  binaryPath: string,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  if (process.platform !== "darwin" || !path.isAbsolute(binaryPath)) return env
  const dirs = [
    path.dirname(binaryPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((dir) => {
    try {
      fs.accessSync(path.join(dir, "node"), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  if (dirs.length === 0) return env
  return {
    ...env,
    PATH: [
      ...new Set([
        ...(env.PATH ?? process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean),
        ...dirs,
      ]),
    ].join(path.delimiter),
  }
}
