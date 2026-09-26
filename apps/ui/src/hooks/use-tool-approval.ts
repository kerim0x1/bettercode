import { useCallback } from "react"

/** Provider kinds that accept `/chat/approval` over HTTP. Keep in sync with
 *  the adapters in `apps/backend/src/provider/*` that implement
 *  `respondToApproval`. */
const HTTP_APPROVAL_KINDS = new Set([
  "codex",
  "claude",
  "cursor",
  "codex_cli",
  "grok_cli",
  "grok-cli",
  "opencode_cli",
  "opencode-cli",
  "anthropic",
  "anthropic_cli",
  "betterc0de",
  "BetterC0de",
  "openai",
  "grok",
  "openrouter",
  "lmstudio",
  "google",
])

export function isHttpApprovalProviderKind(
  providerKind: string | null | undefined
): boolean {
  return typeof providerKind === "string" && HTTP_APPROVAL_KINDS.has(providerKind)
}

/**
 * Legacy plugin fallback for tool-approval requests.
 *
 * All graphical approval decisions now flow through the inline transcript
 * row and the approval modal (`submitApprovalDecision` → `/chat/approval`);
 * the old `window.confirm` auto-decider is gone. This callback only remains
 * for the plugin IPC path (`context.pluginId`) and the legacy Claude
 * Electron channel, where the caller already made the decision.
 */
export function useToolApproval(_permissionLevel: string) {
  return useCallback(
    (
      requestId: string,
      approved: boolean,
      context?: {
        pluginId?: string
        providerKind?: string
        providerInstanceId?: string
        threadId?: string
      }
    ) => {
      if (context?.pluginId && window.electronAPI?.pluginSend) {
        ;window.electronAPI
          .pluginSend(context.pluginId, "respondToolApproval", {
            requestId,
            approved,
          })
          .catch(() => { console.warn("Failed to send tool approval to plugin:", context.pluginId) })
        return
      }

      // Hub/HTTP providers answer from the approval row/modal — never here.
      const providerKind =
        context?.providerKind === "codex_cli" ? "codex" : context?.providerKind
      if (providerKind && isHttpApprovalProviderKind(providerKind)) return

      // Anything else has no local bridge: the `claude:*` main-process
      // provider was removed (it took its permission level from the
      // renderer). `claudeRespondApproval` was only ever declared in the
      // ElectronAPI type — the preload never exposed it — so this branch
      // threw before it could answer anything. Approvals now belong to the
      // backend, which the row/modal path already posts to.
      console.warn(
        "No approval transport for this request; expected the backend approval route.",
        { requestId, providerKind }
      )
    },
    []
  )
}
