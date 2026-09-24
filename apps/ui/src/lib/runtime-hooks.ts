import { useEffect } from "react"

import {
  blockingHookFailureMessage,
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
import { runShellCommandDetailed } from "@/services/backend"

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

  const error = hookFailureText(result)
  await updateRuntimeHookRun(hook.id, "error", result.exitCode ?? 1, error)

  if (blocking) {
    throw new Error(blockingHookFailureMessage(hook.command, error))
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
