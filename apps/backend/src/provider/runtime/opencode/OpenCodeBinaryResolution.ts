import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Resolves the `opencode` binary without launching it.
 *
 * Unlike `grok`, the name is specific to this product, so a PATH hit needs no
 * package-owner inspection. Known installer locations come first because
 * Finder-launched apps inherit a minimal PATH; the `.bun/bin` shim is where
 * `bun add -g opencode-ai` and the official installer put it.
 */
export interface ResolvedOpenCodeBinary {
  readonly binaryPath: string
  readonly source: "config" | "known-path" | "path"
}

const BINARY_NAME = "opencode"

export async function resolveOpenCodeBinaryAsync(
  configuredPath?: string | null
): Promise<ResolvedOpenCodeBinary | null> {
  const explicit = configuredPath?.trim()
  if (explicit && explicit !== BINARY_NAME) {
    const candidates = path.isAbsolute(explicit)
      ? [explicit]
      : withWindowsExtensions(explicit)
    for (const candidate of candidates) {
      if (await isRegularFile(candidate)) {
        return { binaryPath: path.normalize(candidate), source: "config" }
      }
    }
    return null
  }
  for (const candidate of knownBinaryPaths()) {
    if (await isRegularFile(candidate)) {
      return { binaryPath: path.normalize(candidate), source: "known-path" }
    }
  }
  for (const candidate of pathBinaryCandidates()) {
    if (await isRegularFile(candidate)) {
      return { binaryPath: path.normalize(candidate), source: "path" }
    }
  }
  return null
}

function knownBinaryPaths(): string[] {
  const home = os.homedir()
  const localAppData =
    process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming")
  if (process.platform === "win32") {
    return [
      path.join(home, ".bun", "bin", "opencode.exe"),
      path.join(home, ".local", "bin", "opencode.exe"),
      path.join(home, ".opencode", "bin", "opencode.exe"),
      path.join(home, ".cache", "opencode", "bin", "opencode.exe"),
      path.join(localAppData, "Programs", "opencode", "opencode.exe"),
      path.join(appData, "npm", "opencode.cmd"),
      path.join(appData, "npm", "opencode.exe"),
    ]
  }
  return [
    path.join(home, ".bun", "bin", "opencode"),
    path.join(home, ".local", "bin", "opencode"),
    path.join(home, ".opencode", "bin", "opencode"),
    path.join(home, ".cache", "opencode", "bin", "opencode"),
    path.join(home, ".npm-global", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
  ]
}

function pathBinaryCandidates(): string[] {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const out: string[] = []
  for (const dir of dirs) {
    for (const name of withWindowsExtensions(BINARY_NAME, true)) {
      out.push(path.resolve(dir, name))
    }
  }
  return out
}

function withWindowsExtensions(value: string, includeRaw = false): string[] {
  if (process.platform !== "win32") return [value]
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  const names: string[] = []
  if (
    lower.endsWith(".exe") ||
    lower.endsWith(".cmd") ||
    lower.endsWith(".bat")
  ) {
    return includeRaw ? [trimmed] : [trimmed]
  }
  // Prefer a real executable: a .cmd shim needs the cmd wrapper, while the
  // Bun/installer .exe can be spawned directly.
  names.push(`${trimmed}.exe`, `${trimmed}.cmd`, `${trimmed}.bat`)
  if (includeRaw) names.push(trimmed)
  return names
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile()
  } catch {
    return false
  }
}
