/**
 * Records the HTTP requests a preview guest makes, so the canvas can show a
 * project's live API traffic next to its page. Listens on the preview
 * session's `webRequest` (Electron allows one listener per event per
 * session; nothing else listens on these partitions). The guest is not
 * modified: no fetch patching, no injected script, so a page cannot tell it
 * is being observed.
 *
 * Static assets are skipped at the source. A single page load pulls dozens of
 * images and chunks, and none of them is what "which endpoints does this app
 * call" asks about.
 *
 * `createPreviewRequestFeed` is the wiring main.cjs uses:
 *  - the `webRequest` listeners exist only while at least one window has
 *    subscribed (`preview:request-subscribe`), so an unobserved preview costs
 *    nothing;
 *  - each entry goes only to the window that hosts the guest, never to every
 *    window;
 *  - entries are buffered and sent as one array per flush (~250 ms), with a
 *    per-window cap, instead of one IPC message per request.
 */

const PREVIEW_REQUEST_STATIC_TYPES = new Set([
  "image",
  "font",
  "stylesheet",
  "script",
  "media",
  "cspReport",
])

/** How many in-flight starts to remember before the oldest is dropped. */
const MAX_PENDING_STARTS = 4096
/** How often buffered entries are sent to their window. */
const PREVIEW_REQUEST_FLUSH_MS = 250
/** Entries kept per window between flushes; the oldest are dropped first. */
const MAX_BUFFERED_PER_WINDOW = 500

/**
 * Turns a finished `webRequest` details object into the entry the renderer
 * keeps. Exported for tests; `installPreviewRequestCapture` is the wiring.
 */
function previewRequestEntry(details, startedAt, outcome) {
  const finishedAt = typeof details.timestamp === "number" ? details.timestamp : Date.now()
  const began = typeof startedAt === "number" ? startedAt : finishedAt
  return {
    id: String(details.id),
    webContentsId: typeof details.webContentsId === "number" ? details.webContentsId : -1,
    method: typeof details.method === "string" ? details.method : "GET",
    url: typeof details.url === "string" ? details.url : "",
    resourceType: typeof details.resourceType === "string" ? details.resourceType : "other",
    startedAt: began,
    durationMs: Math.max(0, Math.round(finishedAt - began)),
    statusCode: typeof outcome.statusCode === "number" ? outcome.statusCode : null,
    fromCache: Boolean(details.fromCache),
    error: typeof outcome.error === "string" && outcome.error ? outcome.error : null,
  }
}

/**
 * Install the session listeners and call `emit(entry, details)` for every
 * finished non-static request. Returns a function that removes the listeners
 * and forgets in-flight starts.
 */
function installPreviewRequestCapture(previewSession, emit) {
  const starts = new Map()
  const remember = (details) => {
    if (starts.size >= MAX_PENDING_STARTS) {
      const oldest = starts.keys().next().value
      if (oldest !== undefined) starts.delete(oldest)
    }
    starts.set(details.id, details.timestamp)
  }
  const finish = (details, outcome) => {
    if (PREVIEW_REQUEST_STATIC_TYPES.has(details.resourceType)) return
    const startedAt = starts.get(details.id)
    starts.delete(details.id)
    emit(previewRequestEntry(details, startedAt, outcome), details)
  }
  // onSendHeaders is the earliest non-blocking hook, so timing costs the
  // page nothing.
  previewSession.webRequest.onSendHeaders((details) => {
    if (!PREVIEW_REQUEST_STATIC_TYPES.has(details.resourceType)) remember(details)
  })
  previewSession.webRequest.onCompleted((details) => {
    finish(details, { statusCode: details.statusCode, error: null })
  })
  previewSession.webRequest.onErrorOccurred((details) => {
    finish(details, { statusCode: null, error: details.error || "request failed" })
  })
  return () => {
    starts.clear()
    previewSession.webRequest.onSendHeaders(null)
    previewSession.webRequest.onCompleted(null)
    previewSession.webRequest.onErrorOccurred(null)
  }
}

function isAlive(contents) {
  return !!contents && !(typeof contents.isDestroyed === "function" && contents.isDestroyed())
}

/**
 * @param {object} options
 * @param {(guestWebContentsId: number) => object|null} options.resolveOwner
 *   The window webContents that hosts the guest, or null.
 * @param {(contents: object, entries: object[]) => void} options.send
 */
function createPreviewRequestFeed({
  resolveOwner,
  send,
  flushIntervalMs = PREVIEW_REQUEST_FLUSH_MS,
  maxBufferedPerWindow = MAX_BUFFERED_PER_WINDOW,
  timers = { setTimeout, clearTimeout },
  logger = console,
}) {
  const sessions = new Map() // session -> uninstall function | null
  const subscribers = new Map() // owner webContents id -> webContents
  const buffers = new Map() // owner webContents id -> entries
  const watched = new Set() // owner ids with a "destroyed" listener
  let flushTimer = null

  function capturing() {
    return subscribers.size > 0
  }

  function startSession(previewSession) {
    if (sessions.get(previewSession)) return
    sessions.set(
      previewSession,
      installPreviewRequestCapture(previewSession, (entry, details) =>
        record(entry, details),
      ),
    )
  }

  function stopSession(previewSession) {
    const uninstall = sessions.get(previewSession)
    if (!uninstall) return
    sessions.set(previewSession, null)
    try {
      uninstall()
    } catch (error) {
      logger.warn("[preview-requests] could not remove listeners:", error?.message || error)
    }
  }

  function record(entry, details) {
    let owner = null
    try {
      owner = resolveOwner(details?.webContentsId)
    } catch {
      owner = null
    }
    if (!isAlive(owner) || !subscribers.has(owner.id)) return
    const buffer = buffers.get(owner.id) || []
    buffer.push(entry)
    if (buffer.length > maxBufferedPerWindow) {
      buffer.splice(0, buffer.length - maxBufferedPerWindow)
    }
    buffers.set(owner.id, buffer)
    scheduleFlush()
  }

  function scheduleFlush() {
    if (flushTimer !== null) return
    flushTimer = timers.setTimeout(flush, flushIntervalMs)
    flushTimer?.unref?.()
  }

  function flush() {
    flushTimer = null
    for (const [ownerId, entries] of buffers) {
      buffers.delete(ownerId)
      const contents = subscribers.get(ownerId)
      if (!isAlive(contents) || entries.length === 0) continue
      try {
        send(contents, entries)
      } catch (error) {
        logger.warn("[preview-requests] send failed:", error?.message || error)
      }
    }
  }

  function unsubscribe(ownerId) {
    if (!subscribers.delete(ownerId)) return
    buffers.delete(ownerId)
    if (capturing()) return
    for (const previewSession of sessions.keys()) stopSession(previewSession)
    if (flushTimer !== null) {
      timers.clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  return {
    /** Register a preview session; it is observed only while subscribed. */
    attachSession(previewSession) {
      if (!sessions.has(previewSession)) sessions.set(previewSession, null)
      if (capturing()) startSession(previewSession)
    },
    /** A window starts (true) or stops (false) receiving its guests' feed. */
    setSubscribed(contents, subscribed) {
      if (!isAlive(contents)) return
      const ownerId = contents.id
      if (!subscribed) {
        unsubscribe(ownerId)
        return
      }
      if (subscribers.has(ownerId)) return
      subscribers.set(ownerId, contents)
      if (!watched.has(ownerId)) {
        watched.add(ownerId)
        contents.once?.("destroyed", () => {
          watched.delete(ownerId)
          unsubscribe(ownerId)
        })
      }
      for (const previewSession of sessions.keys()) startSession(previewSession)
    },
    isCapturing: capturing,
    flush,
  }
}

module.exports = {
  MAX_BUFFERED_PER_WINDOW,
  PREVIEW_REQUEST_FLUSH_MS,
  PREVIEW_REQUEST_STATIC_TYPES,
  createPreviewRequestFeed,
  installPreviewRequestCapture,
  previewRequestEntry,
}
