import { useState } from "react"
import { ShieldCheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  useConfirm,
  type ConfirmOptions,
} from "@/components/dialogs/confirm-provider"
import { handleError } from "@/lib/errors"
import {
  useWorkspaceTrustPromptStore,
  WORKSPACE_TRUST_DESCRIPTION,
  type WorkspaceTrustPrompt,
} from "@/lib/workspace-trust-prompts"
import { setAgentWorkspaceTrust } from "@/services/backend/chatApi"

/**
 * Asks for the same confirmation as Settings → Permissions, trusts the
 * workspace and resends the refused message. Resolves to whether the
 * workspace was trusted.
 */
export async function trustWorkspaceAndRetry(
  prompt: WorkspaceTrustPrompt,
  {
    confirm,
    onRetry,
    onTrusting,
  }: {
    confirm: (options: ConfirmOptions) => Promise<boolean>
    onRetry: () => void
    /** Called once the user confirmed, before the request starts. */
    onTrusting?: () => void
  }
): Promise<boolean> {
  const ok = await confirm({
    title: "Trust this workspace?",
    description: `${prompt.workspacePath}\n\n${WORKSPACE_TRUST_DESCRIPTION}`,
    confirmLabel: "Trust and resend",
  })
  if (!ok) return false
  onTrusting?.()
  try {
    await setAgentWorkspaceTrust(prompt.workspacePath, "trusted")
  } catch (error) {
    handleError(error, { source: "workspace-trust" })
    return false
  }
  // Every refusal for this workspace loses its action, including this one.
  useWorkspaceTrustPromptStore.getState().resolveWorkspace(prompt.workspacePath)
  onRetry()
  return true
}

/**
 * Under an Agent turn the backend refused because its workspace is not
 * trusted: offers to trust that workspace and resend the message. Renders
 * nothing for other messages.
 */
export function WorkspaceTrustAction({
  messageId,
  onRetry,
}: {
  messageId: string
  /** Resends the user message that was refused. */
  onRetry: () => void
}) {
  const prompt = useWorkspaceTrustPromptStore(
    (state) => state.byMessageId[messageId]
  )
  if (!prompt) return null
  return <WorkspaceTrustButton prompt={prompt} onRetry={onRetry} />
}

function WorkspaceTrustButton({
  prompt,
  onRetry,
}: {
  prompt: WorkspaceTrustPrompt
  onRetry: () => void
}) {
  const confirm = useConfirm()
  const [pending, setPending] = useState(false)

  const onClick = async () => {
    const trusted = await trustWorkspaceAndRetry(prompt, {
      confirm,
      onRetry,
      onTrusting: () => setPending(true),
    })
    // On success the action unmounts with its prompt.
    if (!trusted) setPending(false)
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void onClick()}
      >
        <ShieldCheckIcon aria-hidden="true" className="size-3.5" />
        {pending ? "Trusting…" : "Trust this workspace"}
      </Button>
      <span className="text-xs text-muted-foreground">
        Allows Agent Mode in this folder and resends your message.
      </span>
    </div>
  )
}
