const INTERNAL_CHILD_ENV_DENYLIST = new Set([
  "BETTERC0DE_SETTINGS_KEY",
  "BASH_ENV",
  "ENV",
  "ELECTRON_RUN_AS_NODE",
  "LD_AUDIT",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
])

const SHELL_BASE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "COLORTERM",
] as const

const CHILD_BASE_ENV_KEYS = [
  ...SHELL_BASE_ENV_KEYS,
  "TZ",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const

const IMMUTABLE_SHELL_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SHELL",
])

const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSCODE|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:$|_)/i

export function isUnsafeChildEnvironmentKey(name: string): boolean {
  const normalized = name.trim().toUpperCase()
  return (
    INTERNAL_CHILD_ENV_DENYLIST.has(normalized) ||
    normalized.startsWith("DYLD_")
  )
}

export function isSensitiveChildEnvironmentKey(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name.trim())
}

/** Git and npm config variables can turn an allowlisted command into another program. */
function isCommandInjectionEnvironmentKey(normalized: string): boolean {
  return (
    normalized.startsWith("GIT_CONFIG") ||
    normalized === "GIT_EXEC_PATH" ||
    normalized === "GIT_SSH" ||
    normalized === "GIT_SSH_COMMAND" ||
    normalized === "GIT_SSH_VARIANT" ||
    normalized === "GIT_EXTERNAL_DIFF" ||
    normalized === "NPM_CONFIG" ||
    normalized.startsWith("NPM_CONFIG_")
  )
}

export function isSafeShellEnvironmentOverrideKey(name: string): boolean {
  const normalized = name.trim().toUpperCase()
  return (
    /^[A-Z_][A-Z0-9_]*$/.test(normalized) &&
    !IMMUTABLE_SHELL_ENV_KEYS.has(normalized) &&
    !isUnsafeChildEnvironmentKey(normalized) &&
    !isSensitiveChildEnvironmentKey(normalized) &&
    !isCommandInjectionEnvironmentKey(normalized)
  )
}

export function sanitizedChildEnvironment(
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of CHILD_BASE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined && !isUnsafeChildEnvironmentKey(key)) {
      env[key] = value
    }
  }
  // Credential-bearing values are accepted only when the caller explicitly
  // assigns them to this specific child (for example a Codex instance gets
  // OPENAI_API_KEY, but Claude and Git do not).
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && !isUnsafeChildEnvironmentKey(key)) {
      env[key] = value
    }
  }
  return env
}

/**
 * Shell and PTY commands execute repository-controlled input and therefore
 * must not inherit the backend/provider credential environment. Keep only the
 * small set required to locate the shell and provide a usable terminal.
 * Explicit command-scoped overrides are accepted only when they are neither
 * loader/path overrides nor credential-shaped names.
 */
export function sanitizedShellEnvironment(
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SHELL_BASE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && isSafeShellEnvironmentOverrideKey(key)) {
      env[key] = value
    }
  }
  return env
}
