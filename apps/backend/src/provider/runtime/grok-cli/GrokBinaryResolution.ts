import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Trusted resolver for xAI's Grok Build CLI binary.
 *
 * INCIDENT CONTEXT (2026-07-21): the binary name `grok` is NOT unique. On the
 * dev machine, PATH resolved `grok` to the unrelated npm package `grok-dev` —
 * an interactive Bun/OpenTUI *coding agent*. Blind-spawning it for version
 * probes and `grok agent stdio` launched a foreign AI agent with piped stdio;
 * Windows timeout kills only reach the cmd wrapper, not the Bun process tree
 * underneath, so every probe leaked live processes and the app start turned
 * into a process storm.
 *
 * Therefore: NOTHING in the Grok provider may spawn a binary this module has
 * not verified. Verification is filesystem-only (no spawning):
 *
 *  1. An explicit, user-configured absolute path is trusted as-is (the user
 *     opted in deliberately).
 *  2. `~/.grok/bin/grok(.exe)` — the xAI installer's canonical location — is
 *     trusted.
 *  3. A bare `grok` found on PATH or a known macOS install directory is
 *     trusted ONLY when its shim or symlink provably targets the
 *     `@xai-official/grok` package. Any other owner is rejected.
 */
export interface ResolvedGrokBinary {
  readonly binaryPath: string
  readonly source: "config" | "xai-home" | "path-shim"
}

const XAI_PACKAGE_MARKER = /@xai-official[\\/]+grok/i
const XAI_PACKAGE_PATH =
  /(?:^|[\\/])node_modules[\\/]@xai-official[\\/]grok(?:[\\/]|$)/i
const NUL_BYTE = String.fromCharCode(0)

export function resolveGrokBinary(
  configuredPath?: string | null
): ResolvedGrokBinary | null {
  const explicit = configuredPath?.trim()
  if (explicit && explicit !== "grok") {
    // Explicit user configuration: honor it when it points at a real file.
    if (path.isAbsolute(explicit) && isRegularFile(explicit)) {
      return { binaryPath: path.normalize(explicit), source: "config" }
    }
    return null
  }

  const home = xaiHomeBinary()
  if (home) return { binaryPath: home, source: "xai-home" }

  const shim = verifiedPathShim()
  if (shim) return { binaryPath: shim, source: "path-shim" }

  return null
}

export async function resolveGrokBinaryAsync(
  configuredPath?: string | null
): Promise<ResolvedGrokBinary | null> {
  const explicit = configuredPath?.trim()
  if (explicit && explicit !== "grok") {
    if (path.isAbsolute(explicit) && (await isRegularFileAsync(explicit))) {
      return { binaryPath: path.normalize(explicit), source: "config" }
    }
    return null
  }

  const home = await xaiHomeBinaryAsync()
  if (home) return { binaryPath: home, source: "xai-home" }

  const shim = await verifiedPathShimAsync()
  if (shim) return { binaryPath: shim, source: "path-shim" }

  return null
}

function xaiHomeBinary(): string | null {
  const base = path.join(os.homedir(), ".grok", "bin")
  const candidates =
    process.platform === "win32"
      ? [path.join(base, "grok.exe"), path.join(base, "grok.cmd")]
      : [path.join(base, "grok")]
  for (const candidate of candidates) {
    if (isRegularFile(candidate)) return candidate
  }
  return null
}

async function xaiHomeBinaryAsync(): Promise<string | null> {
  const base = path.join(os.homedir(), ".grok", "bin")
  const candidates =
    process.platform === "win32"
      ? [path.join(base, "grok.exe"), path.join(base, "grok.cmd")]
      : [path.join(base, "grok")]
  for (const candidate of candidates) {
    if (await isRegularFileAsync(candidate)) return candidate
  }
  return null
}

function verifiedPathShim(): string | null {
  const isWin = process.platform === "win32"
  const names = isWin ? ["grok.cmd", "grok.ps1", "grok"] : ["grok"]
  for (const dir of binarySearchDirectories()) {
    for (const name of names) {
      const candidate = path.resolve(dir, name)
      if (!isRegularFile(candidate)) continue
      if (isVerifiedXaiShim(candidate)) return path.normalize(candidate)
      // First PATH hit decides — if the frontmost `grok` belongs to another
      // package we must NOT keep scanning and accidentally run a different
      // binary than the shell would.
      return null
    }
  }
  return null
}

async function verifiedPathShimAsync(): Promise<string | null> {
  const isWin = process.platform === "win32"
  const names = isWin ? ["grok.cmd", "grok.ps1", "grok"] : ["grok"]
  for (const dir of binarySearchDirectories()) {
    for (const name of names) {
      const candidate = path.resolve(dir, name)
      if (!(await isRegularFileAsync(candidate))) continue
      if (await isVerifiedXaiShimAsync(candidate)) {
        return path.normalize(candidate)
      }
      return null
    }
  }
  return null
}

function binarySearchDirectories(): string[] {
  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
  if (process.platform !== "darwin") return pathDirs

  // Finder starts apps with a minimal PATH; include common user and Homebrew
  // install locations while still verifying the package owner below.
  const home = os.homedir()
  return [
    ...new Set([
      ...pathDirs,
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".bun", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]),
  ]
}

/**
 * npm on Unix commonly links the package entry file directly. Other package
 * managers use text shims that name the target package. Both checks are
 * filesystem-only and leave unrelated executables untrusted.
 */
function isVerifiedXaiShim(shimPath: string): boolean {
  try {
    if (fs.lstatSync(shimPath).isSymbolicLink()) {
      return XAI_PACKAGE_PATH.test(fs.realpathSync(shimPath))
    }
  } catch {
    return false
  }
  const text = readHead(shimPath)
  if (text === null) return false
  // Compiled executables (PE/ELF/Mach-O) contain NUL bytes in the first
  // 4 KiB — those aren't inspectable shims, so reject them; only the trusted
  // xAI home location may provide a native binary.
  if (text.includes(NUL_BYTE)) return false
  return XAI_PACKAGE_MARKER.test(text)
}

async function isVerifiedXaiShimAsync(shimPath: string): Promise<boolean> {
  try {
    if ((await fs.promises.lstat(shimPath)).isSymbolicLink()) {
      return XAI_PACKAGE_PATH.test(await fs.promises.realpath(shimPath))
    }
  } catch {
    return false
  }
  const text = await readHeadAsync(shimPath)
  if (text === null || text.includes(NUL_BYTE)) return false
  return XAI_PACKAGE_MARKER.test(text)
}

function readHead(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r")
    try {
      const buffer = Buffer.alloc(4096)
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytes).toString("utf8")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

async function readHeadAsync(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(filePath, "r")
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

async function isRegularFileAsync(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile()
  } catch {
    return false
  }
}
