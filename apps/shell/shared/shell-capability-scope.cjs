/**
 * The shell capability scopes a renderer may ask the main process to mint
 * (`shell:capability`), validated and rebuilt from known fields only before
 * they are forwarded to the backend (`POST /shell/capability`).
 *
 * Run and PTY scopes carry the `launch` they will be spent with: the shell,
 * the PTY argument vector and the command environment. The backend binds the
 * capability to it, so a token minted for one launch cannot start another
 * shell or environment. Limits mirror the backend's request schemas
 * (packages/schema shell.ts); anything else is refused here.
 */

const MAX_COMMAND_CHARS = 100_000
const MAX_PTY_COMMAND_CHARS = 32_768
const MAX_CWD_CHARS = 32_768
const MAX_SESSION_ID_CHARS = 256
const MAX_WRITE_CHARS = 1_000_000
const MAX_SHELL_CHARS = 1_024
const MAX_ARGS = 128
const MAX_ARG_CHARS = 4 * 1024
const MAX_ARGS_TOTAL_CHARS = 24 * 1024
const MAX_ENV_ENTRIES = 64
const MAX_ENV_VALUE_CHARS = 8 * 1024
const MAX_ENV_TOTAL_CHARS = 24 * 1024
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const LAUNCH_KEYS = new Set(["shell", "args", "env"])

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedString(value, max, { allowEmpty = false } = {}) {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.length > 0)
  )
}

/** A validated copy of `launch`, `{}` when absent, or null when malformed. */
function normalizeLaunch(launch) {
  if (launch === undefined) return {}
  if (!isPlainObject(launch)) return null
  if (Object.keys(launch).some((key) => !LAUNCH_KEYS.has(key))) return null
  const normalized = {}
  if (launch.shell !== undefined) {
    if (!boundedString(launch.shell, MAX_SHELL_CHARS, { allowEmpty: true })) return null
    normalized.shell = launch.shell
  }
  if (launch.args !== undefined) {
    if (!Array.isArray(launch.args) || launch.args.length > MAX_ARGS) return null
    let total = 0
    for (const arg of launch.args) {
      if (!boundedString(arg, MAX_ARG_CHARS, { allowEmpty: true })) return null
      total += arg.length + 1
    }
    if (total > MAX_ARGS_TOTAL_CHARS) return null
    normalized.args = [...launch.args]
  }
  if (launch.env !== undefined) {
    if (!isPlainObject(launch.env)) return null
    const entries = Object.entries(launch.env)
    if (entries.length > MAX_ENV_ENTRIES) return null
    let total = 0
    const env = {}
    for (const [key, value] of entries) {
      if (!ENV_KEY_RE.test(key)) return null
      if (!boundedString(value, MAX_ENV_VALUE_CHARS, { allowEmpty: true })) return null
      total += key.length + value.length + 2
      env[key] = value
    }
    if (total > MAX_ENV_TOTAL_CHARS) return null
    normalized.env = env
  }
  return normalized
}

/**
 * The scope to forward to the backend, rebuilt from the fields it may carry,
 * or null when `scope` is not a valid human shell capability request.
 */
function normalizeHumanShellCapabilityScope(scope) {
  if (!isPlainObject(scope)) return null
  if (scope.operation === "run") {
    if (
      !boundedString(scope.command, MAX_COMMAND_CHARS) ||
      !boundedString(scope.cwd, MAX_CWD_CHARS)
    ) {
      return null
    }
    const launch = normalizeLaunch(scope.launch)
    // A plain run has no PTY argument vector to bind.
    if (!launch || launch.args !== undefined) return null
    return { operation: "run", command: scope.command, cwd: scope.cwd, launch }
  }
  if (scope.operation === "pty-open") {
    if (
      !boundedString(scope.cwd, MAX_CWD_CHARS) ||
      (scope.sessionId !== undefined &&
        !boundedString(scope.sessionId, MAX_SESSION_ID_CHARS)) ||
      (scope.command !== undefined &&
        !boundedString(scope.command, MAX_PTY_COMMAND_CHARS, { allowEmpty: true }))
    ) {
      return null
    }
    const launch = normalizeLaunch(scope.launch)
    if (!launch) return null
    return {
      operation: "pty-open",
      cwd: scope.cwd,
      ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
      ...(scope.command !== undefined ? { command: scope.command } : {}),
      launch,
    }
  }
  if (scope.operation === "pty-write") {
    if (
      !boundedString(scope.sessionId, MAX_SESSION_ID_CHARS) ||
      !boundedString(scope.data, MAX_WRITE_CHARS, { allowEmpty: true })
    ) {
      return null
    }
    return { operation: "pty-write", sessionId: scope.sessionId, data: scope.data }
  }
  return null
}

module.exports = { normalizeHumanShellCapabilityScope }
