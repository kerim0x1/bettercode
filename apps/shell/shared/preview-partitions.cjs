/**
 * Housekeeping for the preview partitions (`betterc0de-preview` and
 * `betterc0de-canvas-preview`). They are in-memory sessions on purpose
 * (nothing a previewed page stores reaches disk or the app's own session),
 * but that also means their HTTP cache, Cache Storage and service workers
 * live in the browser and network processes for the whole app run. A dev
 * server with large bundles and HMR chunks keeps filling them.
 *
 * Only these two partitions exist: the webview attach policy forces every
 * guest into one of them, so their number is capped by construction. When
 * the last guest of a partition is destroyed, and no new one appears within
 * a grace period (a reload or a remount re-creates the guest at once), the
 * partition's HTTP cache, Cache Storage, service workers and shader cache
 * are cleared. Cookies, localStorage and IndexedDB stay, so reopening a
 * preview during the same run keeps the user signed in to their app.
 */

const PREVIEW_PARTITION_IDLE_CLEAR_MS = 30_000
const CLEARED_STORAGES = ["cachestorage", "serviceworkers", "shadercache"]

/**
 * @param {object} options
 * @param {Map<string, object>} options.partitions partition name -> Session
 */
function createPreviewPartitionJanitor({
  partitions,
  idleMs = PREVIEW_PARTITION_IDLE_CLEAR_MS,
  timers = { setTimeout, clearTimeout },
  logger = console,
}) {
  const state = new Map()
  for (const name of partitions.keys()) state.set(name, { guests: new Set(), timer: null })

  function partitionOf(contents) {
    let guestSession
    try {
      guestSession = contents.session
    } catch {
      return null
    }
    for (const [name, previewSession] of partitions) {
      if (previewSession === guestSession) return name
    }
    return null
  }

  async function clear(name) {
    const previewSession = partitions.get(name)
    if (!previewSession) return
    try {
      await Promise.all([
        previewSession.clearCache(),
        previewSession.clearStorageData({ storages: CLEARED_STORAGES }),
      ])
    } catch (error) {
      logger.warn(`[preview] could not clear ${name}:`, error?.message || error)
    }
  }

  function scheduleClear(name) {
    const entry = state.get(name)
    if (!entry || entry.guests.size > 0 || entry.timer !== null) return
    entry.timer = timers.setTimeout(() => {
      entry.timer = null
      if (entry.guests.size === 0) void clear(name)
    }, idleMs)
    entry.timer?.unref?.()
  }

  return {
    /** Count a new guest webContents; returns its partition name or null. */
    trackGuest(contents) {
      const name = partitionOf(contents)
      if (!name) return null
      const entry = state.get(name)
      if (entry.timer !== null) {
        timers.clearTimeout(entry.timer)
        entry.timer = null
      }
      const id = contents.id
      entry.guests.add(id)
      contents.once("destroyed", () => {
        entry.guests.delete(id)
        scheduleClear(name)
      })
      return name
    },
    guestCount(name) {
      return state.get(name)?.guests.size ?? 0
    },
    clear,
  }
}

module.exports = {
  PREVIEW_PARTITION_IDLE_CLEAR_MS,
  createPreviewPartitionJanitor,
}
