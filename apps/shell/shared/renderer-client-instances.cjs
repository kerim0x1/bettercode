/**
 * Which page load ("renderer instance") of each app window owns the
 * terminals and shell runs it started.
 *
 * The desktop owner is one principal to the backend, so a window that
 * crashed or reloaded used to leave its PTYs (a dev server, say) running with
 * nothing attached, still counted against the owner's terminal limit. Now the
 * preload makes up a random id for every page load and reports it here; the
 * renderer sends that id with `/shell/run` and `/shell/pty/open`
 * (`X-BetterC0de-Client-Instance`), and the backend records it as the owning
 * instance. When the page is gone, its id is released and the backend ends
 * what that page started (`POST /shell/client/release`):
 *  - the renderer process crashed or was killed (`render-process-gone`);
 *  - the window closed (`destroyed`);
 *  - the page navigated or reloaded (a main-frame, cross-document
 *    `did-start-navigation`, or the next page reporting a new id).
 */

/** Same shape the backend accepts (`normalizeClientInstanceId`). */
const CLIENT_INSTANCE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

function isClientInstanceId(value) {
  return typeof value === "string" && CLIENT_INSTANCE_ID_RE.test(value)
}

/**
 * Electron passes `did-start-navigation` either a details event (newer
 * versions: `isMainFrame`, `isSameDocument`) or positional arguments
 * `(event, url, isInPlace, isMainFrame)`.
 */
function isPageReplacingNavigation(details, _url, isInPlace, isMainFrame) {
  const mainFrame =
    typeof details?.isMainFrame === "boolean" ? details.isMainFrame : isMainFrame === true
  const sameDocument =
    typeof details?.isSameDocument === "boolean" ? details.isSameDocument : isInPlace === true
  return mainFrame && !sameDocument
}

/**
 * `release(clientInstanceId, reason)` performs the backend call; it may be
 * async and may fail (logged, never thrown at the caller).
 */
function createRendererClientInstances({ release, logger = console } = {}) {
  if (typeof release !== "function") {
    throw new TypeError("createRendererClientInstances needs a release function")
  }
  /** webContents id -> the current page's client instance id */
  const current = new Map()
  const tracked = new Set()

  function releaseId(clientInstanceId, reason) {
    Promise.resolve()
      .then(() => release(clientInstanceId, reason))
      .catch((error) => {
        logger.warn(
          `[electron] Could not release renderer shell resources (${reason}):`,
          error?.message || error,
        )
      })
  }

  function releaseContents(contentsId, reason) {
    const clientInstanceId = current.get(contentsId)
    if (!clientInstanceId) return false
    current.delete(contentsId)
    releaseId(clientInstanceId, reason)
    return true
  }

  function track(contents) {
    const contentsId = contents.id
    if (tracked.has(contentsId)) return
    tracked.add(contentsId)
    contents.on("render-process-gone", () => {
      releaseContents(contentsId, "renderer process gone")
    })
    contents.on("did-start-navigation", (...args) => {
      if (isPageReplacingNavigation(...args)) {
        releaseContents(contentsId, "page navigated or reloaded")
      }
    })
    contents.once("destroyed", () => {
      tracked.delete(contentsId)
      releaseContents(contentsId, "window closed")
    })
  }

  /** The preload of `contents` reports the id of the page it just loaded. */
  function register(contents, clientInstanceId) {
    if (!isClientInstanceId(clientInstanceId)) {
      throw new TypeError("Invalid renderer client instance id.")
    }
    if (!contents || typeof contents.id !== "number") {
      throw new TypeError("Unknown renderer.")
    }
    track(contents)
    const previous = current.get(contents.id)
    if (previous === clientInstanceId) return
    current.set(contents.id, clientInstanceId)
    // A new page in the same window: whatever the previous one started is
    // orphaned, even if no navigation event was seen for it.
    if (previous) releaseId(previous, "page replaced")
  }

  return {
    register,
    track,
    /** The id registered for `contents`' current page, or null. */
    currentFor: (contents) => current.get(contents?.id) ?? null,
    releaseFor: (contents, reason = "released") =>
      releaseContents(contents?.id, reason),
  }
}

module.exports = {
  CLIENT_INSTANCE_ID_RE,
  createRendererClientInstances,
  isClientInstanceId,
  isPageReplacingNavigation,
}
