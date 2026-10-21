/**
 * User-intent checks the main process makes from what it observes itself.
 *
 * `createUserInputTracker` records, per webContents, when the user last
 * pressed a key, clicked or touched it. The events come from Chromium's input
 * pipeline (`webContents` "input-event"), which page and renderer JavaScript
 * cannot synthesize, so unlike `navigator.userActivation` in a preload the
 * answer cannot be forged by script and does not depend on which world asks.
 *
 * `createPreviewGuestGate` decides whether a preview guest's preload may
 * forward a message that would put page content into the app's chat context
 * (`element-selected`): only shortly after real input to the guest or to the
 * window hosting it (picking in the page, or in the app's inspector tree), and
 * at most a few times per window of time. A page calling the bridge on its
 * own, or in a loop, gets nothing through.
 */

const PREVIEW_GUEST_GATE_CHANNEL = "preview-guest:gate"
/** Guest channels that need the gate; everything else is rate-limited in the preload. */
const PREVIEW_GATED_CHANNELS = new Set(["element-selected", "element-picked"])
const GESTURE_INPUT_TYPES = new Set([
  "mouseDown",
  "mouseUp",
  "rawKeyDown",
  "keyDown",
  "char",
  "touchStart",
  "touchEnd",
  "pointerDown",
  "pointerUp",
  "gestureTap",
])
const PREVIEW_SELECTION_INPUT_WINDOW_MS = 3_000
const PREVIEW_SELECTION_MAX_PER_WINDOW = 8
const PREVIEW_SELECTION_RATE_WINDOW_MS = 10_000

function contentsId(contents) {
  return contents && typeof contents.id === "number" ? contents.id : null
}

function createUserInputTracker({ now = Date.now } = {}) {
  const lastInputAt = new Map()
  const tracked = new Set()

  return {
    /** Start observing a webContents. Idempotent. */
    track(contents) {
      const id = contentsId(contents)
      if (id === null || tracked.has(id)) return
      tracked.add(id)
      contents.on("input-event", (_event, input) => {
        if (GESTURE_INPUT_TYPES.has(input?.type)) lastInputAt.set(id, now())
      })
      contents.once("destroyed", () => {
        tracked.delete(id)
        lastInputAt.delete(id)
      })
    },
    /** Record input directly (tests, and inputs observed elsewhere). */
    note(contents) {
      const id = contentsId(contents)
      if (id !== null) lastInputAt.set(id, now())
    },
    hasRecentInput(contents, windowMs) {
      const id = contentsId(contents)
      if (id === null) return false
      const at = lastInputAt.get(id)
      return typeof at === "number" && now() - at <= windowMs
    },
  }
}

function createPreviewGuestGate({
  inputTracker,
  now = Date.now,
  inputWindowMs = PREVIEW_SELECTION_INPUT_WINDOW_MS,
  maxPerWindow = PREVIEW_SELECTION_MAX_PER_WINDOW,
  rateWindowMs = PREVIEW_SELECTION_RATE_WINDOW_MS,
}) {
  const recent = new Map() // guest id -> timestamps of allowed messages

  return {
    /** True when `guest` may forward `channel` to its host right now. */
    allow(guest, channel) {
      if (!PREVIEW_GATED_CHANNELS.has(channel)) return false
      const id = contentsId(guest)
      if (id === null) return false
      let host = null
      try {
        host = guest.hostWebContents || null
      } catch {
        host = null
      }
      if (
        !inputTracker.hasRecentInput(guest, inputWindowMs) &&
        !inputTracker.hasRecentInput(host, inputWindowMs)
      ) {
        return false
      }
      const at = now()
      const allowed = (recent.get(id) || []).filter((time) => at - time < rateWindowMs)
      if (allowed.length >= maxPerWindow) {
        recent.set(id, allowed)
        return false
      }
      allowed.push(at)
      recent.set(id, allowed)
      return true
    },
    forget(guest) {
      const id = contentsId(guest)
      if (id !== null) recent.delete(id)
    },
  }
}

module.exports = {
  GESTURE_INPUT_TYPES,
  PREVIEW_GATED_CHANNELS,
  PREVIEW_GUEST_GATE_CHANNEL,
  createPreviewGuestGate,
  createUserInputTracker,
}
