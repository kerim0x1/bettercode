const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

function isBackendBuildFile(filename) {
  return (
    typeof filename === "string" &&
    (filename.endsWith(".js") || filename.endsWith(".cjs"))
  )
}

/**
 * Content digest of the emitted backend bundle.
 *
 * Why content and not "a file was written": `npm run dev` compiles the backend
 * once (`build:backend`) and THEN starts `tsc --watch`, whose initial pass
 * rewrites every file in `dist/` with byte-identical output a few seconds after
 * Electron has already booted the backend from it. Watching for writes alone
 * therefore guaranteed a spurious backend restart on every single cold start —
 * and the restart window is not free: the renderer gets ERR_CONNECTION_REFUSED
 * for every in-flight call, pollers retry, and requests caught in the shutdown
 * drain have been observed taking >8s. That is the "everything hangs / takes
 * forever to load" symptom.
 *
 * Hashing only the files the reloader already cares about keeps this cheap
 * (a few hundred small files, debounced, dev-only).
 */
function computeBuildDigest(directory, { readdirSync = fs.readdirSync, readFileSync = fs.readFileSync } = {}) {
  const hash = crypto.createHash("sha1")
  let entries
  try {
    entries = readdirSync(directory, { recursive: true, withFileTypes: true })
  } catch {
    // Directory missing (first build still running) — treat as "no build yet"
    // rather than throwing; the next event recomputes.
    return null
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !isBackendBuildFile(entry.name)) continue
    // `parentPath` on Node 20.12+/22, `path` on older — both give the dir.
    const parent = entry.parentPath ?? entry.path ?? directory
    files.push(path.join(parent, entry.name))
  }
  // Stable order so the digest does not depend on filesystem enumeration.
  files.sort()
  for (const file of files) {
    hash.update(file)
    try {
      hash.update(readFileSync(file))
    } catch {
      // A file vanishing mid-walk means the build is still moving; fold the
      // absence into the digest so the next settled state differs.
      hash.update("<unreadable>")
    }
  }
  return hash.digest("hex")
}

/**
 * Restarts the backend when the compiled output it runs from changes.
 *
 * `directories` lists every build the backend loads at runtime: its own
 * `dist/` and the workspace packages it requires from theirs
 * (`@betterc0de/schema`). Watching only the backend missed schema changes,
 * so a new settings field was rejected as unknown until a full restart.
 */
function createBackendDevReloader({
  directory,
  directories = [directory],
  onReload,
  debounceMs = 300,
  watch = fs.watch,
  onError = (err) => console.error("[dev] backend reload failed:", err),
  digest = computeBuildDigest,
  onSkip = () =>
    console.log(
      "[dev] backend rebuild produced identical output — skipping restart",
    ),
}) {
  let timer = null
  let reloadRunning = false
  let reloadQueued = false
  let closed = false
  // One digest over every watched build; a directory that cannot be read
  // makes the whole digest null, which never matches.
  const digestAll = () => {
    const parts = directories.map((dir) => digest(dir))
    return parts.includes(null) ? null : parts.join(":")
  }
  // Baseline taken at construction: the state Electron just booted from.
  let lastDigest = digestAll()

  const runReload = async () => {
    timer = null
    if (closed) return
    if (reloadRunning) {
      reloadQueued = true
      return
    }

    // Only restart when the emitted bundle actually differs. A digest of
    // `null` (directory unreadable) falls through to a reload rather than
    // silently pinning a stale backend.
    const nextDigest = digestAll()
    if (nextDigest !== null && lastDigest !== null && nextDigest === lastDigest) {
      onSkip()
      return
    }
    lastDigest = nextDigest

    reloadRunning = true
    try {
      await onReload()
    } catch (err) {
      onError(err)
    } finally {
      reloadRunning = false
      if (reloadQueued && !closed) {
        reloadQueued = false
        timer = setTimeout(runReload, debounceMs)
      }
    }
  }

  const scheduleReload = (_eventType, filename) => {
    if (closed || !isBackendBuildFile(filename)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(runReload, debounceMs)
  }

  const watchers = directories.map((dir) => {
    const watcher = watch(dir, { recursive: true }, scheduleReload)
    watcher.on?.("error", onError)
    return watcher
  })

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      for (const watcher of watchers) watcher.close()
    },
  }
}

module.exports = {
  computeBuildDigest,
  createBackendDevReloader,
  isBackendBuildFile,
}
