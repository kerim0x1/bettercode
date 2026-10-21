/**
 * Environment for the backend sidecar.
 *
 * The backend legitimately needs most of the user's environment: provider
 * credentials such as ANTHROPIC_API_KEY, proxy and CA settings, version
 * manager variables, and arbitrary names referenced from project configs as
 * `{env:NAME}`. A pure allowlist would silently break those. What it must not
 * receive is anything that changes how the sidecar runtime itself loads code
 * or that only exists for the Electron or npm parent:
 *
 * - Node and dynamic-loader injection (`NODE_OPTIONS --require`, `NODE_PATH`,
 *   `LD_PRELOAD`, `DYLD_*`), and shell startup hooks (`BASH_ENV`, `ENV`)
 *   that would run in every shell the backend starts.
 * - Electron runtime switches (`ELECTRON_*`). `ELECTRON_RUN_AS_NODE` is set
 *   explicitly instead: the packaged sidecar is the app binary running as
 *   Node, so the RunAsNode fuse must stay enabled until the backend moves to
 *   `utilityProcess`.
 * - `BETTERC0DE_SETTINGS_KEY`: the settings master key travels over the
 *   private IPC channel, never through the environment.
 * - npm lifecycle metadata from development launches.
 *
 * Explicit overrides are applied last: the data directory
 * (`BETTERC0DE_DATA_DIR`) and the runtime home that holds the desktop
 * configuration (`BETTERC0DE_RUNTIME_HOME`), both resolved once by
 * shared/runtime-paths.cjs so the backend never derives one from the other;
 * binary paths; and the login-shell PATH on macOS.
 */

const STRIPPED_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_INSPECT_RESUME_ON_START",
  "LD_PRELOAD",
  "LD_AUDIT",
  "BASH_ENV",
  "ENV",
  "BETTERC0DE_SETTINGS_KEY",
])

const STRIPPED_PREFIXES = ["DYLD_", "ELECTRON_", "NPM_LIFECYCLE_", "NPM_PACKAGE_"]

function isStrippedBackendEnvironmentKey(name) {
  const normalized = String(name).toUpperCase()
  return (
    STRIPPED_KEYS.has(normalized) ||
    STRIPPED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  )
}

/**
 * @param {Record<string, string | undefined>} parentEnv
 * @param {{ overrides?: Record<string, string | undefined | null>, runAsNode?: boolean, platform?: string }} [options]
 */
function buildBackendEnvironment(
  parentEnv,
  { overrides = {}, runAsNode = true, platform = process.platform } = {},
) {
  const env = {}
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (typeof value !== "string") continue
    if (isStrippedBackendEnvironmentKey(key)) continue
    env[key] = value
  }
  const assign = (key, value) => {
    // Windows environment names are case-insensitive; never pass both `Path`
    // and `PATH` to the child, or which one wins is undefined.
    if (platform === "win32") {
      const upper = key.toUpperCase()
      for (const existing of Object.keys(env)) {
        if (existing !== key && existing.toUpperCase() === upper) delete env[existing]
      }
    }
    if (value === undefined || value === null || value === "") delete env[key]
    else env[key] = String(value)
  }
  for (const [key, value] of Object.entries(overrides)) assign(key, value)
  if (runAsNode) assign("ELECTRON_RUN_AS_NODE", "1")
  return env
}

module.exports = { buildBackendEnvironment, isStrippedBackendEnvironmentKey }
