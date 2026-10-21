import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { HttpError } from "../../errors"

/**
 * File primitives of the desktop configuration store: bounded no-follow
 * reads, atomic replacement (staged file, fsync, rename) and a per-file
 * write lock. Every operation is synchronous, so one read-check-write runs
 * without interleaving inside this process; the lock file additionally
 * keeps a second process (another backend on the same profile) out of the
 * same file for the duration of a write.
 */

/** Revision of a file that does not exist. */
export const ABSENT_REVISION = "absent"

/** Locks older than this belong to a writer that died; they are broken. */
const STALE_LOCK_MS = 30_000

export function revisionOf(bytes: Buffer | null): string {
  if (bytes === null) return ABSENT_REVISION
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

/** A file that exists but may not be read or replaced (symlink, too large). */
export class UnsafeConfigFileError extends HttpError {
  constructor(file: string, reason: string) {
    super(
      409,
      `${path.basename(file)} cannot be used: ${reason}. Move it aside and try again.`,
      "desktop_config_unsafe"
    )
    this.name = "UnsafeConfigFileError"
  }
}

/**
 * The bytes of a regular file, `null` when it does not exist. A symlink, a
 * directory or a file over `maxBytes` throws `UnsafeConfigFileError`: the
 * configuration files are never followed out of the runtime home, and an
 * oversized one is not loaded into memory.
 */
export function readRegularFile(file: string, maxBytes: number): Buffer | null {
  let initial: fs.Stats
  try {
    initial = fs.lstatSync(file)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (initial.isSymbolicLink()) {
    throw new UnsafeConfigFileError(file, "it is a symbolic link")
  }
  if (!initial.isFile()) {
    throw new UnsafeConfigFileError(file, "it is not a regular file")
  }
  if (initial.size > maxBytes) {
    throw new UnsafeConfigFileError(file, `it is larger than ${maxBytes} bytes`)
  }
  const noFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  let handle: number
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try {
    const opened = fs.fstatSync(handle)
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      // Windows reports different device numbers for lstat and fstat of the
      // same file; the file index (ino) is the stable identity there.
      (process.platform !== "win32" && opened.dev !== initial.dev) ||
      opened.ino !== initial.ino
    ) {
      throw new UnsafeConfigFileError(file, "it changed while it was opened")
    }
    const bytes = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(
        handle,
        bytes,
        offset,
        bytes.length - offset,
        offset
      )
      if (read === 0) break
      offset += read
    }
    return offset === bytes.length ? bytes : bytes.subarray(0, offset)
  } finally {
    fs.closeSync(handle)
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  if (process.platform === "win32") return
  let handle: number | undefined
  try {
    handle = fs.openSync(directory, fs.constants.O_RDONLY)
    fs.fsyncSync(handle)
  } catch {
    // Directory fsync is unavailable on some filesystems.
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle)
      } catch {
        // Best-effort durability only.
      }
    }
  }
}

/**
 * Replace `file` with `bytes` atomically: a private staged file in the same
 * directory is written, fsynced and renamed over the target, so a reader
 * sees either the old or the new content, never a partial one.
 */
export function writeFileAtomic(file: string, bytes: Buffer): void {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true })
  const staged = path.join(
    directory,
    `.${path.basename(file)}.${randomUUID()}.tmp`
  )
  let handle: number | undefined
  let ownsStaged = false
  try {
    handle = fs.openSync(
      staged,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    )
    ownsStaged = true
    let offset = 0
    while (offset < bytes.length) {
      offset += fs.writeSync(handle, bytes, offset, bytes.length - offset)
    }
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = undefined
    fs.renameSync(staged, file)
    ownsStaged = false
    fsyncDirectoryBestEffort(directory)
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle)
      } catch {
        // The original error remains authoritative.
      }
    }
    if (ownsStaged) fs.rmSync(staged, { force: true })
  }
}

/** Keep the unreadable content of `file` next to it before it is replaced. */
export function backUpUnreadableFile(file: string, bytes: Buffer): string {
  const backup = `${file}.corrupt-${randomUUID()}`
  const handle = fs.openSync(backup, "wx", 0o600)
  try {
    fs.writeFileSync(handle, bytes)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  return backup
}

/**
 * Run `operation` while holding `<lockFile>`. The lock is a file created
 * exclusively; a second writer gets `409 desktop_config_busy` and retries.
 * A lock left behind by a writer that died is broken after 30 seconds.
 */
export function withFileLock<T>(lockFile: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  let fd: number
  try {
    fd = fs.openSync(lockFile, "wx", 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    let stale = false
    try {
      stale = Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS
    } catch {
      // The lock disappeared between open and stat; take it below.
      stale = true
    }
    if (!stale) {
      throw new HttpError(
        409,
        `${path.basename(lockFile, ".lock")} is being written by another process; retry shortly.`,
        "desktop_config_busy"
      )
    }
    try {
      fs.rmSync(lockFile, { force: true })
      fd = fs.openSync(lockFile, "wx", 0o600)
    } catch {
      throw new HttpError(
        409,
        `Could not recover the stale lock of ${path.basename(lockFile, ".lock")}; retry shortly.`,
        "desktop_config_busy"
      )
    }
  }
  try {
    return operation()
  } finally {
    try {
      fs.closeSync(fd)
    } finally {
      try {
        fs.rmSync(lockFile, { force: true })
      } catch {
        // A stale lock is broken by the next writer.
      }
    }
  }
}
