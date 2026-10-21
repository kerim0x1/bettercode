// @ts-check
/**
 * Size-capped, rotating application log for packaged builds, which have no
 * attached console. Lines are buffered in memory and appended in batches so
 * a chatty backend cannot turn every console call into a disk write; a
 * synchronous flush runs at shutdown and on fatal errors.
 *
 * Layout: `<directory>/<fileName>` is the active file, `<fileName>.1` …
 * `<fileName>.<maxFiles - 1>` are older generations. With the defaults the
 * log never exceeds 3 × 5 MB on disk.
 *
 * Callers pass already-redacted lines. Write failures are swallowed and
 * reported once on stderr: the log must never take the app down, and it must
 * not log through `console`, which feeds this file.
 */

const fs = require("node:fs")
const path = require("node:path")

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_FILES = 3
const DEFAULT_FLUSH_INTERVAL_MS = 1_000
const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024
/** Hard cap while the disk is slow or failing; older lines are dropped. */
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024

/**
 * @typedef {object} RotatingLogFileOptions
 * @property {string} directory Absolute directory of the log.
 * @property {string} [fileName]
 * @property {number} [maxBytes] Size of one generation before it rotates.
 * @property {number} [maxFiles] Generations kept, the active file included.
 * @property {number} [flushIntervalMs]
 * @property {number} [maxBufferedBytes] Buffered bytes that trigger an immediate flush.
 * @property {number} [maxPendingBytes] Cap while the disk is slow; older lines are dropped.
 * @property {typeof fs} [fsImpl]
 * @property {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [timers]
 * @property {(message: string) => void} [reportFailure]
 */

/**
 * @typedef {object} RotatingLogFile
 * @property {string} path The active file.
 * @property {string} directory
 * @property {(line: unknown) => void} write Buffer one (already redacted) line.
 * @property {() => Promise<void>} flush
 * @property {() => void} flushSync For shutdown and fatal paths.
 * @property {() => void} close Flush synchronously and stop accepting lines.
 */

/**
 * @param {RotatingLogFileOptions} options
 * @returns {RotatingLogFile}
 */
function createRotatingLogFile({
  directory,
  fileName = "app.log",
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
  fsImpl = fs,
  timers = { setTimeout, clearTimeout },
  reportFailure = (message) => {
    try { process.stderr.write(`[electron] ${message}\n`) } catch { /* no console */ }
  },
} = /** @type {RotatingLogFileOptions} */ ({})) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new TypeError("The log directory must be an absolute path")
  }
  const filePath = path.join(directory, fileName)
  const generations = Math.max(1, Math.floor(maxFiles))
  const maxLineBytes = Math.max(1024, Math.floor(maxBytes / 4))

  /** @type {string[]} */
  let pending = []
  let pendingBytes = 0
  let droppedLines = 0
  /** @type {number | null} Bytes in the active file; null until (re)read. */
  let currentSize = null
  /** @type {NodeJS.Timeout | null} */
  let timer = null
  /** @type {Promise<void>} */
  let chain = Promise.resolve()
  let disabled = false
  let closed = false
  let consecutiveFailures = 0

  /** @param {number} index */
  function generationPath(index) {
    return index === 0 ? filePath : `${filePath}.${index}`
  }

  /** @returns {number} the active file's size */
  function ensureReady() {
    if (currentSize !== null) return currentSize
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      currentSize = fsImpl.statSync(filePath).size
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw error
      currentSize = 0
    }
    return currentSize
  }

  function rotate() {
    for (let index = generations - 1; index >= 1; index -= 1) {
      const from = generationPath(index - 1)
      const to = generationPath(index)
      try {
        if (index === generations - 1) fsImpl.rmSync(to, { force: true })
        fsImpl.renameSync(from, to)
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw error
      }
    }
    if (generations === 1) fsImpl.rmSync(filePath, { force: true })
    currentSize = 0
  }

  /** @returns {string | null} the buffered lines as one chunk */
  function takePending() {
    if (pending.length === 0 && droppedLines === 0) return null
    const lines = pending
    if (droppedLines > 0) {
      lines.unshift(`[log] ${droppedLines} line(s) dropped while the log file was unavailable`)
      droppedLines = 0
    }
    pending = []
    pendingBytes = 0
    return `${lines.join("\n")}\n`
  }

  /** @param {unknown} error */
  function recordFailure(error) {
    consecutiveFailures += 1
    if (consecutiveFailures >= 3 && !disabled) {
      disabled = true
      pending = []
      pendingBytes = 0
      reportFailure(
        `Application log disabled after repeated write failures: ${/** @type {{ message?: unknown } | null | undefined} */ (error)?.message ?? error}`,
      )
    }
  }

  /**
   * @param {string} data
   * @returns {number} its size in bytes
   */
  function prepareWrite(data) {
    const size = ensureReady()
    const bytes = Buffer.byteLength(data)
    if (size > 0 && size + bytes > maxBytes) rotate()
    return bytes
  }

  async function flushOnce() {
    if (disabled) return
    const data = takePending()
    if (!data) return
    try {
      const bytes = prepareWrite(data)
      await fsImpl.promises.appendFile(filePath, data, { mode: 0o600 })
      currentSize = /** @type {number} */ (currentSize) + bytes
      consecutiveFailures = 0
    } catch (error) {
      // Re-read the size next time; a failed append may have written part.
      currentSize = null
      recordFailure(error)
    }
  }

  /** @param {number} delayMs */
  function scheduleFlush(delayMs) {
    if (timer || closed || disabled) return
    timer = timers.setTimeout(() => {
      timer = null
      void flush()
    }, delayMs)
    timer?.unref?.()
  }

  /** @param {unknown} line */
  function write(line) {
    if (disabled || closed) return
    let text = typeof line === "string" ? line : String(line)
    if (Buffer.byteLength(text) > maxLineBytes) {
      text = `${text.slice(0, maxLineBytes)} …[truncated]`
    }
    const bytes = Buffer.byteLength(text) + 1
    pending.push(text)
    pendingBytes += bytes
    while (pendingBytes > maxPendingBytes && pending.length > 1) {
      pendingBytes -= Buffer.byteLength(/** @type {string} */ (pending.shift())) + 1
      droppedLines += 1
    }
    scheduleFlush(pendingBytes >= maxBufferedBytes ? 0 : flushIntervalMs)
  }

  function flush() {
    if (timer) {
      timers.clearTimeout(timer)
      timer = null
    }
    chain = chain.then(flushOnce, flushOnce)
    return chain
  }

  /** For shutdown and fatal paths, where no further event-loop turn is certain. */
  function flushSync() {
    if (timer) {
      timers.clearTimeout(timer)
      timer = null
    }
    if (disabled) return
    const data = takePending()
    if (!data) return
    try {
      const bytes = prepareWrite(data)
      fsImpl.appendFileSync(filePath, data, { mode: 0o600 })
      currentSize = /** @type {number} */ (currentSize) + bytes
    } catch (error) {
      currentSize = null
      recordFailure(error)
    }
  }

  function close() {
    flushSync()
    closed = true
  }

  return { path: filePath, directory, write, flush, flushSync, close }
}

module.exports = { createRotatingLogFile }
