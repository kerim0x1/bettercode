/**
 * The user's hooks: shell commands the desktop runs on chat events, stored
 * in `hooks.json` beside the desktop's other settings. "On message send"
 * hooks run before a message goes to the agent, and one that fails stops
 * the message. The desktop runs them for its own messages; its backend runs
 * them for messages from the phone app. Both give a hook the same
 * environment and report a failure in the same words.
 */

export type RuntimeHookEvent =
  | "on_message_send"
  | "on_response_complete"
  | "on_file_change"
  | "on_commit"

export type RuntimeHookPayload = Record<string, unknown>

/** A value as a hook sees it: text, at most `max` characters. */
export function truncateHookValue(value: unknown, max = 4000): string {
  if (value == null) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** Where a hook runs: the event's folder or project, else the current one. */
export function resolveHookCwd(payload: RuntimeHookPayload): string {
  const candidates = [payload.cwd, payload.projectPath, payload.project_path]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate
  }
  return "."
}

/** The environment a hook runs with: the event, its payload, and its parts. */
export function buildHookEnv(
  event: RuntimeHookEvent,
  payload: RuntimeHookPayload
): Record<string, string> {
  const env: Record<string, string> = {
    BETTERC0DE_HOOK_EVENT: event,
    BETTERC0DE_HOOK_PAYLOAD: truncateHookValue(payload, 8000),
  }

  const mappings: Record<string, unknown> = {
    BETTERC0DE_THREAD_ID: payload.threadId ?? payload.thread_id,
    BETTERC0DE_PROJECT_PATH: payload.projectPath ?? payload.project_path,
    BETTERC0DE_CWD: payload.cwd,
    BETTERC0DE_FILE_PATH:
      payload.path ?? payload.filePath ?? payload.relativePath,
    BETTERC0DE_RELATIVE_PATH: payload.relativePath,
    BETTERC0DE_MESSAGE: payload.message,
    BETTERC0DE_RESPONSE: payload.response,
    BETTERC0DE_COMMIT_MESSAGE: payload.commitMessage,
    BETTERC0DE_TOOL_NAME: payload.toolName,
    BETTERC0DE_MODEL_ID: payload.modelId,
    BETTERC0DE_PROVIDER: payload.providerKind,
  }

  for (const [key, raw] of Object.entries(mappings)) {
    if (raw == null) continue
    env[key] = truncateHookValue(raw)
  }

  return env
}

/** What a failed hook reports: its error output, or its exit code. */
export function hookFailureText(result: {
  stdout?: string
  stderr?: string
  exitCode?: number | null
}): string {
  return truncateHookValue(
    result.stderr ||
      result.stdout ||
      `Hook exited with code ${result.exitCode ?? 1}`
  )
}

/** Why a message did not go: the hook that stopped it, and its output. */
export function blockingHookFailureMessage(
  command: string,
  failure: string
): string {
  return `Hook "${command}" failed: ${failure}`
}
