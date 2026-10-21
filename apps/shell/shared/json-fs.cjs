/**
 * Synchronous JSON + text fs helpers used by the main-process handlers.
 *
 * Three consumers (`cli-scanner.cjs`, `onboarding-ipc.cjs`,
 * `plugin-manager.cjs`) each had their own inline copy with subtly
 * different signatures — one returned `null` on missing, another took
 * a `fallback` param, a third threw. Centralizing here removes that
 * drift: callers pick the fallback and an optional warn tag.
 *
 * These are still `fs.*Sync` calls and block their caller (the `*Async`
 * readers are the fs/promises equivalents for scans). JSON reads are
 * size-bounded; JSON writes stage, fsync, and rename a private temporary
 * file. Atomic replacement prevents partial files, but does not coordinate
 * read-modify-write transactions with other processes. Text helpers are
 * bounded and atomically replaced using the same staging path.
 */

const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024

function readBoundedRegularFile(filePath, maxBytes) {
  const initial = fs.lstatSync(filePath)
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size > maxBytes
  ) {
    throw new Error(`Unsafe or oversized JSON file: ${filePath}`)
  }

  const noFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = fs.fstatSync(handle)
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      // On Windows, path stat() and handle fstat() may expose different
      // device values for the same NTFS entry. The inode/file index is the
      // stable identity there; POSIX requires the device as well.
      (process.platform !== "win32" && opened.dev !== initial.dev) ||
      opened.ino !== initial.ino
    ) {
      throw new Error(`JSON file changed while opening: ${filePath}`)
    }

    const bytes = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(
        handle,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (read === 0) break
      offset += read
    }
    if (offset !== bytes.length) {
      throw new Error(`JSON file was truncated while reading: ${filePath}`)
    }
    return bytes
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * `readBoundedRegularFile` on fs/promises: the same no-follow, size and
 * identity checks, without blocking the caller's thread while it reads.
 */
async function readBoundedRegularFileAsync(filePath, maxBytes) {
  const initial = await fs.promises.lstat(filePath)
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size > maxBytes
  ) {
    throw new Error(`Unsafe or oversized JSON file: ${filePath}`)
  }

  const noFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      (process.platform !== "win32" && opened.dev !== initial.dev) ||
      opened.ino !== initial.ino
    ) {
      throw new Error(`JSON file changed while opening: ${filePath}`)
    }

    const bytes = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== bytes.length) {
      throw new Error(`JSON file was truncated while reading: ${filePath}`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function fsyncDirectoryBestEffort(directory) {
  if (process.platform === "win32") return
  let handle
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
 * Read + JSON.parse a file. Returns `fallback` if the file is missing
 * or the content is invalid JSON. Pass `opts.warn` (a short tag) to
 * have parse/read failures logged; missing files are always silent
 * since that's an expected first-launch path.
 */
function readJson(filePath, fallback = null, opts) {
  try {
    const maxBytes = Math.max(
      1,
      Math.min(
        Number(opts?.maxBytes) || DEFAULT_MAX_JSON_BYTES,
        DEFAULT_MAX_JSON_BYTES,
      ),
    )
    return JSON.parse(readBoundedRegularFile(filePath, maxBytes).toString("utf-8"))
  } catch (err) {
    if (err?.code === "ENOENT") return fallback
    if (opts?.warn) {
      console.warn(
        `[${opts.warn}] failed to read JSON at ${filePath}:`,
        err?.message || err,
      )
    }
    if (opts?.strict) throw err
    return fallback
  }
}

/** `readJson` on fs/promises (same fallback, warn and strict options). */
async function readJsonAsync(filePath, fallback = null, opts) {
  try {
    const maxBytes = Math.max(
      1,
      Math.min(
        Number(opts?.maxBytes) || DEFAULT_MAX_JSON_BYTES,
        DEFAULT_MAX_JSON_BYTES,
      ),
    )
    const bytes = await readBoundedRegularFileAsync(filePath, maxBytes)
    return JSON.parse(bytes.toString("utf-8"))
  } catch (err) {
    if (err?.code === "ENOENT") return fallback
    if (opts?.warn) {
      console.warn(
        `[${opts.warn}] failed to read JSON at ${filePath}:`,
        err?.message || err,
      )
    }
    if (opts?.strict) throw err
    return fallback
  }
}

/**
 * Ensures the parent dir exists, then JSON-stringifies `value` with
 * 2-space indent and writes. Lets exceptions propagate — the caller
 * chose to attempt a write, if it fails they want to know.
 */
function writeJson(filePath, value, opts) {
  writeBytes(filePath, Buffer.from(JSON.stringify(value, null, 2), "utf-8"), opts)
}

function writeBytes(filePath, bytes, opts) {
  const directory = path.dirname(filePath)
  const maxBytes = Math.max(
    1,
    Math.min(
      Number(opts?.maxBytes) || DEFAULT_MAX_JSON_BYTES,
      DEFAULT_MAX_JSON_BYTES,
    ),
  )
  if (bytes.length > maxBytes) {
    throw new Error(`File output exceeds ${maxBytes} bytes: ${filePath}`)
  }

  fs.mkdirSync(directory, { recursive: true })
  const stagedPath = path.join(
    directory,
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  )
  let handle
  let ownsStagedPath = false
  try {
    handle = fs.openSync(
      stagedPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL,
      opts?.mode ?? 0o600,
    )
    ownsStagedPath = true
    let offset = 0
    while (offset < bytes.length) {
      offset += fs.writeSync(
        handle,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
    }
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = undefined
    fs.renameSync(stagedPath, filePath)
    fsyncDirectoryBestEffort(directory)
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle)
      } catch {
        // The original error remains authoritative.
      }
    }
    if (ownsStagedPath) fs.rmSync(stagedPath, { force: true })
  }
}

/**
 * Read a file as UTF-8 text. Returns `fallback` if missing or
 * unreadable. `opts.warn` enables warning logs on unexpected errors.
 */
function readText(filePath, fallback = "", opts) {
  try {
    const maxBytes = Math.max(
      1,
      Math.min(Number(opts?.maxBytes) || DEFAULT_MAX_JSON_BYTES, DEFAULT_MAX_JSON_BYTES),
    )
    return readBoundedRegularFile(filePath, maxBytes).toString("utf-8")
  } catch (err) {
    if (err?.code === "ENOENT") return fallback
    if (opts?.warn) {
      console.warn(
        `[${opts.warn}] failed to read text at ${filePath}:`,
        err?.message || err,
      )
    }
    if (opts?.strict) throw err
  }
  return fallback
}

/** Atomically replaces bounded UTF-8 text, using private staged-file mode. */
function writeText(filePath, value, opts) {
  const text = value ?? ""
  if (typeof text !== "string") throw new Error("Text content must be a string")
  writeBytes(filePath, Buffer.from(text, "utf-8"), opts)
}

module.exports = {
  readJson,
  readJsonAsync,
  writeJson,
  readText,
  writeText,
  readBoundedRegularFile,
  readBoundedRegularFileAsync,
}
