/**
 * Shared filesystem + window conveniences used by every *-ipc.cjs module.
 *
 * Extracted from the monolithic `onboarding-ipc.cjs` so MCP, skills, hooks,
 * and subagents can each live in their own file without copy-pasting the
 * `.betterc0de` vs `.betterc0de-dev` detection and the runtime paths table.
 */

const { app, BrowserWindow } = require("electron")
const fs = require("fs")
const path = require("path")
const os = require("os")
const appConfig = require("./appConfig.cjs")

/**
 * The shell's only resolver for BetterC0de's folders. The rest of the main
 * process, and through the backend environment the backend, take their paths
 * from here instead of deriving them from the environment again:
 *
 * - `getBaseDir()`: the runtime home. Packaged builds use `~/.betterc0de`,
 *   dev builds `~/.betterc0de-dev` so test data doesn't collide with a
 *   user's real install; `BETTERC0DE_HOME` replaces it. It holds the desktop
 *   configuration the backend owns (`mcp-servers.json`, `hooks.json`,
 *   `rules.md`, `skills/`, `subagents/`) and reaches the backend as
 *   `BETTERC0DE_RUNTIME_HOME`.
 * - `resolveUserDataDir()`: the backend's data directory (SQLite,
 *   settings.json, the settings key): `<home>/userdata`, unless
 *   `BETTERC0DE_DATA_DIR` names another one. It reaches the backend as
 *   `BETTERC0DE_DATA_DIR`. A custom data directory never moves the runtime
 *   home; before both were passed explicitly, the backend guessed the home
 *   from the data directory's name and silently lost hooks, skills and rules
 *   for such a profile.
 */
function getBaseDir() {
  const override = (process.env.BETTERC0DE_HOME || "").trim()
  if (override) {
    if (!path.isAbsolute(override) || override.includes("\0")) {
      throw new Error("BETTERC0DE_HOME must be an absolute filesystem path")
    }
    return path.resolve(override)
  }
  const baseDirName = app.isPackaged ? ".betterc0de" : ".betterc0de-dev"
  return path.join(os.homedir(), baseDirName)
}

let resolvedUserDataDir = null

/**
 * The backend's data directory (SQLite + settings.json + settings-key.bin),
 * created on first use and canonicalized. It used to be
 * `app.getPath("userData")`, which on Windows is Roaming AppData: a
 * sync-sensitive location that is a poor fit for a multi-MB chat database.
 *
 * `BETTERC0DE_DATA_DIR` (an absolute path, used as it is) wins over
 * `<getBaseDir()>/userdata`. Cached for the process lifetime, so every caller
 * sees the directory the backend was started with.
 */
function resolveUserDataDir() {
  if (resolvedUserDataDir) return resolvedUserDataDir
  const explicitDataDir = String(process.env.BETTERC0DE_DATA_DIR || "").trim()
  if (
    explicitDataDir &&
    (!path.isAbsolute(explicitDataDir) || explicitDataDir.includes("\0"))
  ) {
    throw new Error("BETTERC0DE_DATA_DIR must be an absolute filesystem path")
  }
  const requested = path.resolve(
    explicitDataDir || path.join(getBaseDir(), "userdata"),
  )
  if (requested === path.parse(requested).root) {
    throw new Error("Refusing to use a filesystem root as BetterC0de data dir")
  }

  fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(requested)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`BetterC0de data dir is not a regular directory: ${requested}`)
  }
  resolvedUserDataDir = fs.realpathSync.native(requested)
  return resolvedUserDataDir
}

/** Marker file that flips after the user completes onboarding. */
function getDoneFlag() {
  return path.join(getBaseDir(), "onboarding-done")
}

/** Canonical paths table — every *-ipc.cjs reads its file/dir from here. */
function getRuntimePaths() {
  const baseDir = getBaseDir()
  return {
    baseDir,
    mcpFile: path.join(baseDir, "mcp-servers.json"),
    skillsDir: path.join(baseDir, "skills"),
    hooksFile: path.join(baseDir, "hooks.json"),
    rulesFile: path.join(baseDir, "rules.md"),
    subagentsDir: path.join(baseDir, "subagents"),
    pluginsFile: path.join(baseDir, "imported-plugins.json"),
  }
}

/** mkdir -p. Returns the directory so callers can chain. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Normalize free-form user input into a filesystem-safe id. Used by every
 * save handler (skill, subagent, mcp) so the on-disk id can't contain
 * separators, escapes, or arbitrarily long strings.
 */
function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, appConfig.SLUG_MAX_LENGTH)
}

/**
 * Pick a window to attach modal dialogs to. Prefers the currently focused
 * window; falls back to any available BrowserWindow. Returns null when
 * the app has no windows yet (shouldn't happen on IPC paths but handlers
 * defend anyway).
 */
function getFocusedWindow() {
  return (
    BrowserWindow.getFocusedWindow() ||
    BrowserWindow.getAllWindows()[0] ||
    null
  )
}

module.exports = {
  getBaseDir,
  resolveUserDataDir,
  getDoneFlag,
  getRuntimePaths,
  ensureDir,
  slugify,
  getFocusedWindow,
}
