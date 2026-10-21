import { useEffect } from "react"

import {
  buildHookEnv,
  hookFailureText,
  resolveHookCwd,
  type RuntimeHookPayload as HookPayload,
} from "@betterc0de/schema/runtime-hooks"
import {
  listRuntimeHooks,
  updateRuntimeHookRun,
  type RuntimeHook,
} from "@/lib/runtime-config"
import { runShellCommandDetailed } from "@/services/backend/workspaceApi"

/*
 * The user's notification hooks (response complete, file change, commit),
 * run by the desktop after the fact. Blocking "on message send" hooks are
 * not run here: the backend runs them before every message, from every
 * client (apps/backend services/chat/turn-preparation.ts).
 */

async function executeHook(hook: RuntimeHook, payload: HookPayload) {
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

  await updateRuntimeHookRun(
    hook.id,
    "error",
    result.exitCode ?? 1,
    hookFailureText(result)
  )
  return result
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
      await executeHook(hook, payload)
    } catch {
      // A notification hook never stops anything; the next one still runs.
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
