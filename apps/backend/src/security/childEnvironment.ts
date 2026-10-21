/**
 * Environment construction for every child process the backend starts.
 *
 * Three shapes, from widest to narrowest:
 *
 *  - {@link sanitizedChildEnvironment}: provider and agent CLIs (Codex, Claude
 *    Code, Cursor/Grok ACP agents, their probes and maintenance runs). These
 *    act for the user and pass their environment on to the commands they run,
 *    so they inherit the user's environment minus a denylist: credentials,
 *    loader-injection variables, BetterC0de's own internal variables and
 *    launcher artefacts. A provider's own credential is added back only
 *    through an explicit override for that child.
 *  - {@link restrictedChildEnvironment}: helpers the backend runs on its own
 *    behalf (git, taskkill, process queries, sandboxed image generation).
 *    An allowlist, so a stray `GIT_DIR` or `NODE_ENV` in the backend's
 *    environment cannot change what they do.
 *  - {@link sanitizedShellEnvironment}: shells and PTYs that execute
 *    repository-controlled input. The smallest allowlist: what the shell,
 *    SSH and the platform's own tools need, nothing credential-shaped.
 */

/** Loader and startup variables that make any child run code it was not asked to. */
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

/**
 * Non-secret variables a shell, SSH and the platform's own tools need to
 * behave as they do in the user's terminal: the SSH agent socket, locale and
 * terminal settings, the X11/Wayland/D-Bus session (keyrings, xdg-open), and
 * the Windows system variables Makefiles, node-gyp and pip inspect.
 */
const SHELL_BASE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "OS",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "LOGNAME",
  "USERNAME",
  "USERDOMAIN",
  "USERPROFILE",
  "COMPUTERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PSMODULEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_MONETARY",
  "TZ",
  "SHELL",
  "TERM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "__CF_USER_TEXT_ENCODING",
  // Network settings the user's own terminal has; integrated terminals
  // already received them before this list was widened.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const

const RESTRICTED_CHILD_ENV_KEYS = [
  ...SHELL_BASE_ENV_KEYS,
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
] as const

/** Values a command-scoped override may never replace (shell, PTY, formatter). */
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
  "NODEFAULTCURRENTDIRECTORYINEXEPATH",
])

/**
 * Names an override from a request may not set even though the user's own
 * environment may carry them: each one makes a shell or a tool start another
 * program (`EDITOR`, `PAGER`, askpass helpers, Java agents), or runs code
 * while a shell starts up or traces (`ZDOTDIR` is sourced by every `zsh -c`;
 * `SHELLOPTS=xtrace` with a `PS4` command substitution runs it in `bash -c`).
 * This is the single override denylist for shell runs, PTYs and formatters.
 */
const OVERRIDE_DENYLIST = new Set([
  "CDPATH",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "GIT_EDITOR",
  "GIT_PAGER",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "ZDOTDIR",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "BASH_XTRACEFD",
  "IFS",
])

/**
 * Variables that identify the process BetterC0de was launched from rather
 * than the user's environment: a parent Claude Code or Codex session (whose
 * markers make a nested CLI refuse to start or think it is sandboxed), and
 * the build tooling's mode switch.
 */
const LAUNCHER_ENV_DENYLIST = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "NODE_ENV",
  "INIT_CWD",
])

/** AWS settings that select a profile or region but carry no secret. */
const NON_SECRET_AWS_ENV_KEYS = new Set([
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_SDK_LOAD_CONFIG",
])

const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSCODE|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:$|_)/i

/** Credential words that mark a name sensitive wherever they appear. */
const SENSITIVE_ENV_FRAGMENT =
  /PASSWORD|PASSWD|SECRET|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|TOKEN$/i

/**
 * Credential-shaped names whose value is a socket or file location, not the
 * secret itself. The CLIs that use them could read those files anyway.
 */
const NON_SECRET_SENSITIVE_LOOKALIKES = new Set([
  "SSH_AUTH_SOCK",
  "GOOGLE_APPLICATION_CREDENTIALS",
])

export function isUnsafeChildEnvironmentKey(name: string): boolean {
  const normalized = name.trim().toUpperCase()
  return (
    INTERNAL_CHILD_ENV_DENYLIST.has(normalized) ||
    normalized.startsWith("DYLD_")
  )
}

export function isSensitiveChildEnvironmentKey(name: string): boolean {
  const trimmed = name.trim()
  if (NON_SECRET_SENSITIVE_LOOKALIKES.has(trimmed.toUpperCase())) return false
  return SENSITIVE_ENV_NAME.test(trimmed)
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

/**
 * Whether a request-supplied override may set `name` for a shell, PTY or
 * formatter child. Used by every such path so they cannot drift apart.
 */
export function isSafeShellEnvironmentOverrideKey(name: string): boolean {
  const normalized = name.trim().toUpperCase()
  return (
    /^[A-Z_][A-Z0-9_]*$/.test(normalized) &&
    !IMMUTABLE_SHELL_ENV_KEYS.has(normalized) &&
    !OVERRIDE_DENYLIST.has(normalized) &&
    !isUnsafeChildEnvironmentKey(normalized) &&
    !isSensitiveChildEnvironmentKey(normalized) &&
    !isCommandInjectionEnvironmentKey(normalized)
  )
}

/**
 * Whether an inherited variable must be withheld from provider and agent
 * CLIs: credentials (each child gets only its own, as an explicit override),
 * loader injection, BetterC0de's internal variables and launcher artefacts.
 */
export function isWithheldAgentEnvironmentKey(name: string): boolean {
  const trimmed = name.trim()
  const normalized = trimmed.toUpperCase()
  if (!trimmed || isUnsafeChildEnvironmentKey(normalized)) return true
  if (normalized.startsWith("BETTERC0DE_")) return true
  if (normalized.startsWith("ELECTRON_")) return true
  if (LAUNCHER_ENV_DENYLIST.has(normalized)) return true
  // `npm run` exports its whole configuration as lowercase `npm_*` variables;
  // they describe how BetterC0de was started, not the user's npm setup (which
  // uses the uppercase `NPM_CONFIG_*` names and is kept).
  if (trimmed.startsWith("npm_")) return true
  if (normalized.startsWith("AWS_"))
    return !NON_SECRET_AWS_ENV_KEYS.has(normalized)
  if (NON_SECRET_SENSITIVE_LOOKALIKES.has(normalized)) return false
  return (
    isSensitiveChildEnvironmentKey(trimmed) ||
    SENSITIVE_ENV_FRAGMENT.test(trimmed)
  )
}

/**
 * Environment for provider and agent CLIs and their probes. Starts from the
 * user's environment, withholds everything {@link isWithheldAgentEnvironmentKey}
 * names, then applies `overrides` (which may carry this child's own
 * credential; only loader-injection names are refused there).
 */
export function sanitizedChildEnvironment(
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isWithheldAgentEnvironmentKey(key)) continue
    assignEnvironmentValue(env, key, value)
  }
  applyWindowsExecutableSearchHardening(env)
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && !isUnsafeChildEnvironmentKey(key)) {
      assignEnvironmentValue(env, key, value)
    }
  }
  return env
}

/**
 * Allowlisted environment for helpers the backend runs on its own behalf
 * (git, taskkill, CIM queries, the sandboxed image-generation agent).
 * Credential-bearing values are accepted only when the caller explicitly
 * assigns them to this specific child.
 */
export function restrictedChildEnvironment(
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of RESTRICTED_CHILD_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined && !isUnsafeChildEnvironmentKey(key)) {
      env[key] = value
    }
  }
  applyWindowsExecutableSearchHardening(env)
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && !isUnsafeChildEnvironmentKey(key)) {
      assignEnvironmentValue(env, key, value)
    }
  }
  return env
}

/**
 * Shell and PTY commands execute repository-controlled input and therefore
 * must not inherit the backend/provider credential environment. Keep only the
 * set required to locate the shell and provide a usable terminal (see
 * {@link SHELL_BASE_ENV_KEYS}). Explicit command-scoped overrides are accepted
 * only when {@link isSafeShellEnvironmentOverrideKey} allows them.
 *
 * `NoDefaultCurrentDirectoryInExePath` is deliberately not forced here: in
 * the user's own shell, `gradlew build` resolving `.\gradlew.bat` from the
 * current directory is expected behaviour.
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
      assignEnvironmentValue(env, key, value)
    }
  }
  return env
}

/**
 * On Windows, make cmd.exe and any `CreateProcess`-style lookup in the child
 * skip the current directory when resolving a bare program name. Provider
 * CLIs are started through `cmd.exe /c` with the workspace as cwd; without
 * this a `codex.cmd` committed to a repository would shadow the real one.
 */
function applyWindowsExecutableSearchHardening(env: NodeJS.ProcessEnv): void {
  if (process.platform !== "win32") return
  assignEnvironmentValue(env, "NoDefaultCurrentDirectoryInExePath", "1")
}

/**
 * Windows treats variable names case-insensitively, but a plain object does
 * not: `{ Path, PATH }` would hand the child two PATHs. Replace any existing
 * spelling, and keep PATH itself under its canonical upper-case name.
 */
function assignEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string
): void {
  if (process.platform !== "win32") {
    env[key] = value
    return
  }
  const upper = key.toUpperCase()
  for (const existing of Object.keys(env)) {
    if (existing !== key && existing.toUpperCase() === upper) {
      delete env[existing]
    }
  }
  env[upper === "PATH" ? "PATH" : key] = value
}
