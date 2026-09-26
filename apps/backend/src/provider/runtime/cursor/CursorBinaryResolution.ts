import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Trusted resolver for Cursor's agent CLI binary.
 *
 * The provider used to default to the bare command `agent`, which is not a
 * Cursor-specific name: on a machine with xAI's Grok Build installed, `agent`
 * resolves to `~/.grok/bin/agent.exe` instead. Probing it would run a foreign
 * coding agent with piped stdio — the same failure mode that once turned app
 * start into a process storm (see `GrokBinaryResolution`), and it also made
 * Cursor report "not installed" on machines where it was installed fine.
 *
 * Resolution is filesystem-only — nothing here spawns a process:
 *
 *  1. An explicit user-configured path is trusted when it points at a file.
 *  2. Cursor's installer locations are trusted.
 *  3. `cursor-agent` found on PATH is trusted: the name is vendor-specific.
 *  4. A bare `agent` on PATH is trusted ONLY when its shim text provably
 *     belongs to Cursor. Anything else — notably Grok's `agent` — is rejected.
 */
export interface ResolvedCursorBinary {
  readonly binaryPath: string
  readonly source: "config" | "cursor-home" | "path" | "path-shim"
}

/** The unambiguous, vendor-prefixed name the Cursor installer ships. */
export const CURSOR_BINARY_NAME = "cursor-agent"
/** The legacy bare name; usable only after shim verification. */
const AMBIGUOUS_BINARY_NAME = "agent"

const CURSOR_PACKAGE_MARKER = /cursor-agent|@cursor[\\/]+|cursor\.com/i
const NUL_BYTE = String.fromCharCode(0)

function isWindows(): boolean {
  return process.platform === "win32"
}

function executableNames(base: string): string[] {
  return isWindows()
    ? [`${base}.exe`, `${base}.cmd`, `${base}.ps1`, base]
    : [base]
}

/**
 * Directories the Cursor CLI installer writes to. `~/.local/bin` is the
 * documented target of `curl https://cursor.com/install | bash`.
 */
function cursorHomeDirectories(): string[] {
  const home = os.homedir()
  const directories = [
    path.join(home, ".local", "bin"),
    path.join(home, ".cursor", "bin"),
  ]
  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      directories.push(
        path.join(localAppData, "Programs", "cursor-agent"),
        path.join(localAppData, "Programs", "cursor-agent", "bin"),
        path.join(localAppData, "cursor-agent"),
        path.join(localAppData, "cursor-agent", "bin")
      )
    }
  }
  return directories
}

function pathDirectories(): string[] {
  return (process.env.PATH ?? "").split(isWindows() ? ";" : ":").filter(Boolean)
}

export function resolveCursorBinary(
  configuredPath?: string | null
): ResolvedCursorBinary | null {
  const explicit = configuredPath?.trim()
  if (
    explicit &&
    explicit !== AMBIGUOUS_BINARY_NAME &&
    explicit !== CURSOR_BINARY_NAME
  ) {
    // A relative path would be resolved again from the workspace cwd at spawn
    // time. Accept only an absolute file, the same rule the Grok resolver uses.
    if (path.isAbsolute(explicit) && isRegularFile(explicit)) {
      return { binaryPath: path.resolve(explicit), source: "config" }
    }
    return null
  }

  for (const directory of cursorHomeDirectories()) {
    for (const name of executableNames(CURSOR_BINARY_NAME)) {
      const candidate = path.join(directory, name)
      if (isRegularFile(candidate)) {
        return { binaryPath: path.resolve(candidate), source: "cursor-home" }
      }
    }
  }

  for (const directory of pathDirectories()) {
    for (const name of executableNames(CURSOR_BINARY_NAME)) {
      const candidate = path.join(directory, name)
      if (isRegularFile(candidate)) {
        return { binaryPath: path.resolve(candidate), source: "path" }
      }
    }
  }

  return verifiedAmbiguousShim()
}

export async function resolveCursorBinaryAsync(
  configuredPath?: string | null
): Promise<ResolvedCursorBinary | null> {
  const explicit = configuredPath?.trim()
  if (
    explicit &&
    explicit !== AMBIGUOUS_BINARY_NAME &&
    explicit !== CURSOR_BINARY_NAME
  ) {
    if (path.isAbsolute(explicit) && (await isRegularFileAsync(explicit))) {
      return { binaryPath: path.resolve(explicit), source: "config" }
    }
    return null
  }

  for (const directory of cursorHomeDirectories()) {
    for (const name of executableNames(CURSOR_BINARY_NAME)) {
      const candidate = path.join(directory, name)
      if (await isRegularFileAsync(candidate)) {
        return { binaryPath: path.resolve(candidate), source: "cursor-home" }
      }
    }
  }

  for (const directory of pathDirectories()) {
    for (const name of executableNames(CURSOR_BINARY_NAME)) {
      const candidate = path.join(directory, name)
      if (await isRegularFileAsync(candidate)) {
        return { binaryPath: path.resolve(candidate), source: "path" }
      }
    }
  }

  return verifiedAmbiguousShimAsync()
}

/**
 * The first `agent` on PATH decides, exactly as the shell would. If it does
 * not belong to Cursor we return null rather than scanning on, so we never run
 * a different binary than the user's own shell would.
 */
function verifiedAmbiguousShim(): ResolvedCursorBinary | null {
  for (const directory of pathDirectories()) {
    for (const name of executableNames(AMBIGUOUS_BINARY_NAME)) {
      const candidate = path.join(directory, name)
      if (!isRegularFile(candidate)) continue
      return isVerifiedCursorShim(candidate)
        ? { binaryPath: path.resolve(candidate), source: "path-shim" }
        : null
    }
  }
  return null
}

async function verifiedAmbiguousShimAsync(): Promise<ResolvedCursorBinary | null> {
  for (const directory of pathDirectories()) {
    for (const name of executableNames(AMBIGUOUS_BINARY_NAME)) {
      const candidate = path.join(directory, name)
      if (!(await isRegularFileAsync(candidate))) continue
      return (await isVerifiedCursorShimAsync(candidate))
        ? { binaryPath: path.resolve(candidate), source: "path-shim" }
        : null
    }
  }
  return null
}

/**
 * Shims are small text scripts naming the package they launch. Compiled
 * executables contain NUL bytes in their first 4 KiB and cannot be inspected,
 * so they are rejected — only a vendor-named file may be a native binary.
 */
function isVerifiedCursorShim(shimPath: string): boolean {
  const text = readHead(shimPath)
  if (text === null || text.includes(NUL_BYTE)) return false
  return CURSOR_PACKAGE_MARKER.test(text)
}

async function isVerifiedCursorShimAsync(shimPath: string): Promise<boolean> {
  const text = await readHeadAsync(shimPath)
  if (text === null || text.includes(NUL_BYTE)) return false
  return CURSOR_PACKAGE_MARKER.test(text)
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
