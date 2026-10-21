import fs from "node:fs"
import path from "node:path"
import { resolveExecutableOnPath } from "../../../security/executablePath"

/**
 * The Codex executable to launch, as an absolute path whenever one exists.
 *
 * A configured path wins; the bare default `codex` becomes the executable
 * Electron found (macOS, where Finder supplies a minimal PATH) or the one on
 * PATH. Codex runs with the workspace as cwd, usually through `cmd.exe /c`
 * on Windows, and both libuv and cmd look in the cwd before PATH for a bare
 * name, so a `codex.cmd` committed to a repository would otherwise run.
 * When nothing is found the bare name is returned and the launch fails as
 * before; cmd-wrapped launches also carry `NoDefaultCurrentDirectoryInExePath`
 * (see sanitizedChildEnvironment), so even then the cwd is not searched.
 */
export function codexBinaryPath(configuredPath?: string | null): string {
  const configured = configuredPath?.trim()
  if (configured && configured !== "codex") {
    return isBareCommandName(configured)
      ? (resolveExecutableOnPath(configured, { allowScripts: true }) ??
          configured)
      : configured
  }
  const fromHost = process.env.BETTERC0DE_CODEX_CLI_PATH?.trim()
  if (fromHost) return fromHost
  return resolveExecutableOnPath("codex", { allowScripts: true }) ?? "codex"
}

function isBareCommandName(value: string): boolean {
  return !/[\\/]/.test(value) && !path.isAbsolute(value)
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
