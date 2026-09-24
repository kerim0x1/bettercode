import { useEffect } from "react"

import {
  listRuntimeHooks,
  updateRuntimeHookRun,
  type RuntimeHook,
} from "@/lib/runtime-config"
import { runShellCommandDetailed } from "@/services/backend"

type HookPayload = Record<string, unknown>

function truncate(value: unknown, max = 4000): string {
  if (value == null) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function resolveHookCwd(payload: HookPayload): string {
  const candidates = [payload.cwd, payload.projectPath, payload.project_path]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate
  }
  return "."
}

function buildHookEnv(event: RuntimeHook["event"], payload: HookPayload) {
  const env: Record<string, string> = {
    BETTERC0DE_HOOK_EVENT: event,
    BETTERC0DE_HOOK_PAYLOAD: truncate(payload, 8000),
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
    env[key] = truncate(raw)
  }

  return env
}

async function executeSingleHook(
  hook: RuntimeHook,
  payload: HookPayload,
  blocking: boolean
) {
  await updateRuntimeHookRun(hook.id, "running", null, null)

  // User-configured runtime hooks execute with bypass — the user explicitly
  // created the hook and its command. Without this flag the permission gate
  // in /shell/run would refuse to run the hook's shell command.
  const result = await runShellCommandDetailed(
    hook.command,
    resolveHookCwd(payload),
    undefined,
    buildHookEnv(hook.event, payload),
    { humanOrigin: true, permissionLevel: "bypass" }
  )

  if (result.success) {
    await updateRuntimeHookRun(hook.id, "success", result.exitCode ?? 0, null)
    return result
  }

  const error = truncate(
    result.stderr ||
      result.stdout ||
      `Hook exited with code ${result.exitCode ?? 1}`
  )
  await updateRuntimeHookRun(hook.id, "error", result.exitCode ?? 1, error)

  if (blocking) {
    throw new Error(`Hook "${hook.command}" failed: ${error}`)
  }

  return result
}

export async function runBlockingMessageSendHooks(payload: HookPayload) {
  const hooks = (await listRuntimeHooks()).filter(
    (hook) => hook.enabled && hook.event === "on_message_send"
  )

  for (const hook of hooks) {
    await executeSingleHook(hook, payload, true)
  }
}

export async function queueRuntimeHooks(
  event: RuntimeHook["event"],
  payload: HookPayload
) {
  const hooks = (await listRuntimeHooks()).filter(
    (hook) => hook.enabled && hook.event === event
  )

  for (const hook of hooks) {
    try {
      await executeSingleHook(hook, payload, false)
    } catch {
      // blocking=false never rethrows, this is defensive.
    }
  }
}

export function useRuntimeHookBridge() {
  useEffect(() => {
    const onResponse = (event: Event) => {
      const detail = (event as CustomEvent<HookPayload>).detail || {}
      void queueRuntimeHooks("on_response_complete", detail)
    }

    const onFileChange = (event: Event) => {
      const detail = (event as CustomEvent<HookPayload>).detail || {}
      void queueRuntimeHooks("on_file_change", detail)
    }

    const onCommit = (event: Event) => {
      const detail = (event as CustomEvent<HookPayload>).detail || {}
      void queueRuntimeHooks("on_commit", detail)
    }

    window.addEventListener(
      "betterc0de:response-complete",
      onResponse as EventListener
    )
    window.addEventListener(
      "betterc0de:file-changed",
      onFileChange as EventListener
    )
    window.addEventListener("betterc0de:git-commit", onCommit as EventListener)

    return () => {
      window.removeEventListener(
        "betterc0de:response-complete",
        onResponse as EventListener
      )
      window.removeEventListener(
        "betterc0de:file-changed",
        onFileChange as EventListener
      )
      window.removeEventListener(
        "betterc0de:git-commit",
        onCommit as EventListener
      )
    }
  }, [])
}
