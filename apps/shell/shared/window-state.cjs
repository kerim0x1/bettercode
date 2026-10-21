/**
 * Persisted main-window bounds (`<data dir>/window-state.json`): size,
 * position and maximized state, restored on the next launch.
 *
 * The store holds no window; main.cjs (through shared/app-windows.cjs) feeds
 * it the window on resize/move/maximize and on close.
 */

const path = require("path")
const appConfig = require("./appConfig.cjs")

const WINDOW_STATE_FILENAME = "window-state.json"

/**
 * @param {object} options
 * @param {() => string} options.resolveDataDir The BetterC0de data directory.
 * @param {{ readJson: Function, writeJson: Function }} [options.jsonFs] shared/json-fs.cjs (injectable for tests).
 * @param {() => { getAllDisplays: () => Array<{ bounds: { x: number, y: number, width: number, height: number } }> }} [options.getScreen]
 *   Electron's `screen` module; only read after the app is ready.
 */
function createWindowStateStore({
  resolveDataDir,
  jsonFs = null,
  getScreen = () => require("electron").screen,
  defaults = {
    width: appConfig.DEFAULT_WINDOW_WIDTH,
    height: appConfig.DEFAULT_WINDOW_HEIGHT,
  },
  saveDebounceMs = appConfig.WINDOW_STATE_SAVE_DEBOUNCE_MS,
  log = console,
  timers = { setTimeout, clearTimeout },
}) {
  const json = () => jsonFs ?? require("./json-fs.cjs")
  let windowStateSaveTimer = null

  /**
   * Load persisted window bounds (size + position + maximized state) from
   * `~/.betterc0de[-dev]/userdata/window-state.json`. Returns sane defaults on
   * first launch, corrupt JSON, or bounds that no longer intersect any
   * connected display (e.g. user unplugged an external monitor).
   */
  function loadWindowState() {
    const { readJson } = json()
    const screen = getScreen()
    const fallback = {
      width: defaults.width,
      height: defaults.height,
      x: undefined,
      y: undefined,
      isMaximized: false,
    }
    try {
      const statePath = path.join(resolveDataDir(), WINDOW_STATE_FILENAME)
      const parsed = readJson(statePath, null, { maxBytes: 64 * 1024, strict: true })
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback
      const width = Number(parsed.width)
      const height = Number(parsed.height)
      if (!Number.isInteger(width) || !Number.isInteger(height)
        || width < 400 || height < 300 || width > 32_768 || height > 32_768) {
        return fallback
      }
      const x = Number(parsed.x)
      const y = Number(parsed.y)
      const hasPosition = parsed.x != null && parsed.y != null
        && Number.isInteger(x) && Number.isInteger(y)
        && Math.abs(x) <= 2_147_483_647 && Math.abs(y) <= 2_147_483_647

      // If saved bounds don't intersect any current display, the window would
      // be invisible off-screen. Drop position and let the OS center it.
      let positionOk = hasPosition
      if (hasPosition) {
        const displays = screen.getAllDisplays()
        positionOk = displays.some((d) => {
          const b = d.bounds
          return x < b.x + b.width && x + width > b.x && y < b.y + b.height && y + height > b.y
        })
      }
      return {
        width,
        height,
        x: positionOk ? x : undefined,
        y: positionOk ? y : undefined,
        isMaximized: parsed.isMaximized === true,
      }
    } catch (err) {
      log.warn("[electron] could not load window state, using defaults:", err?.message || err)
      return fallback
    }
  }

  /**
   * Snapshot a window's bounds + maximize state to a plain object. Called
   * synchronously on window events; the returned object is durable — the
   * window can safely be destroyed before `writeWindowState` runs.
   *
   * `getNormalBounds()` returns the unmaximized rect even when the window is
   * currently maximized — so next launch still has a sensible size/position
   * to restore to after the user un-maximizes.
   */
  function captureWindowState(win) {
    if (!win || win.isDestroyed()) return null
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
    return { ...bounds, isMaximized }
  }

  function writeWindowState(state) {
    if (!state) return
    try {
      const { writeJson } = json()
      const statePath = path.join(resolveDataDir(), WINDOW_STATE_FILENAME)
      writeJson(statePath, state, { maxBytes: 64 * 1024 })
    } catch (err) {
      log.warn("[electron] could not persist window state:", err?.message || err)
    }
  }

  function saveWindowStateDebounced(win) {
    const state = captureWindowState(win)
    if (!state) return
    if (windowStateSaveTimer) timers.clearTimeout(windowStateSaveTimer)
    windowStateSaveTimer = timers.setTimeout(() => {
      windowStateSaveTimer = null
      writeWindowState(state)
    }, saveDebounceMs)
  }

  /** Drop a debounced save that has not run yet (the close path writes at once). */
  function cancelPendingSave() {
    if (windowStateSaveTimer) {
      timers.clearTimeout(windowStateSaveTimer)
      windowStateSaveTimer = null
    }
  }

  return {
    loadWindowState,
    captureWindowState,
    writeWindowState,
    saveWindowStateDebounced,
    cancelPendingSave,
  }
}

module.exports = { WINDOW_STATE_FILENAME, createWindowStateStore }
